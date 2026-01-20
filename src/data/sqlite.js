// /src/data/sqlite.js  (FULL FILE)
// Rev: 2026-01-20-v2-sqlite-bridge
//
// Bridge v2 to the EXISTING GCS-backed SQLite loader.
// Truth source stays: /context/snapshot-db.js (downloads live.sqlite to /tmp and opens readonly)

import { ensureDbReady, getDb } from "../../context/snapshot-db.js";

export async function ensureReady() {
  await ensureDbReady({ force: false });
  return true;
}

export function db() {
  return getDb();
}
