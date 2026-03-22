// Vercel serverless function
const rooms = global.__rooms || (global.__rooms = new Map());

export default function handler(req, res) {
  const { code, senderId, lastIndex } = req.query;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const idx = parseInt(lastIndex) || 0;
  const messages = room.signals
    .slice(idx)
    .filter(m => m.senderId !== senderId);

  res.json({ messages, nextIndex: room.signals.length });
}
