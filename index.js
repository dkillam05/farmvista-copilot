// /index.js  (FULL FILE)
// Rev: 2026-01-10-index-clean-sql2-admin-build-get
//
// Adds phone-friendly admin URLs:
// ✅ GET /admin/build?token=XXXX  -> triggers snapshot build
// ✅ GET /admin/status?token=XXXX -> returns db status
//
// Requires env var FV_ADMIN_TOKEN (or uses FV_BUILD_TOKEN as fallback)

import express from "express";
import { corsMiddleware } from "./utils/cors.js";

import { buildSnapshotHttp, buildSnapshotToSqlite } from "./context/snapshot-build.js";
import { ensureDbReady, reloadDbFromGcs, getDbStatus } from "./context/snapshot-db.js";
import { handleChatHttp } from "./chat/handleChat.js";

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(corsMiddleware());

function getRevision() {
  return (process.env.K_REVISION || process.env.REVISION || "dev").toString();
}

function noStore(res){
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function adminToken(){
  return (process.env.FV_ADMIN_TOKEN || process.env.FV_BUILD_TOKEN || "").toString().trim();
}

function tokenOk(req){
  const want = adminToken();
  if (!want) return false;
  const gotQ = (req.query?.token || "").toString().trim();
  const gotH = (req.get("x-admin-token") || "").toString().trim();
  return (gotQ && gotQ === want) || (gotH && gotH === want);
}

app.get("/health", async (req, res) => {
  noStore(res);
  res.json({
    ok: true,
    service: "farmvista-copilot-sql",
    revision: getRevision(),
    now: new Date().toISOString()
  });
});

app.get("/db/status", async (req, res) => {
  try {
    await ensureDbReady({ force: false });
    const status = await getDbStatus();
    noStore(res);
    res.json({ ok: true, ...status, revision: getRevision() });
  } catch (e) {
    noStore(res);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      revision: getRevision()
    });
  }
});

app.post("/db/reload", async (req, res) => {
  try {
    await reloadDbFromGcs();
    const status = await getDbStatus();
    noStore(res);
    res.json({ ok: true, reloaded: true, ...status, revision: getRevision() });
  } catch (e) {
    noStore(res);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      revision: getRevision()
    });
  }
});

// Existing POST build endpoint
app.post("/snapshot/build", buildSnapshotHttp);

// ✅ NEW: Phone-friendly GET build endpoint
app.get("/admin/build", async (req, res) => {
  noStore(res);

  const want = adminToken();
  if (!want) return res.status(501).json({ ok:false, error:"Set FV_ADMIN_TOKEN (or FV_BUILD_TOKEN) to enable /admin/build" });
  if (!tokenOk(req)) return res.status(401).json({ ok:false, error:"unauthorized" });

  try{
    const result = await buildSnapshotToSqlite();
    // Force reload so the running instance uses the fresh DB immediately
    await ensureDbReady({ force: true }).catch(()=>{});
    res.json({ ok:true, ...result, revision:getRevision() });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// ✅ NEW: Phone-friendly status endpoint (requires token)
app.get("/admin/status", async (req, res) => {
  noStore(res);

  const want = adminToken();
  if (!want) return res.status(501).json({ ok:false, error:"Set FV_ADMIN_TOKEN (or FV_BUILD_TOKEN) to enable /admin/status" });
  if (!tokenOk(req)) return res.status(401).json({ ok:false, error:"unauthorized" });

  try{
    await ensureDbReady({ force: false });
    const status = await getDbStatus();
    res.json({ ok:true, ...status, revision:getRevision() });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// Chat endpoint
app.post("/chat", handleChatHttp);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  ensureDbReady({ force: false }).catch(() => {});
  console.log(`[copilot] listening on :${port} rev=${getRevision()}`);
});