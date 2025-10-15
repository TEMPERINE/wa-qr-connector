// index.js
// ===== WhatsApp QR Connector - Atendimento (multi-tenant) =====

import express from "express";
import cors from "cors";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;

// tenant -> { client, status, listeners:Set<res>, qr, nameCache: Map<wid,name> }
const sessions = new Map();

/* --------------------------- helpers --------------------------- */

function parseNumberFromWid(wid = "") {
  // "5511999999999@c.us" -> "5511999999999"
  const i = wid.indexOf("@");
  return i > 0 ? wid.slice(0, i) : wid;
}

function bestContactName(contact) {
  // ordem de prioridade para exibir nome
  return (
    contact?.name ||
    contact?.pushname ||
    contact?.shortName ||
    contact?.verifiedName ||
    parseNumberFromWid(contact?.id?._serialized || contact?.id) ||
    "Contato"
  );
}

async function resolveName(client, cache, wid) {
  if (!wid) return null;
  if (cache.has(wid)) return cache.get(wid);
  try {
    const contact = await client.getContactById(wid);
    const name = bestContactName(contact);
    cache.set(wid, name);
    return name;
  } catch {
    const fallback = parseNumberFromWid(wid);
    cache.set(wid, fallback);
    return fallback;
  }
}

function sseBroadcast(tenant, payload) {
  const s = sessions.get(tenant);
  if (!s) return;
  for (const res of s.listeners) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function baseMessageDTO(msg) {
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
    ack: msg.ack ?? null, // 0 pendente, 1 enviada, 2 entregue, 3 lida, 4 reproduzida
    timestamp: msg.timestamp ?? null,
    quotedMsgId: msg.hasQuotedMsg ? msg._data?.quotedMsgId ?? null : null,
    author: msg.author ?? null, // útil em grupos (wid do remetente)
  };
}

async function enrichMessageDTO(msg, client, cache) {
  const dto = baseMessageDTO(msg);
  // Em grupos, quando houver "author" (remetente), buscamos o nome
  if (dto.author) {
    dto.authorName = await resolveName(client, cache, dto.author);
  } else {
    dto.authorName = null;
  }
  return dto;
}

