const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { Client: SSDPClient } = require('node-ssdp');
const cors = require('cors');
const path = require('path');
const net = require('net');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = 3456;

// ─── Utility: fetch URL content (http or https) ───────────────────────────────

function fetchURL(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Utility: check if a TCP port is open ──────────────────────────────────────

function checkPort(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

// ─── Utility: extract friendly name from UPnP XML ─────────────────────────────

function extractFriendlyName(xml) {
  const match = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/);
  return match ? match[1] : 'Unknown TV';
}

function extractModelName(xml) {
  const match = xml.match(/<modelName>([^<]+)<\/modelName>/);
  return match ? match[1] : '';
}

// ─── Utility: detect brand from SSDP headers / ST ──────────────────────────────

function detectBrand(headers, st) {
  const combined = JSON.stringify(headers).toLowerCase() + (st || '').toLowerCase();
  if (combined.includes('samsung')) return 'samsung';
  if (combined.includes('lge') || combined.includes('webos') || combined.includes('lg')) return 'lg';
  if (combined.includes('roku')) return 'roku';
  return 'unknown';
}

// ─── Utility: get local subnet prefix ──────────────────────────────────────────

function getLocalSubnet() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        return parts.slice(0, 3).join('.');
      }
    }
  }
  return '192.168.1';
}

// ─── GET /api/discover ─────────────────────────────────────────────────────────

