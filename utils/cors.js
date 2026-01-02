// /utils/cors.js
// Rev: 2026-01-02-cors-min1
//
// Beginner-safe CORS middleware:
// - Explicit allowlist (no "*")
// - Clean OPTIONS handling
// - No hidden behavior
// - Safe for Firebase auth headers

export function corsMiddleware() {
  const ALLOWED_ORIGINS = new Set([
    "https://dkillam05.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);

  return function cors(req, res, next) {
    const origin = req.headers.origin;

    // Only reflect known origins
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    // Cache preflight for 24h
    res.setHeader("Access-Control-Max-Age", "86400");

    // Handle preflight cleanly
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    next();
  };
}
