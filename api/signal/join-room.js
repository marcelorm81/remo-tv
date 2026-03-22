// Vercel serverless function
const rooms = global.__rooms || (global.__rooms = new Map());

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { code } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const clientId = crypto.randomUUID();
  room.clientId = clientId;
  room.status = 'paired';

  res.json({ hostId: room.hostId, clientId, tvList: room.tvList });
}