app.get('/api/discover', async (req, res) => {
  console.log('[Discover] Starting TV scan...');

  const tvs = new Map(); // keyed by IP to deduplicate
  const ssdpClient = new SSDPClient();

  const serviceTypes = [
    'urn:samsung.com:service:MainTVAgent2:1',
    'urn:lge-com:service:webos-second-screen:1',
    'urn:roku-com:device:player:1-0',
    'urn:schemas-upnp-org:device:MediaRenderer:1',
  ];

  const ssdpPromise = new Promise((resolve) => {
    ssdpClient.on('response', async (headers, statusCode, rinfo) => {
      const ip = rinfo.address;
      if (tvs.has(ip)) return;

      const brand = detectBrand(headers, headers.ST);
      if (brand === 'unknown' && !headers.ST?.includes('MediaRenderer')) return;

      let name = 'Unknown TV';
      let model = '';

      // Try to fetch device description XML
      const location = headers.LOCATION;
      if (location) {
        try {
          const xml = await fetchURL(location, 3000);
          name = extractFriendlyName(xml);
          model = extractModelName(xml);
        } catch (e) {
          console.log(`[Discover] Could not fetch description from ${location}`);
        }
      }

      const tv = { ip, name, brand, model };
      tvs.set(ip, tv);
      console.log(`[Discover] Found TV: ${JSON.stringify(tv)}`);
    });

    // Search for each service type
    for (const st of serviceTypes) {
      ssdpClient.search(st);
    }

    // Timeout after 5 seconds
    setTimeout(() => {
      ssdpClient.stop();
      resolve();
    }, 5000);
  });

  await ssdpPromise;

  // If SSDP found nothing, try port-scanning the local subnet
  if (tvs.size === 0) {
    console.log('[Discover] SSDP found nothing, scanning local subnet...');
    const subnet = getLocalSubnet();
    const scanPromises = [];

    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      scanPromises.push(
        (async () => {
          // Check Samsung port 8001
          if (await checkPort(ip, 8001, 1500)) {
            try {
              const data = await fetchURL(`http://${ip}:8001/api/v2/`, 2000);
              const info = JSON.parse(data);
              tvs.set(ip, {
                ip,
                name: info.device?.name || info.name || 'Samsung TV',
                brand: 'samsung',
                model: info.device?.modelName || '',
              });
              console.log(`[Discover] Found Samsung TV at ${ip}`);
            } catch (e) {
              tvs.set(ip, { ip, name: 'Samsung TV', brand: 'samsung', model: '' });
            }
            return;
          }
          // Check LG port 3000
          if (await checkPort(ip, 3000, 1500)) {
            tvs.set(ip, { ip, name: 'LG TV', brand: 'lg', model: '' });
            console.log(`[Discover] Found LG TV at ${ip}`);
            return;
          }
          // Check Roku port 8060
          if (await checkPort(ip, 8060, 1500)) {
            try {
              const xml = await fetchURL(`http://${ip}:8060/`, 2000);
              const name = extractFriendlyName(xml);
              const model = extractModelName(xml);
              tvs.set(ip, { ip, name: name || 'Roku TV', brand: 'roku', model });
              console.log(`[Discover] Found Roku at ${ip}`);
            } catch (e) {
              tvs.set(ip, { ip, name: 'Roku TV', brand: 'roku', model: '' });
            }
          }
        })()
      );
    }

    // Wait for all port scans with a 5-second overall timeout
    await Promise.race([
      Promise.allSettled(scanPromises),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  const result = Array.from(tvs.values());
  console.log(`[Discover] Scan complete. Found ${result.length} TV(s).`);
  res.json(result);
});

// ─── POST /api/connect (manual connect) ────────────────────────────────────────

app.post('/api/connect', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP address required' });

  console.log(`[Connect] Attempting to detect TV at ${ip}...`);

  // Try Samsung
  try {
    if (await checkPort(ip, 8001, 3000)) {
      const data = await fetchURL(`http://${ip}:8001/api/v2/`, 3000);
      const info = JSON.parse(data);
      const result = {
        brand: 'samsung',
        name: info.device?.name || info.name || 'Samsung TV',
        ip,
      };
      console.log(`[Connect] Detected Samsung: ${JSON.stringify(result)}`);
      return res.json(result);
    }
  } catch (e) {
    // Not Samsung, try next
  }

  // Try LG (SSL port 3001 first, then plain 3000)
  try {
    if (await checkPort(ip, 3001, 3000) || await checkPort(ip, 3000, 3000)) {
      const result = { brand: 'lg', name: 'LG TV', ip };
      console.log(`[Connect] Detected LG: ${JSON.stringify(result)}`);
      return res.json(result);
    }
  } catch (e) {
    // Not LG, try next
  }

  // Try Roku
  try {
    if (await checkPort(ip, 8060, 3000)) {
      let name = 'Roku TV';
      try {
        const xml = await fetchURL(`http://${ip}:8060/`, 2000);
        name = extractFriendlyName(xml) || name;
      } catch (e) {}
      const result = { brand: 'roku', name, ip };
      console.log(`[Connect] Detected Roku: ${JSON.stringify(result)}`);
      return res.json(result);
    }
  } catch (e) {
    // Not Roku either
  }

  console.log(`[Connect] No TV detected at ${ip}`);
  res.status(404).json({ error: 'No TV detected at this IP address' });
});

// ─── POST /api/roku/command ────────────────────────────────────────────────────

app.post('/api/roku/command', async (req, res) => {
  const { ip, key, appId } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });

  let rokuPath;
  if (appId) {
    rokuPath = `/launch/${appId}`;
  } else if (key) {
    rokuPath = `/keypress/${key}`;
  } else {
    return res.status(400).json({ error: 'key or appId required' });
  }

  console.log(`[Roku] Sending command to ${ip}: ${rokuPath}`);

  const rokuReq = http.request(
    {
      hostname: ip,
      port: 8060,
      path: rokuPath,
      method: 'POST',
      timeout: 3000,
    },
    (rokuRes) => {
      res.json({ success: true, statusCode: rokuRes.statusCode });
    }
  );

  rokuReq.on('error', (err) => {
    console.error(`[Roku] Error sending command: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  rokuReq.on('timeout', () => {
    rokuReq.destroy();
    res.status(504).json({ error: 'Roku command timed out' });
  });

  rokuReq.end();
});

// ─── WebSocket upgrade handling ────────────────────────────────────────────────

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/api/samsung/ws') {
    const ip = url.searchParams.get('ip');
    if (!ip) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      handleSamsungProxy(clientWs, ip);
    });
  } else if (url.pathname === '/api/lg/ws') {
    const ip = url.searchParams.get('ip');
    if (!ip) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      handleLGProxy(clientWs, ip);
    });
  } else {
    socket.destroy();
  }
});

// ─── Samsung WebSocket Proxy ───────────────────────────────────────────────────

function handleSamsungProxy(clientWs, ip) {
  const appName = Buffer.from('Remo').toString('base64');
  const tvUrl = `ws://${ip}:8001/api/v2/channels/samsung.remote.control?name=${appName}`;

  console.log(`[Samsung WS] Connecting to TV at ${tvUrl}`);

  let tvWs;
  let reconnectTimer = null;
  let closed = false;

  function connectToTV() {
    tvWs = new WebSocket(tvUrl, { handshakeTimeout: 3000 });

    tvWs.on('open', () => {
      console.log(`[Samsung WS] Connected to TV at ${ip}`);
      clientWs.send(JSON.stringify({ event: 'connected', brand: 'samsung', ip }));
    });

    tvWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString());
      }
    });

    tvWs.on('close', () => {
      console.log(`[Samsung WS] TV connection closed for ${ip}`);
      if (!closed) {
        clientWs.send(JSON.stringify({ event: 'tv_disconnected' }));
        reconnectTimer = setTimeout(connectToTV, 3000);
      }
    });

    tvWs.on('error', (err) => {
      console.error(`[Samsung WS] Error: ${err.message}`);
      tvWs.close();
    });
  }

  connectToTV();

  clientWs.on('message', (data) => {
    console.log(`[Samsung WS] Client -> TV: ${data}`);
    if (tvWs && tvWs.readyState === WebSocket.OPEN) {
      tvWs.send(data.toString());
    }
  });

  clientWs.on('close', () => {
    console.log(`[Samsung WS] Client disconnected for ${ip}`);
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tvWs) tvWs.close();
  });

  clientWs.on('error', (err) => {
    console.error(`[Samsung WS] Client error: ${err.message}`);
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tvWs) tvWs.close();
  });
}

