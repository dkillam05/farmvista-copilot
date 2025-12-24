export function corsMiddleware() {
  const ALLOWED_ORIGINS = new Set([
    "https://dkillam05.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}
