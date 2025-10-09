import express from "express";
import cors from "cors";
import { Client, LocalAuth } from "whatsapp-web.js";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Memória simples em runtime
const sessions = new Map(); // tenant -> { client, status, listeners:Set<res>, qr }

function broadcast(tenant, payload) {
  const s = sessions.get(tenant);
  if (!s) return;
  for (const res of s.listeners) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function getOrCreateSession(tenant) {
  let s = sessions.get(tenant);
  if (s) return s;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: tenant }),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] }
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

  client.on("disconnected", async () => {
    setStatus("RECONNECTING");
    try { await client.initialize(); }
    catch { setStatus("OFFLINE"); }
  });

  client.on("auth_failure", () => setStatus("OFFLINE"));

  client.initialize().catch(() => setStatus("OFFLINE"));

  return s;
}

// Iniciar/garantir sessão
app.post("/sessions/:tenant/start", (req, res) => {
  const { tenant } = req.params;
  const s = getOrCreateSession(tenant);
  return res.json({ ok: true, tenant, status: s.status });
});

// Stream (SSE) para QR + status em tempo real
app.get("/sessions/:tenant/stream", (req, res) => {
  const { tenant } = req.params;
  const s = getOrCreateSession(tenant);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders?.();

  s.listeners.add(res);

  // Envia estado inicial
  res.write(`data: ${JSON.stringify({ type: "status", status: s.status })}\n\n`);
  if (s.qr) res.write(`data: ${JSON.stringify({ type: "qr", qr: s.qr })}\n\n`);

  req.on("close", () => s.listeners.delete(res));
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

// Listar sessões
app.get("/sessions", (req, res) => {
  const list = [...sessions.entries()].map(([tenant, s]) => ({
    tenant, status: s.status
  }));
  res.json(list);
});

app.get("/", (_req, res) => res.send("WA QR Connector up ✅"));

app.listen(PORT, () => console.log("Listening on", PORT));
