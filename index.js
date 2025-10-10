// ===== WhatsApp QR Connector - Atendimento (multi-tenant) =====
// Endpoints: QR/stream/status + chats/mensagens + pin/unpin + archive/unarchive + fotos + mídia + typing

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
    archived: !!chat.isArchived,
    pinned: !!chat.pinned,
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

// ===== ROTAS BASE =====

// Iniciar/garantir sessão
app.post("/sessions/:tenant/start", (req, res) => {
  const { tenant } = req.params;
  const s = getOrCreateSession(tenant);
  return res.json({ ok: true, tenant, status: s.status });
});

// Stream (SSE) para QR + status + mensagens + acks
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

// Status da sessão
app.get("/sessions/:tenant/status", (req, res) => {
  const { tenant } = req.params;
  const s = sessions.get(tenant);
  if (!s) return res.status(404).json({ ok: false, error: "Sessão não encontrada" });
  return res.json({ ok: true, tenant, status: s.status });
});

// Parar sessão
app.post("/sessions/:tenant/stop", async (req, res) => {
  const { tenant } = req.params;
  const s = sessions.get(tenant);
  if (s) {
    try { await s.client.destroy(); } catch {}
    sessions.delete(tenant);
  }
  return res.json({ ok: true, tenant });
});

// Listar sessões ativas em memória
app.get("/sessions", (_req, res) => {
  const list = [...sessions.entries()].map(([tenant, s]) => ({
    tenant,
    status: s.status,
  }));
  res.json(list);
});

// ===== ATENDIMENTO =====

// 1) Listar chats com filtros
// GET /sessions/:tenant/chats?q=termo&limit=30&offset=0&isGroup=true|false&archived=true|false&unreadOnly=true
app.get("/sessions/:tenant/chats", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    const q = (req.query.q || "").toString().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const isGroupParam = req.query.isGroup?.toString();
    const archivedParam = req.query.archived?.toString();
    const unreadOnly = req.query.unreadOnly?.toString() === "true";

    const { client } = requireOnline(tenant);
    const chats = await client.getChats();

    let items = chats.map(toChatDTO);

    // filtros
    if (isGroupParam === "true") items = items.filter(c => c.isGroup);
    if (isGroupParam === "false") items = items.filter(c => !c.isGroup);

    if (archivedParam === "true") items = items.filter(c => c.archived);
    if (archivedParam === "false") items = items.filter(c => !c.archived);

    if (unreadOnly) items = items.filter(c => (c.unreadCount ?? 0) > 0);

    if (q) {
      items = items.filter(
        (c) =>
          (c.name ?? "").toLowerCase().includes(q) ||
          (c.id ?? "").toLowerCase().includes(q) ||
          (c.lastMessage?.body ?? "").toLowerCase().includes(q)
      );
    }

    // ordenar: pinned primeiro, depois por timestamp desc
    items.sort((a, b) => {
      const p = Number(!!b.pinned) - Number(!!a.pinned);
      if (p !== 0) return p;
      return (b.timestamp ?? 0) - (a.timestamp ?? 0);
    });

    const slice = items.slice(offset, offset + limit);
    res.json({ total: items.length, offset, limit, items: slice });
  } catch (err) {
    next(err);
  }
});

// 2) Foto do chat/contato em dataURL
// GET /sessions/:tenant/chats/:chatId/photo
app.get("/sessions/:tenant/chats/:chatId/photo", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const url = await client.getProfilePicUrl(chatId);
    if (!url) return res.json({ ok: true, dataUrl: null });

    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ ok: false, error: "Falha ao baixar avatar" });
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get("content-type") || "image/jpeg";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    res.json({ ok: true, dataUrl });
  } catch (err) {
    next(err);
  }
});

// 3) Listar mensagens de um chat (mais recentes)
// GET /sessions/:tenant/chats/:chatId/messages?limit=50
app.get("/sessions/:tenant/chats/:chatId/messages", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));

    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });

    res.json(messages.map(toMessageDTO));
  } catch (err) {
    next(err);
  }
});

