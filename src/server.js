// /src/server.js  (FULL FILE)
// Rev: 2026-01-20-v2-server-gcsdb
//
// v2 server entrypoint (THIS is what npm start runs)
// - Uses existing GCS->/tmp SQLite loader: context/snapshot-db.js
// - Exposes /health and /db/status for sanity
// - Exposes /chat using v2 pipeline (intent -> getters -> answer writer)

import express from "express";
import { failFast } from "./util/failFast.js";
import { handleChat } from "./chat/handleChat.js";

import { corsMiddleware } from "../utils/cors.js";
import { ensureDbReady, getDbStatus, reloadDbFromGcs } from "../context/snapshot-db.js";

failFast();

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(corsMiddleware());

function noStore(res){
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

app.get("/health", async (req, res) => {
  noStore(res);
  res.json({ ok: true, service: "farmvista-copilot-v2", now: new Date().toISOString() });
});

app.get("/db/status", async (req, res) => {
  try {
    await ensureDbReady({ force: false });
    const status = await getDbStatus();
    noStore(res);
    res.json({ ok: true, ...status });
  } catch (e) {
    noStore(res);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/db/reload", async (req, res) => {
  try {
    await reloadDbFromGcs();
    const status = await getDbStatus();
    noStore(res);
    res.json({ ok: true, reloaded: true, ...status });
  } catch (e) {
    noStore(res);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// v2 chat
app.post("/chat", handleChat);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  ensureDbReady({ force: false }).catch(() => {});
  console.log(`[copilot-v2] listening on :${port}`);
});
