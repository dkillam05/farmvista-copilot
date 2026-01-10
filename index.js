// /index.js  (FULL FILE)
// Rev: 2026-01-10-index-clean-sql1
//
// Clean SQL-first Copilot:
// ✅ /health
// ✅ /db/status   (verify DB loaded)
// ✅ /db/reload   (force reload from GCS)
// ✅ /snapshot/build (build SQLite from Firestore and upload to GCS)
// ✅ /chat        (OpenAI tool-calls db_query; never guesses)

import express from "express";
import { corsMiddleware } from "./utils/cors.js";

import { buildSnapshotHttp } from "./context/snapshot-build.js";
import { ensureDbReady, reloadDbFromGcs, getDbStatus } from "./context/snapshot-db.js";
import { handleChatHttp } from "./chat/handleChat.js";

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(corsMiddleware());

function getRevision() {
  // Optional: set in Cloud Run env or build pipeline
  return (process.env.K_REVISION || process.env.REVISION || "dev").toString();
}

app.get("/health", async (req, res) => {
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
    res.json({ ok: true, ...status, revision: getRevision() });
  } catch (e) {
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
    res.json({ ok: true, reloaded: true, ...status, revision: getRevision() });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      revision: getRevision()
    });
  }
});

// Build + upload a fresh SQLite snapshot (manual trigger; you’ll schedule this daily)
app.post("/snapshot/build", buildSnapshotHttp);

// Chat endpoint
app.post("/chat", handleChatHttp);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  // Best-effort warm DB on boot (don’t crash if missing on first deploy)
  ensureDbReady({ force: false }).catch(() => {});
  console.log(`[copilot] listening on :${port} rev=${getRevision()}`);
});
