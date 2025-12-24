import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

// --------------------------------------------------
// CORS (required for FarmVista GitHub Pages frontend)
// --------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  "https://dkillam05.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

// --------------------
// Health check
// --------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'farmvista-copilot',
    ts: new Date().toISOString()
  });
});

// --------------------
// Chat endpoint
// --------------------
app.post('/chat', async (req, res) => {
  const q = (req.body?.question || '').toString().trim();

  if (!q) {
    return res.status(400).json({ error: 'Missing question' });
  }

  // Stub response (verifies wiring)
  res.json({
    answer: `Echo: ${q}`,
    meta: { receivedAt: new Date().toISOString() }
  });
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
});