// ─── LG WebSocket Proxy ───────────────────────────────────────────────────────

function handleLGProxy(clientWs, ip) {
  // Try SSL (3001) first, fall back to plain (3000)
  let tvUrl = `wss://${ip}:3001`;
  let useSSL = true;

  console.log(`[LG WS] Connecting to TV at ${tvUrl}`);

  let tvWs;
  let reconnectTimer = null;
  let closed = false;
  let pointerSocket = null;

  const LG_REGISTRATION = {
    type: 'register',
    id: 'register_0',
    payload: {
      pairingType: 'PROMPT',
      'client-key': '',
      manifest: {
        manifestVersion: 1,
        appVersion: '1.0',
        signed: {
          created: '20240101000000',
          appId: 'com.remo.remote',
          vendorId: 'com.remo',
          localizedAppNames: { '': 'Remo Remote' },
          localizedVendorNames: { '': 'Remo' },
          permissions: [
            'LAUNCH',
            'LAUNCH_WEBAPP',
            'APP_TO_APP',
            'CONTROL_AUDIO',
            'CONTROL_DISPLAY',
            'CONTROL_INPUT_JOYSTICK',
            'CONTROL_INPUT_MEDIA_RECORDING',
            'CONTROL_INPUT_MEDIA_PLAYBACK',
            'CONTROL_INPUT_TV',
            'CONTROL_POWER',
            'READ_APP_STATUS',
            'READ_CURRENT_CHANNEL',
            'READ_INPUT_DEVICE_LIST',
            'READ_NETWORK_STATE',
            'READ_RUNNING_APPS',
            'READ_TV_CHANNEL_LIST',
            'WRITE_NOTIFICATION_TOAST',
            'CONTROL_INPUT_TEXT',
            'CONTROL_MOUSE_AND_KEYBOARD',
            'READ_INSTALLED_APPS',
            'READ_LGE_TV_INPUT_EVENTS',
            'READ_TV_CURRENT_TIME',
          ],
          serial: 'remo_001',
        },
        permissions: [
          'LAUNCH',
          'LAUNCH_WEBAPP',
          'APP_TO_APP',
          'CONTROL_AUDIO',
          'CONTROL_DISPLAY',
          'CONTROL_INPUT_JOYSTICK',
          'CONTROL_INPUT_MEDIA_RECORDING',
          'CONTROL_INPUT_MEDIA_PLAYBACK',
          'CONTROL_INPUT_TV',
          'CONTROL_POWER',
          'READ_APP_STATUS',
          'READ_CURRENT_CHANNEL',
          'READ_INPUT_DEVICE_LIST',
          'READ_NETWORK_STATE',
          'READ_RUNNING_APPS',
          'READ_TV_CHANNEL_LIST',
          'WRITE_NOTIFICATION_TOAST',
          'CONTROL_INPUT_TEXT',
          'CONTROL_MOUSE_AND_KEYBOARD',
          'READ_INSTALLED_APPS',
          'READ_LGE_TV_INPUT_EVENTS',
          'READ_TV_CURRENT_TIME',
        ],
      },
    },
  };

  function connectToTV() {
    tvWs = new WebSocket(tvUrl, { handshakeTimeout: 5000, rejectUnauthorized: false });

    tvWs.on('open', () => {
      console.log(`[LG WS] Connected to TV at ${tvUrl}`);
      // Send registration/handshake
      tvWs.send(JSON.stringify(LG_REGISTRATION));
      clientWs.send(JSON.stringify({ event: 'connected', brand: 'lg', ip }));
    });

    tvWs.on('message', (data) => {
      const msg = data.toString();
      console.log(`[LG WS] TV -> Client: ${msg.substring(0, 200)}`);

      // Check if this is a pointer socket response
      try {
        const parsed = JSON.parse(msg);
        if (parsed.id === 'pointer_0' && parsed.payload?.socketPath) {
          // Connect to the pointer input socket
          const pointerUrl = parsed.payload.socketPath.replace(
            'localhost',
            ip
          );
          pointerSocket = new WebSocket(pointerUrl);
          pointerSocket.on('open', () => {
            console.log(`[LG WS] Pointer socket connected for ${ip}`);
          });
          pointerSocket.on('error', (err) => {
            console.error(`[LG WS] Pointer socket error: ${err.message}`);
          });
        }

        // If registration succeeded and has a client-key, forward it
        if (parsed.type === 'registered' && parsed.payload?.['client-key']) {
          console.log(`[LG WS] Registered with key: ${parsed.payload['client-key']}`);
        }
      } catch (e) {
        // Not JSON, forward as-is
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg);
      }
    });

    tvWs.on('close', () => {
      console.log(`[LG WS] TV connection closed for ${ip}`);
      if (!closed) {
        clientWs.send(JSON.stringify({ event: 'tv_disconnected' }));
        reconnectTimer = setTimeout(connectToTV, 3000);
      }
    });

    tvWs.on('error', (err) => {
      console.error(`[LG WS] Error on ${tvUrl}: ${err.message}`);
      // If SSL failed, try plain WS on port 3000
      if (useSSL && (err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT'))) {
        useSSL = false;
        tvUrl = `ws://${ip}:3000`;
        console.log(`[LG WS] Retrying with plain WS: ${tvUrl}`);
        connectToTV();
        return;
      }
      tvWs.close();
    });
  }

  connectToTV();

  clientWs.on('message', (data) => {
    const msg = data.toString();
    console.log(`[LG WS] Client -> TV: ${msg}`);

    try {
      const parsed = JSON.parse(msg);

      // If it's a button press, send via pointer socket if available
      if (parsed.type === 'button' && pointerSocket && pointerSocket.readyState === WebSocket.OPEN) {
        pointerSocket.send(msg);
        return;
      }
    } catch (e) {
      // Not JSON
    }

    if (tvWs && tvWs.readyState === WebSocket.OPEN) {
      tvWs.send(msg);
    }
  });

  clientWs.on('close', () => {
    console.log(`[LG WS] Client disconnected for ${ip}`);
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tvWs) tvWs.close();
    if (pointerSocket) pointerSocket.close();
  });

  clientWs.on('error', (err) => {
    console.error(`[LG WS] Client error: ${err.message}`);
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tvWs) tvWs.close();
    if (pointerSocket) pointerSocket.close();
  });
}

// ─── Start server ──────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Remo] Server running at http://localhost:${PORT}`);
  console.log(`[Remo] Serving static files from ${__dirname}`);
});
