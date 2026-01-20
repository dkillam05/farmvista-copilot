// /src/server.js  (FULL FILE)
// Rev: 2026-01-20-v2-server-debug-grainbags
//
// v2 server entrypoint (clean)
// - Built-in minimal CORS
// - Uses existing GCS->/tmp SQLite loader: /context/snapshot-db.js
// - Endpoints: /health, /db/status, /db/reload, /chat
// - Debug: /debug/grainbags (read-only snapshot inspection)

import express from "express";
import { failFast } from "./util/failFast.js";
import { handleChat } from "./chat/handleChat.js";
import { ensureDbReady, getDbStatus, reloadDbFromGcs, getDb } from "../context/snapshot-db.js";

failFast();

const app = express();
app.use(express.json({ limit: "6mb" }));

// Minimal CORS (no external deps)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function noStore(res) {
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

// READ-ONLY debug snapshot inspection (remove later)
app.get("/debug/grainbags", async (req, res) => {
  try {
    await ensureDbReady({ force: false });
    const sqlite = getDb();

    const viewCount = sqlite.prepare(`SELECT COUNT(1) AS n FROM v_grainBag_open_remaining`).get();
    const productCount = sqlite.prepare(`SELECT COUNT(1) AS n FROM productsGrainBags`).get();

    const cropTypes = sqlite.prepare(`
      SELECT cropType, COUNT(1) AS n
      FROM v_grainBag_open_remaining
      GROUP BY cropType
      ORDER BY n DESC
    `).all();

    const sample = sqlite.prepare(`
      SELECT
        putDownId, cropType, bagBrand, bagDiameterFt, bagSizeFeet,
        remainingFull, remainingPartial, remainingPartialFeetSum
      FROM v_grainBag_open_remaining
      LIMIT 5
    `).all();

    noStore(res);
    res.json({
      ok: true,
      v_grainBag_open_remaining_rows: viewCount?.n ?? 0,
      productsGrainBags_rows: productCount?.n ?? 0,
      cropTypes,
      sample
    });
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