// 4) Baixar mídia de uma mensagem (dataURL)
// GET /sessions/:tenant/messages/:messageId/media
app.get("/sessions/:tenant/messages/:messageId/media", async (req, res, next) => {
  try {
    const { tenant, messageId } = req.params;
    const { client } = requireOnline(tenant);
    const msg = await client.getMessageById(messageId);
    if (!msg) return res.status(404).json({ ok: false, error: "Mensagem não encontrada" });
    if (!msg.hasMedia) return res.status(400).json({ ok: false, error: "Mensagem não possui mídia" });

    const media = await msg.downloadMedia();
    if (!media) return res.status(502).json({ ok: false, error: "Falha ao baixar mídia" });

    const dataUrl = `data:${media.mimetype};base64,${media.data}`;
    res.json({ ok: true, mimetype: media.mimetype, filename: media.filename ?? null, dataUrl });
  } catch (err) {
    next(err);
  }
});

// 5) Enviar texto
// POST /sessions/:tenant/messages  { to: "5511999999999"|"...@c.us", body: "Olá", quotedMsgId? }
app.post("/sessions/:tenant/messages", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    let { to, body, quotedMsgId } = req.body || {};
    if (!to || !body) return res.status(400).json({ ok: false, error: "to e body são obrigatórios" });
    if (!to.includes("@")) to = `${to}@c.us`;

    const { client } = requireOnline(tenant);
    const options = quotedMsgId ? { quotedMessageId: quotedMsgId } : {};
    const msg = await client.sendMessage(to, body, options);
    res.json({ ok: true, messageId: msg.id?._serialized ?? msg.id });
  } catch (err) {
    next(err);
  }
});

// 6) Enviar mídia por URL ou base64
// POST /sessions/:tenant/messages/media
// body: { to, mediaUrl?, base64?, caption?, filename?, mimetype? }
app.post("/sessions/:tenant/messages/media", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    let { to, mediaUrl, base64, caption, filename, mimetype } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "to é obrigatório" });
    if (!mediaUrl && !base64) return res.status(400).json({ ok: false, error: "informe mediaUrl ou base64" });
    if (!to.includes("@")) to = `${to}@c.us`;

    let media;
    if (mediaUrl) {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) throw new Error(`Falha ao baixar mídia: HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const b64 = buf.toString("base64");
      const ct = mimetype || resp.headers.get("content-type") || "application/octet-stream";
      const name = filename || mediaUrl.split("/").pop()?.split("?")[0] || "file";
      media = new MessageMedia(ct, b64, name);
    } else {
      if (!mimetype || !filename) return res.status(400).json({ ok: false, error: "informe mimetype e filename junto ao base64" });
      media = new MessageMedia(mimetype, base64, filename);
    }

    const { client } = requireOnline(tenant);
    const msg = await client.sendMessage(to, media, { caption });
    res.json({ ok: true, messageId: msg.id?._serialized ?? msg.id });
  } catch (err) {
    next(err);
  }
});

// 7) Marcar como lido
// POST /sessions/:tenant/chats/:chatId/read
app.post("/sessions/:tenant/chats/:chatId/read", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.sendSeen();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 8) PIN / UNPIN
// POST /sessions/:tenant/chats/:chatId/pin  |  /unpin
app.post("/sessions/:tenant/chats/:chatId/pin", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.pin();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
app.post("/sessions/:tenant/chats/:chatId/unpin", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.unpin();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 9) ARCHIVE / UNARCHIVE
// POST /sessions/:tenant/chats/:chatId/archive  |  /unarchive
app.post("/sessions/:tenant/chats/:chatId/archive", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.archive();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
app.post("/sessions/:tenant/chats/:chatId/unarchive", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.unarchive();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 10) TYPING (opcional para UX)
// POST /sessions/:tenant/chats/:chatId/typing  |  /stopTyping
app.post("/sessions/:tenant/chats/:chatId/typing", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
app.post("/sessions/:tenant/chats/:chatId/stopTyping", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    await chat.clearState();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ===== HOME & ERROS =====
app.get("/", (_req, res) => res.send("WA QR Connector up ✅"));

app.use((err, _req, res, _next) => {
  const code = err.status || 500;
  res.status(code).json({ ok: false, error: err.message || "Erro interno" });
});

app.listen(PORT, () => console.log("Listening on", PORT));
