// signal-routes.js — Express routes for local signaling server
const rooms = new Map();

module.exports = function addSignalRoutes(app) {
  // Clean up old rooms periodically
  setInterval(() => {
    for (const [k, v] of rooms) {
      if (Date.now() - v.created > 86400000) rooms.delete(k);
    }
  }, 60000);

  app.post('/api/signal/create-room', (req, res) => {
    let code;
    do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));
    const hostId = require('crypto').randomUUID();
    rooms.set(code, { hostId, created: Date.now(), signals: [], tvList: [], status: 'waiting' });
    console.log(`[Signal] Room ${code} created`);
    res.json({ code, hostId });
  });

  app.post('/api/signal/join-room', (req, res) => {
    const { code } = req.body;
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const clientId = require('crypto').randomUUID();
    room.clientId = clientId;
    room.status = 'paired';
    console.log(`[Signal] Room ${code} joined`);
    res.json({ hostId: room.hostId, clientId, tvList: room.tvList });
  });

  app.post('/api/signal/send', (req, res) => {
    const { code, senderId, type, payload } = req.body;
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    room.signals.push({ senderId, type, payload, ts: Date.now() });
    if (type === 'tv-list') room.tvList = payload;
    console.log(`[Signal] Room ${code}: ${type} from ${senderId.substring(0, 8)}`);
    res.json({ ok: true });
  });

  app.get('/api/signal/poll', (req, res) => {
    const { code, senderId, lastIndex } = req.query;
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const idx = parseInt(lastIndex) || 0;
    const messages = room.signals.slice(idx).filter(m => m.senderId !== senderId);
    res.json({ messages, nextIndex: room.signals.length });
  });
};
