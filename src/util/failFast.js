// /src/util/failFast.js  (FULL FILE)
// Rev: 2026-01-20-v2-failfast-gcsdb
//
// Fail fast on missing critical env. We do NOT require SNAPSHOT_SQLITE_PATH
// because this repo already uses GCS->/tmp loader via context/snapshot-db.js.

export function failFast() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  // Your existing snapshot-db defaults bucket/object, but token/creds must exist in runtime.
  // If you set explicit vars, we at least validate they're non-empty.
  const b = (process.env.FV_GCS_BUCKET || "").toString().trim();
  const o = (process.env.FV_GCS_OBJECT || "").toString().trim();

  // No hard requirement because snapshot-db has defaults, but if one is set, both should be.
  if ((b && !o) || (!b && o)) {
    throw new Error("Set BOTH FV_GCS_BUCKET and FV_GCS_OBJECT (or set neither to use defaults).");
  }
}
