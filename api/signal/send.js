// Vercel serverless function
const rooms = global.__rooms || (global.__rooms = new Map());

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { code, senderId, type, payload } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  room.signals.push({ senderId, type, payload, ts: Date.now() });

  // If it's a tv-list update, store it
  if (type === 'tv-list') room.tvList = payload;

  res.json({ ok: true });
}
