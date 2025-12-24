import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health check (Cloud Run + you)
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'farmvista-copilot', ts: new Date().toISOString() });
});

// Chat endpoint (stub for now)
app.post('/chat', async (req, res) => {
  const q = (req.body?.question || '').toString().trim();

  if (!q) return res.status(400).json({ error: 'Missing question' });

  // For now: echo back, so you can verify wiring from the dashboard.
  res.json({
    answer: `Echo: ${q}`,
    meta: { receivedAt: new Date().toISOString() }
  });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
});