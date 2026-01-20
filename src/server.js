// /src/server.js  (FULL FILE)
// Rev: 2026-01-20-v2-server-debug-field
//
// Adds: GET /debug/field/:key
// Returns the exact joined row v2 uses for FIELD_FULL.

import express from "express";
import { failFast } from "./util/failFast.js";
import { handleChat } from "./chat/handleChat.js";
import { ensureDbReady, getDbStatus, reloadDbFromGcs, getDb } from "../context/snapshot-db.js";

failFast();

const app = express();
app.use(express.json({ limit: "6mb" }));

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

// DEBUG: show joined field row (what v2 getter intends)
app.get("/debug/field/:key", async (req, res) => {
  try {
    await ensureDbReady({ force: false });
    const sqlite = getDb();
    const key = (req.params.key || "").toString().trim();

    const byId = sqlite.prepare(`
      SELECT
        f.id AS fieldId,
        f.name AS fieldName,
        f.farmId AS farmId,
        f.farmName AS fieldFarmName,
        fm.name AS farmName,
        f.rtkTowerId AS rtkTowerId,
        f.rtkTowerName AS fieldTowerName,
        rt.name AS rtkTowerName,
        rt.networkId AS rtkNetworkId,
        rt.frequency AS rtkFrequency
      FROM fields f
      LEFT JOIN farms fm ON fm.id = f.farmId
      LEFT JOIN rtkTowers rt ON rt.id = f.rtkTowerId
      WHERE f.id = ?
      LIMIT 1
    `).get(key);

    const byName = sqlite.prepare(`
      SELECT
        f.id AS fieldId,
        f.name AS fieldName,
        f.farmId AS farmId,
        f.farmName AS fieldFarmName,
        fm.name AS farmName,
        f.rtkTowerId AS rtkTowerId,
        f.rtkTowerName AS fieldTowerName,
        rt.name AS rtkTowerName,
        rt.networkId AS rtkNetworkId,
        rt.frequency AS rtkFrequency
      FROM fields f
      LEFT JOIN farms fm ON fm.id = f.farmId
      LEFT JOIN rtkTowers rt ON rt.id = f.rtkTowerId
      WHERE lower(f.name) LIKE lower(?)
      LIMIT 1
    `).get(`%${key}%`);

    noStore(res);
    res.json({ ok: true, key, byId: byId || null, byName: byName || null });
  } catch (e) {
    noStore(res);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/chat", handleChat);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  ensureDbReady({ force: false }).catch(() => {});
  console.log(`[copilot-v2] listening on :${port}`);
});
