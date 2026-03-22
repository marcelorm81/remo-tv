// Vercel serverless function
const rooms = global.__rooms || (global.__rooms = new Map());

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Generate 6-digit code
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));

  const hostId = crypto.randomUUID();
  rooms.set(code, { hostId, created: Date.now(), signals: [], tvList: [], status: 'waiting' });

  // Clean up rooms older than 24h
  for (const [k, v] of rooms) { if (Date.now() - v.created > 86400000) rooms.delete(k); }

  res.json({ code, hostId });
}
