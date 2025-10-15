// index.js (hotfix nomes de grupos)
// ===== WhatsApp QR Connector - Multi-tenant =====

import express from "express";
import cors from "cors";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;

// tenant -> { client, status, listeners:Set<res>, qr }
const sessions = new Map();

/* --------------------------- utils --------------------------- */

const shortName = (s) => {
  if (!s) return "";
  const parts = s.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]}`;
};

function normalizeType(msg) {
  try {
    const t = msg?.type || "";
    const mt = msg?.mimetype || "";
    const has = !!msg?.hasMedia;

    if (t === "image") return "image";
    if (has && mt.startsWith("image/")) return "image";

    if (t === "ptt") return "audio";
    if (t === "audio") return "audio";
    if (has && mt.startsWith("audio/")) return "audio";
    if (has && mt.startsWith("video/")) return "video";
    if (has && (mt === "image/webp" || mt === "application/webp")) return "sticker";

    return t || "chat";
  } catch {
    return msg?.type || "chat";
  }
}

// ---------- HOTFIX: resolução robusta do nome do remetente ----------
async function resolveMessageSenderName(client, msg) {
  try {
    // 1) Fonte mais confiável: o próprio objeto Message sabe o remetente
    if (typeof msg.getContact === "function") {
      try {
        const c = await msg.getContact();
        const name =
          c?.name ||
          c?.pushname ||
          c?.verifiedName ||
          c?.shortName ||
          c?.number ||
          null;
        if (name) return { name, short: shortName(name) };
      } catch {}
    }

    // 2) Alguns builds trazem o id do autor em grupos
    const senderId = msg?.author || msg?.from || null;
    if (senderId) {
      try {
        const c = await client.getContactById(senderId);
        const name =
          c?.name ||
          c?.pushname ||
          c?.verifiedName ||
          c?.shortName ||
          c?.number ||
          senderId;
        return { name, short: shortName(name) };
      } catch {}
    }

    // 3) fallback: notifyName dentro do _data
    const notifyName = msg?._data?.notifyName || msg?._data?.sender?.name || null;
    if (notifyName) return { name: notifyName, short: shortName(notifyName) };

    // 4) última defesa: número “puro”
    const num = (senderId || msg?.from || "").replace(/@.+$/, "");
    return { name: num || null, short: num || null };
  } catch {
    const num = (msg?.from || "").replace(/@.+$/, "");
    return { name: num || null, short: num || null };
  }
}

function broadcast(tenant, payload) {
  const s = sessions.get(tenant);
  if (!s) return;
  for (const res of s.listeners) res.write(`data: ${JSON.stringify(payload)}n`);
}

/* --------------------------- DTOs --------------------------- */

async function toMessageDTO(msg, client) {
  const type = normalizeType(msg);
  const { name: senderName, short: senderShort } = await resolveMessageSenderName(client, msg);

  return {
    id: msg.id?._serialized ?? msg.id,
    chatId: msg.fromMe ? msg.to : msg.from,
    from: msg.from,
    to: msg.to,
    fromMe: !!msg.fromMe,
    body: msg.body,
    type,
    hasMedia: !!msg.hasMedia,
    mimetype: msg.mimetype ?? null,
    filename: msg.filename ?? null,
    size: msg.size ?? null,
    ack: msg.ack ?? null,
    timestamp: msg.timestamp ?? null,
    quotedMsgId: msg.hasQuotedMsg ? msg._data?.quotedMsgId ?? null : null,
    author: msg.author ?? null,
    senderName,
    senderShort,
    isCameraImage:
      type === "image" &&
      msg?.type === "image" &&
      (!msg?.filename || String(msg?.filename).trim() === ""),
  };
}

async function toChatDTO(chat, client) {
  const last = chat.lastMessage || null;
  const type = last ? normalizeType(last) : null;

  let lastSenderName = null;
  if (last && chat.isGroup) {
    try {
      const r = await resolveMessageSenderName(client, last);
      lastSenderName = r.name;
    } catch {}
  }

  return {
    id: chat.id?._serialized ?? chat.id,
    name:
      chat.name ||
      chat.formattedTitle ||
      chat.contact?.name ||
      chat.id?.user ||
      "Contato",
    isGroup: !!chat.isGroup,
    unreadCount: chat.unreadCount ?? 0,
    archived: !!chat.archived,
    pinned: !!chat.pinned,
    timestamp: last?.timestamp ?? chat.timestamp ?? null,
    lastMessage: last
      ? {
          id: last.id?._serialized ?? last.id,
          body: last.body,
          fromMe: !!last.fromMe,
          timestamp: last.timestamp ?? null,
          ack: last.ack ?? null,
          type,
          senderName: lastSenderName,
          isCameraImage:
            type === "image" &&
            last?.type === "image" &&
            (!last?.filename || String(last?.filename).trim() === ""),
        }
      : null,
  };
}

/* --------------------------- sessão --------------------------- */

function getOrCreateSession(tenant) {
  let s = sessions.get(tenant);
  if (s) return s;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: tenant }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
      ],
    },
  });

  s = { client, status: "OFFLINE", listeners: new Set(), qr: null };
  sessions.set(tenant, s);

  const setStatus = (st) => {
    s.status = st;
    broadcast(tenant, { type: "status", status: st });
  };

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
    try { await client.initialize(); } catch { setStatus("OFFLINE"); }
  });

  client.on("auth_failure", () => setStatus("OFFLINE"));

  client.on("message", async (msg) => {
    const dto = await toMessageDTO(msg, client);
    broadcast(tenant, { type: "message", message: dto });
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

/* --------------------------- rotas de sessão --------------------------- */

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
  res.write(`data: ${JSON.stringify({ type: "status", status: s.status })}\n\n`);
  if (s.qr) res.write(`data: ${JSON.stringify({ type: "qr", qr: s.qr })}\n\n`);
  req.on("close", () => s.listeners.delete(res));
});

app.post("/sessions/:tenant/stop", async (req, res) => {
  const { tenant } = req.params;
  const s = sessions.get(tenant);
  if (s) {
    try { await s.client.destroy(); } catch {}
    sessions.delete(tenant);
  }
  return res.json({ ok: true, tenant });
});

app.get("/sessions", (_req, res) => {
  const list = [...sessions.entries()].map(([tenant, s]) => ({ tenant, status: s.status }));
  res.json(list);
});

app.get("/sessions/:tenant/status", (req, res) => {
  const { tenant } = req.params;
  const s = sessions.get(tenant);
  if (!s) return res.status(404).json({ ok: false, error: "Sessão não encontrada" });
  return res.json({ ok: true, tenant, status: s.status });
});

app.get("/sessions/status", (_req, res) => {
  const list = [...sessions.entries()].map(([tenant, s]) => ({ tenant, status: s.status }));
  res.json({ ok: true, status: "online", uptime: process.uptime(), sessions: list });
});

/* --------------------------- rotas de atendimento --------------------------- */

app.get("/sessions/:tenant/chats", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    const q = (req.query.q || "").toString().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const isGroup =
      req.query.isGroup === "true" ? true : req.query.isGroup === "false" ? false : null;
    const archived =
      req.query.archived === "true" ? true : req.query.archived === "false" ? false : null;
    const unreadOnly = req.query.unreadOnly === "true";

    const { client } = requireOnline(tenant);
    const chats = await client.getChats();

    let items = [];
    for (const c of chats) {
      if (c.isAnnouncement) continue;
      items.push(await toChatDTO(c, client));
    }

    if (isGroup !== null) items = items.filter((c) => c.isGroup === isGroup);
    if (archived !== null) items = items.filter((c) => c.archived === archived);
    if (unreadOnly) items = items.filter((c) => (c.unreadCount ?? 0) > 0);

    if (q) {
      items = items.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.id?.toLowerCase().includes(q) ||
          c.lastMessage?.body?.toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const slice = items.slice(offset, offset + limit);
    res.json({ total: items.length, offset, limit, items: slice });
  } catch (err) {
    next(err);
  }
});

app.get("/sessions/:tenant/chats/:chatId/participants", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    if (!chat.isGroup) return res.json({ ok: true, participants: [] });

    const result = [];
    for (const p of chat.participants || []) {
      const id = p?.id?._serialized ?? p?.id;
      let name = null;
      try {
        const c = await client.getContactById(id);
        name = c?.name || c?.pushname || c?.verifiedName || c?.shortName || c?.number || id;
      } catch {
        name = (id || "").replace(/@.+$/, "");
      }
      result.push({ id, name, short: shortName(name), isAdmin: !!p.isAdmin || !!p.isSuperAdmin });
    }
    res.json({ ok: true, participants: result });
  } catch (err) {
    next(err);
  }
});

app.get("/sessions/:tenant/contacts", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const { client } = requireOnline(tenant);

    const out = {};
    for (const id of ids) {
      try {
        const c = await client.getContactById(id);
        const name =
          c?.name || c?.pushname || c?.verifiedName || c?.shortName || c?.number || id;
        out[id] = { name, short: shortName(name) };
      } catch {
        const num = (id || "").replace(/@.+$/, "");
        out[id] = { name: num, short: num };
      }
    }
    res.json({ ok: true, contacts: out });
  } catch (err) {
    next(err);
  }
});

app.get("/sessions/:tenant/chats/:chatId/photo", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    let url = null;
    if (typeof chat.getProfilePicUrl === "function") url = await chat.getProfilePicUrl();
    if (!url && typeof chat.getContact === "function") {
      const contact = await chat.getContact();
      if (contact && typeof contact.getProfilePicUrl === "function") {
        url = await contact.getProfilePicUrl();
      }
    }
    res.json({ ok: true, chatId, url });
  } catch (err) {
    next(err);
  }
});

app.get("/sessions/:tenant/chats/:chatId/messages", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const { client } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });

    const list = [];
    for (const m of messages) list.push(await toMessageDTO(m, client));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

app.get("/sessions/:tenant/messages/:messageId/media", async (req, res, next) => {
  try {
    const { tenant, messageId } = req.params;
    const { client } = requireOnline(tenant);
    const msg = await client.getMessageById(messageId);
    if (!msg || !msg.hasMedia) {
      return res.status(404).json({ ok: false, error: "Mídia não encontrada para essa mensagem" });
    }
    const media = await msg.downloadMedia();
    res.json({
      ok: true,
      messageId,
      mimetype: media.mimetype,
      filename: media.filename || "file",
      data: media.data, // base64
      isCameraImage:
        (msg.type === "image" || (msg.mimetype || "").startsWith("image/")) &&
        (!msg.filename || String(msg.filename).trim() === ""),
    });
  } catch (err) {
    next(err);
  }
});

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
      if (!mimetype || !filename)
        return res.status(400).json({ ok: false, error: "informe mimetype e filename junto ao base64" });
      media = new MessageMedia(mimetype, base64, filename);
    }

    const { client } = requireOnline(tenant);
    const msg = await client.sendMessage(to, media, { caption });
    res.json({ ok: true, messageId: msg.id?._serialized ?? msg.id });
  } catch (err) {
    next(err);
  }
});

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

/* --------------------------- home & erros --------------------------- */

app.get("/", (_req, res) => res.send("WA QR Connector up ✅"));

app.use((err, _req, res, _next) => {
  const code = err.status || 500;
  res.status(code).json({ ok: false, error: err.message || "Erro interno" });
});

app.listen(PORT, () => console.log("Listening on", PORT));