async function toChatDTO(chat, client, cache) {
  const last = chat.lastMessage || null;
  let lastDTO = null;

  if (last) {
    lastDTO = {
      id: last.id?._serialized ?? last.id,
      body: last.body,
      fromMe: !!last.fromMe,
      timestamp: last.timestamp ?? null,
      ack: last.ack ?? null,
      type: last.type,
      author: last.author ?? null,
      authorName: null,
    };
    if (lastDTO.author) {
      lastDTO.authorName = await resolveName(client, cache, lastDTO.author);
    }
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
    lastMessage: lastDTO,
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

  s = { client, status: "OFFLINE", listeners: new Set(), qr: null, nameCache: new Map() };
  sessions.set(tenant, s);

  const setStatus = (st) => {
    s.status = st;
    sseBroadcast(tenant, { type: "status", status: st });
  };

  // --- conexão / QR ---
  client.on("qr", (qr) => {
    s.qr = qr;
    setStatus("RECONNECTING");
    sseBroadcast(tenant, { type: "qr", qr });
  });

  client.on("ready", () => {
    setStatus("ONLINE");
    sseBroadcast(tenant, { type: "ready", ok: true });
  });

  client.on("change_state", (state) =>
    sseBroadcast(tenant, { type: "state", state })
  );

  client.on("disconnected", async () => {
    setStatus("RECONNECTING");
    try {
      await client.initialize();
    } catch {
      setStatus("OFFLINE");
    }
  });

  client.on("auth_failure", () => setStatus("OFFLINE"));

  // --- eventos em tempo real ---
  client.on("message", async (msg) => {
    try {
      const enriched = await enrichMessageDTO(msg, client, s.nameCache);
      sseBroadcast(tenant, { type: "message", message: enriched });
    } catch {
      // Se falhar o enrich, manda o básico mesmo assim
      sseBroadcast(tenant, { type: "message", message: baseMessageDTO(msg) });
    }
  });

  client.on("message_ack", (msg, ack) => {
    const id = msg?.id?._serialized ?? msg?.id;
    sseBroadcast(tenant, { type: "ack", messageId: id, ack });
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

/* --------------------------- rotas conexão --------------------------- */

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
  res.write(
    `data: ${JSON.stringify({ type: "status", status: s.status })}\n\n`
  );
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

// Status simples por tenant
app.get("/sessions/:tenant/status", (req, res) => {
  const { tenant } = req.params;
  const s = sessions.get(tenant);
  if (!s) return res.status(404).json({ ok: false, error: "Sessão não encontrada" });
  return res.json({ ok: true, tenant, status: s.status });
});

// Status global p/ health-check do Lovable
app.get("/sessions/status", (_req, res) => {
  const list = [...sessions.entries()].map(([tenant, s]) => ({
    tenant,
    status: s.status,
  }));
  res.json({
    ok: true,
    status: "online",
    uptime: process.uptime(),
    sessions: list,
  });
});

/* --------------------------- rotas utilitárias de contatos --------------------------- */

// Buscar nome/contato por WID
app.get("/sessions/:tenant/contacts/:wid", async (req, res, next) => {
  try {
    const { tenant, wid } = req.params;
    const { client, nameCache } = requireOnline(tenant);

    const name = await resolveName(client, nameCache, wid);
    const contact = await client.getContactById(wid).catch(() => null);

    res.json({
      ok: true,
      id: wid,
      name,
      number: parseNumberFromWid(wid),
      raw: contact ? {
        name: contact.name ?? null,
        pushname: contact.pushname ?? null,
        shortName: contact.shortName ?? null,
        verifiedName: contact.verifiedName ?? null,
      } : null,
    });
  } catch (err) {
    next(err);
  }
});

// Buscar vários nomes em lote: /contacts?ids=a@c.us,b@c.us
app.get("/sessions/:tenant/contacts", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    const ids = (req.query.ids || "").toString().split(",").map(s => s.trim()).filter(Boolean);
    const { client, nameCache } = requireOnline(tenant);

    const entries = await Promise.all(ids.map(async (wid) => {
      const name = await resolveName(client, nameCache, wid);
      return [wid, name];
    }));
    res.json({ ok: true, map: Object.fromEntries(entries) });
  } catch (err) {
    next(err);
  }
});

// Participantes de um chat (grupo)
app.get("/sessions/:tenant/chats/:chatId/participants", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client, nameCache } = requireOnline(tenant);

    const chat = await client.getChatById(chatId);
    if (!chat.isGroup) return res.json({ ok: true, items: [] });

    const participants = await Promise.all(
      chat.participants.map(async (p) => {
        const wid = p.id?._serialized || p.id;
        const name = await resolveName(client, nameCache, wid);
        return {
          id: wid,
          name,
          isAdmin: !!p.isAdmin || !!p.isSuperAdmin,
        };
      })
    );

    res.json({ ok: true, items: participants });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- rotas atendimento --------------------------- */

// 1) Listar chats com filtros/paginação
// GET /sessions/:tenant/chats?q=&isGroup=true|false&archived=true|false&unreadOnly=true|false&limit=30&offset=0
app.get("/sessions/:tenant/chats", async (req, res, next) => {
  try {
    const { tenant } = req.params;
    const q = (req.query.q || "").toString().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const isGroup = req.query.isGroup === "true" ? true : req.query.isGroup === "false" ? false : null;
    const archived = req.query.archived === "true" ? true : req.query.archived === "false" ? false : null;
    const unreadOnly = req.query.unreadOnly === "true";

    const { client, nameCache } = requireOnline(tenant);
    const chats = await client.getChats();

    let dtos = await Promise.all(
      chats
        .filter((c) => !c.isAnnouncement) // evita canais
        .map((c) => toChatDTO(c, client, nameCache))
    );

    if (isGroup !== null) dtos = dtos.filter((c) => c.isGroup === isGroup);
    if (archived !== null) dtos = dtos.filter((c) => c.archived === archived);
    if (unreadOnly) dtos = dtos.filter((c) => (c.unreadCount ?? 0) > 0);

    if (q) {
      dtos = dtos.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.id?.toLowerCase().includes(q) ||
          c.lastMessage?.body?.toLowerCase().includes(q)
      );
    }

    // ordena por atividade recente
    dtos.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    const slice = dtos.slice(offset, offset + limit);
    res.json({ total: dtos.length, offset, limit, items: slice });
  } catch (err) {
    next(err);
  }
});

// 2) Foto do chat/contato
// GET /sessions/:tenant/chats/:chatId/photo
app.get("/sessions/:tenant/chats/:chatId/photo", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const { client } = requireOnline(tenant);

    const chat = await client.getChatById(chatId);
    let url = null;

    if (typeof chat.getProfilePicUrl === "function") {
      url = await chat.getProfilePicUrl();
    }
    if (!url && typeof chat.getContact === "function") {
      const contact = await chat.getContact();
      if (contact && typeof contact.getProfilePicUrl === "function") {
        url = await contact.getProfilePicUrl();
      }
    }

    res.json({ ok: true, chatId, url }); // se null, não há foto definida
  } catch (err) {
    next(err);
  }
});

// 3) Listar mensagens de um chat (histórico)
// GET /sessions/:tenant/chats/:chatId/messages?limit=50
app.get("/sessions/:tenant/chats/:chatId/messages", async (req, res, next) => {
  try {
    const { tenant, chatId } = req.params;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));

    const { client, nameCache } = requireOnline(tenant);
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });

    const dtos = await Promise.all(
      messages.map((m) => enrichMessageDTO(m, client, nameCache))
    );

    res.json(dtos);
  } catch (err) {
    next(err);
  }
});

// 4) Baixar mídia de uma mensagem
// GET /sessions/:tenant/messages/:messageId/media
app.get("/sessions/:tenant/messages/:messageId/media", async (req, res, next) => {
  try {
    const { tenant, messageId } = req.params;
    const { client } = requireOnline(tenant);

    const msg = await client.getMessageById(messageId);
    if (!msg || !msg.hasMedia) {
      return res.status(404).json({ ok: false, error: "Mídia não encontrada para essa mensagem" });
    }

    const media = await msg.downloadMedia(); // MessageMedia
    res.json({
      ok: true,
      messageId,
      mimetype: media.mimetype,
      filename: media.filename || "file",
      data: media.data, // base64
    });
  } catch (err) {
    next(err);
  }
});

// 5) Enviar texto
// POST /sessions/:tenant/messages  { to, body, quotedMsgId? }
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

// 6) Enviar mídia (URL ou base64)
// POST /sessions/:tenant/messages/media
// body: { to, mediaUrl, caption?, filename?, mimetype? }  OU  { to, base64, mimetype, filename, caption? }
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

// 7) Marcar chat como lido
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

/* --------------------------- home & erros --------------------------- */

app.get("/", (_req, res) => res.send("WA QR Connector up ✅"));

app.use((err, _req, res, _next) => {
  const code = err.status || 500;
  res.status(code).json({ ok: false, error: err.message || "Erro interno" });
});

app.listen(PORT, () => console.log("Listening on", PORT));
