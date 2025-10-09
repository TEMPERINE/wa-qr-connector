// ===== WhatsApp QR Connector - Atendimento (multi-tenant) =====
// Funciona com whatsapp-web.js + Express e expõe endpoints para:
// - Conexão via QR (já existia)
// - Listar chats
// - Listar mensagens de um chat
// - Enviar texto e mídia
// - Marcar chat como lido
// - Stream SSE com mensagens novas / acks / status

import express from "express";
import cors from "cors";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" })); // para receber JSON/base64 de mídia

const PORT = process.env.PORT || 3000;

// Memória simples em runtime
// tenant -> { client, status, listeners:Set<res>, qr }
const sessions = new Map();

function broadcast(tenant, payload) {
  const s = sessions.get(tenant);
  if (!s) return;
  for (const res of s.listeners) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toChatDTO(chat) {
  const last = chat.lastMessage || null;
  return {
    id: chat.id?._serialized ?? chat.id,
    name: chat.name || chat.formattedTitle || chat.contact?.name || chat.id?.user || "Contato",
    isGroup: !!chat.isGroup,
    unreadCount: chat.unreadCount ?? 0,
    timestamp: last?.timestamp ?? null,
    lastMessage: last
      ? {
          id: last.id?._serialized ?? last.id,
          body: last.body,
          fromMe: !!last.fromMe,
          timestamp: last.timestamp ?? null,
          ack: last.ack ?? null,
          type: last.type,
        }
      : null,
  };
}

function toMessageDTO(msg) {
  return {
    id: msg.id?._serialized ?? msg.id,
    chatId: msg.fromMe ? msg.to : msg.from,
    from: msg.from,
    to: msg.to,
    fromMe: !!msg.fromMe,
    body: msg.body,
    type: msg.type, // chat, image, audio, ptt, document, etc.
    hasMedia: !!msg.hasMedia,
    mimetype: msg.mimetype ?? null,
    filename: msg.filename ?? null,
    size: msg.size ?? null,
    ack: msg.ack ?? null, // 0 pendente, 1 enviada, 2 entregue, 3 lida, 4 reproduzida (áudio)
    timestamp: msg.timestamp ?? null,
    quotedMsgId: msg.hasQuotedMsg ? msg._data?.quotedMsgId ?? null : null,
    author: msg.author ?? null, // útil para grupos
  };
}

function getOrCreateSession(tenant) {
  let s = sessions.get(tenant);
  if (s) return s;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: tenant }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  s = { client, status: "OFFLINE", listeners: new Set(), qr: null };
  sessions.set(tenant, s);

  const setStatus = (st) => {
    s.status = st;
    broadcast(tenant, { type: "status", status: st });
  };

  // --- Eventos de conexão / QR ---
  client.on("qr", (qr) => {
    s.qr = qr;
    setStatus("RECONNECTING");
    broadcast(tenant, { type: "qr", qr });
  });

  client.on("ready", () => {
    setStatus("ONLINE");
    broadcast(tenant, { type: "ready", ok: true });
  });

  client.on("change_state", (state) => broadcast(tenant, { type: "state", state }));

  client.on("disconnected", async () => {
    setStatus("RECONNECTING");
    try {
      await client.initialize();
    } catch {
      setStatus("OFFLINE");
    }
  });

  client.on("auth_failure", () => setStatus("OFFLINE"));

  // --- Eventos de atendimento (tempo real) ---
  client.on("message", (msg) => {
    broadcast(tenant, { type: "message", message: toMessageDTO(msg) });
  });

  client.on("message_ack", (msg, ack) => {
    const id = msg?.id?._serialized ?? msg?.id;
    broadcast(tenant, { type: "ack", messageId: id, ack });
  });

  client.initialize().catch(() => setStatus("OFFLINE"));

  return s;
}

function requireOnline(tenant) {
  const s = getOrCreateSession(tenant);
  if (!s || s.status !== "ONLINE") {
    const err = new Error("Sessão não está ONLINE para este tenant");
    err.status = 400;
    throw err;
  }
  return s;
}

// ===== ROTAS JÁ EXISTENTES (conexão) =====
app.post("/sessions/:tenant/start", (req, res) => {
  const { tenant } = req.params;
  const s = getOrCreateSession(tenant);
  return res.json({ ok: true, tenant, status: s.status });
});

app.get("/sessions/:tenant/stream", (req, res) => {
  const { tenant } = req.params;
  const s = getOrCreateSession(tenant);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  s.listeners.add(res);
  // Estado inicial
  res.write(`data: ${JSON.stringify({ type: "status", status: s.status })}\n\n`);
  if (s.qr) res.write(`data: ${JSON.stringify({ type: "qr", qr: s.qr })}\n\n`);

  req.on("close", () => s.listeners.delete(res));
});

app.post("/sessions/:tenant/stop", async (req, res) => {
  const { tenant } = req.params;
  const s = sessions.get(tenant);
  if (s) {
    try {
      await s.client.destroy();
    } catch {}
    sessions.delete(tenant);
  }
  return res.json({ ok: true, tenant });
});

app.get("/sessions", (_req, res) => {
  const list = [...sessions.entries()].map(([tenant, s]) => ({
    tenant,
    status: s.status,
  }));
  res.json(list);
});

// ===== NOVAS ROTAS — ATENDIMENTO =====

// 2.1 Listar chats
// GET /sessions/:tenant/chats?q=termo&limit=30&offset=0
app.get("/sessions/:tenant/chats", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    const q = (req.query.q || "").toString().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const { client } = requireOnline(tenant);
    const chats = await client.getChats();

    let items = chats
      .filter((c) => !c.isArchived)
      .map(toChatDTO)
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    if (q) {
      items = items.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.id?.toLowerCase().includes(q
