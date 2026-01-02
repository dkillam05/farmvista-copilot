// /utils/cors.js  (FULL FILE)
// Rev: 2026-01-02-min-core0

export function corsMiddleware() {
  return (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}
