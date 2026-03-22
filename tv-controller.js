/**
 * TVController - Pure client-side TV control.
 * Connects directly from the browser to TVs on the local network.
 * No server needed. Supports LG (webOS) and Samsung smart TVs.
 */
(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────────────
  let currentTV = null;
  let ws = null;
  let registered = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let cmdId = 1;
  const MAX_RECONNECT = 5;
  const RECONNECT_DELAY = 3000;
  const STORAGE_KEY = 'remo_saved_tv';

  // ─── Key Mappings ──────────────────────────────────────────────────────────
  const LG_SSAP = {
    power:   { uri: 'ssap://system/turnOff' },
    volUp:   { uri: 'ssap://audio/volumeUp' },
    volDown: { uri: 'ssap://audio/volumeDown' },
    mute:    { uri: 'ssap://audio/setMute', payload: { mute: true } },
    chUp:    { uri: 'ssap://tv/channelUp' },
    chDown:  { uri: 'ssap://tv/channelDown' },
    up:      { btn: 'UP' },
    down:    { btn: 'DOWN' },
    left:    { btn: 'LEFT' },
    right:   { btn: 'RIGHT' },
    ok:      { btn: 'ENTER' },
    back:    { btn: 'BACK' },
    home:    { btn: 'HOME' },
    menu:    { btn: 'MENU' },
    play:    { uri: 'ssap://media.controls/play' },
    pause:   { uri: 'ssap://media.controls/pause' },
    rewind:  { uri: 'ssap://media.controls/rewind' },
    forward: { uri: 'ssap://media.controls/fastForward' },
    info:    { btn: 'INFO' },
    exit:    { btn: 'EXIT' },
    guide:   { uri: 'ssap://com.webos.service.livetv/openChannel' },
    num0: { btn: '0' }, num1: { btn: '1' }, num2: { btn: '2' },
    num3: { btn: '3' }, num4: { btn: '4' }, num5: { btn: '5' },
    num6: { btn: '6' }, num7: { btn: '7' }, num8: { btn: '8' }, num9: { btn: '9' },
    hdmi1: { uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_1' } },
    hdmi2: { uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_2' } },
    hdmi3: { uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_3' } },
    hdmi4: { uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_4' } },
    tv:    { uri: 'ssap://tv/switchInput', payload: { inputId: 'TV' } },
    av:    { uri: 'ssap://tv/switchInput', payload: { inputId: 'AV_1' } },
    component: { uri: 'ssap://tv/switchInput', payload: { inputId: 'COMP_1' } },
    usb:   { uri: 'ssap://tv/switchInput', payload: { inputId: 'USB_1' } },
  };

  const LG_APPS = {
    netflix: 'netflix', youtube: 'youtube.leanback.v4',
    prime: 'amazon', disney: 'com.disney.disneyplus-prod',
    hulu: 'hulu', appletv: 'com.apple.appletv',
  };

  const SAMSUNG_KEYS = {
    power: 'KEY_POWER', volUp: 'KEY_VOLUP', volDown: 'KEY_VOLDOWN',
    mute: 'KEY_MUTE', chUp: 'KEY_CHUP', chDown: 'KEY_CHDOWN',
    up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT',
    ok: 'KEY_ENTER', back: 'KEY_RETURN', home: 'KEY_HOME', menu: 'KEY_MENU',
    play: 'KEY_PLAY', pause: 'KEY_PAUSE', rewind: 'KEY_REWIND', forward: 'KEY_FF',
    info: 'KEY_INFO', exit: 'KEY_EXIT', guide: 'KEY_GUIDE',
    num0: 'KEY_0', num1: 'KEY_1', num2: 'KEY_2', num3: 'KEY_3', num4: 'KEY_4',
    num5: 'KEY_5', num6: 'KEY_6', num7: 'KEY_7', num8: 'KEY_8', num9: 'KEY_9',
    hdmi1: 'KEY_HDMI1', hdmi2: 'KEY_HDMI2', hdmi3: 'KEY_HDMI3', hdmi4: 'KEY_HDMI4',
    tv: 'KEY_TV', av: 'KEY_AV1', component: 'KEY_COMPONENT1', usb: 'KEY_USB',
  };

  const SAMSUNG_APPS = {
    netflix: 'Netflix', youtube: 'YouTube', prime: 'Amazon Prime Video',
    disney: 'Disney+', hulu: 'Hulu', appletv: 'Apple TV',
  };

  // ─── Events ────────────────────────────────────────────────────────────────
  const listeners = {};
  function on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); }
  function off(event, cb) { if (listeners[event]) listeners[event] = listeners[event].filter(c => c !== cb); }
  function emit(event, data) { (listeners[event] || []).forEach(cb => cb(data)); }

  // ─── LG Registration payload ──────────────────────────────────────────────
  function lgRegistration(clientKey) {
    return {
      type: 'register', id: 'register_0',
      payload: {
        pairingType: clientKey ? 'PROMPT' : 'PIN',
        'client-key': clientKey || '',
        manifest: {
          manifestVersion: 1, appVersion: '1.1', signed: {
            created: '20240101000000', appId: 'com.remo.remote',
            vendorId: 'com.remo',
            localizedAppNames: { '': 'Remo TV Remote' },
            localizedVendorNames: { '': 'Remo' },
            permissions: [
              'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CONTROL_AUDIO',
              'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
              'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT', 'CONTROL_INPUT_TV',
              'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'READ_APP_STATUS',
              'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS',
              'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST',
              'WRITE_NOTIFICATION'
            ],
            serial: 'remo-0001'
          },
          permissions: [
            'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CONTROL_AUDIO',
            'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
            'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT', 'CONTROL_INPUT_TV',
            'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'READ_APP_STATUS',
            'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS',
            'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST',
            'WRITE_NOTIFICATION'
          ]
        }
      }
    };
  }

  // ─── Saved TV ──────────────────────────────────────────────────────────────
  function getSavedTV() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(e) { return null; }
  }
  function saveTV(tv) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tv)); } catch(e) {}
  }
  function getSavedKey(ip) {
    try { return localStorage.getItem('remo_lgkey_' + ip) || ''; } catch(e) { return ''; }
  }
  function saveLGKey(ip, key) {
    try { localStorage.setItem('remo_lgkey_' + ip, key); } catch(e) {}
  }

  // ─── Probe TV brand by trying ports ────────────────────────────────────────
  function probeTV(ip) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };

      // Try LG WSS on port 3001
      const lgWs = new WebSocket('wss://' + ip + ':3001');
      lgWs.onopen = () => { lgWs.close(); done({ ip, brand: 'lg', name: 'LG TV', port: 3001, ssl: true }); };
      lgWs.onerror = () => {
        // Try LG WS on port 3000
        const lgWs2 = new WebSocket('ws://' + ip + ':3000');
        lgWs2.onopen = () => { lgWs2.close(); done({ ip, brand: 'lg', name: 'LG TV', port: 3000, ssl: false }); };
        lgWs2.onerror = () => {
          // Try Samsung WSS on port 8002
          const samWs = new WebSocket('wss://' + ip + ':8002/api/v2/channels/samsung.remote.control?name=cmVtbw==');
          samWs.onopen = () => { samWs.close(); done({ ip, brand: 'samsung', name: 'Samsung TV', port: 8002, ssl: true }); };
          samWs.onerror = () => {
            // Try Samsung WS on port 8001
            const samWs2 = new WebSocket('ws://' + ip + ':8001/api/v2/channels/samsung.remote.control?name=cmVtbw==');
            samWs2.onopen = () => { samWs2.close(); done({ ip, brand: 'samsung', name: 'Samsung TV', port: 8001, ssl: false }); };
            samWs2.onerror = () => { done(null); };
            setTimeout(() => { try { samWs2.close(); } catch(e){} }, 3000);
          };
          setTimeout(() => { try { samWs.close(); } catch(e){} }, 3000);
        };
        setTimeout(() => { try { lgWs2.close(); } catch(e){} }, 3000);
      };
      setTimeout(() => { try { lgWs.close(); } catch(e){} }, 3000);

      // Overall timeout
      setTimeout(() => done(null), 12000);
    });
  }

  // ─── Connect ───────────────────────────────────────────────────────────────
  function connect(tv) {
    if (ws) disconnect();
    currentTV = tv;
    registered = false;
    reconnectAttempts = 0;
    saveTV(tv);

    if (tv.brand === 'lg') return connectLG(tv);
    if (tv.brand === 'samsung') return connectSamsung(tv);
    return Promise.reject(new Error('Unsupported brand: ' + tv.brand));
  }

  function connectLG(tv) {
    return new Promise((resolve, reject) => {
      const proto = tv.ssl ? 'wss' : 'ws';
      const port = tv.port || (tv.ssl ? 3001 : 3000);
      const url = proto + '://' + tv.ip + ':' + port;

      console.log('[Remo] Connecting LG at ' + url);
      try {
        ws = new WebSocket(url);
      } catch(e) {
        // If WSS fails due to cert, emit event so UI can guide user
        emit('cert-needed', { ip: tv.ip, port: port, proto: proto });
        reject(new Error('WebSocket blocked — certificate not accepted'));
        return;
      }

      const timeout = setTimeout(() => {
        if (!registered) {
          try { ws.close(); } catch(e){}
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      ws.onopen = () => {
        console.log('[Remo] LG WebSocket open, registering...');
        const clientKey = getSavedKey(tv.ip);
        ws.send(JSON.stringify(lgRegistration(clientKey)));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('[Remo] LG msg:', msg.type, msg.id);

          // Registration response
          if (msg.id === 'register_0') {
            if (msg.type === 'registered') {
              // Success! Save the client key
              const key = msg.payload && msg.payload['client-key'];
              if (key) saveLGKey(tv.ip, key);
              registered = true;
              clearTimeout(timeout);
              reconnectAttempts = 0;
              emit('connected', { brand: 'lg', ip: tv.ip });
              resolve({ brand: 'lg', ip: tv.ip, connected: true });
            } else if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PIN') {
              // TV is showing a PIN
              emit('pin-required', { ip: tv.ip });
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(msg.error || 'Registration rejected'));
            }
          }

          // Forward other messages
          emit('message', msg);
        } catch (e) {
          // non-JSON message
        }
      };

      ws.onerror = (err) => {
        console.error('[Remo] LG WS error');
        // If this was WSS and failed, likely cert issue
        if (tv.ssl) {
          emit('cert-needed', { ip: tv.ip, port: port });
        }
        clearTimeout(timeout);
        emit('error', { type: 'connection', message: 'WebSocket error' });
        reject(new Error('Connection failed — see cert-needed event'));
      };

      ws.onclose = () => {
        console.log('[Remo] LG WS closed');
        if (registered) {
          emit('disconnected', { brand: 'lg' });
          attemptReconnect();
        }
        ws = null;
      };
    });
  }

  function connectSamsung(tv) {
    return new Promise((resolve, reject) => {
      const proto = tv.ssl ? 'wss' : 'ws';
      const port = tv.port || (tv.ssl ? 8002 : 8001);
      const name = btoa('Remo Remote');
      const url = proto + '://' + tv.ip + ':' + port + '/api/v2/channels/samsung.remote.control?name=' + name;

      console.log('[Remo] Connecting Samsung at ' + url);
      try {
        ws = new WebSocket(url);
      } catch(e) {
        emit('cert-needed', { ip: tv.ip, port: port });
        reject(new Error('WebSocket blocked'));
        return;
      }

      const timeout = setTimeout(() => {
        if (!registered) { try { ws.close(); } catch(e){} reject(new Error('Timeout')); }
      }, 8000);

      ws.onopen = () => {
        console.log('[Remo] Samsung WS open');
        registered = true;
        clearTimeout(timeout);
        emit('connected', { brand: 'samsung', ip: tv.ip });
        resolve({ brand: 'samsung', ip: tv.ip, connected: true });
      };

      ws.onmessage = (event) => {
        try { emit('message', JSON.parse(event.data)); } catch(e){}
      };

      ws.onerror = () => {
        if (tv.ssl) emit('cert-needed', { ip: tv.ip, port: port });
        clearTimeout(timeout);
        reject(new Error('Samsung connection failed'));
      };

      ws.onclose = () => {
        if (registered) { emit('disconnected', { brand: 'samsung' }); attemptReconnect(); }
        ws = null;
      };
    });
  }

  function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT || !currentTV) return;
    reconnectAttempts++;
    emit('reconnecting', { attempt: reconnectAttempts });
    reconnectTimer = setTimeout(() => {
      connect(currentTV).catch(() => {});
    }, RECONNECT_DELAY);
  }

  // ─── Send Key ──────────────────────────────────────────────────────────────
  function sendKey(key) {
    if (!currentTV || !ws || ws.readyState !== WebSocket.OPEN) return false;

    if (currentTV.brand === 'lg') {
      const mapping = LG_SSAP[key];
      if (!mapping) return false;

      if (mapping.btn) {
        // Use button type for d-pad, numbers, etc.
        ws.send(JSON.stringify({ type: 'button', name: mapping.btn }));
      } else {
        // Use SSAP request for system commands
        const cmd = { type: 'request', id: 'cmd_' + (cmdId++), uri: mapping.uri };
        if (mapping.payload) cmd.payload = mapping.payload;
        ws.send(JSON.stringify(cmd));
      }
      emit('keySent', { brand: 'lg', key });
      return true;
    }

    if (currentTV.brand === 'samsung') {
      const sKey = SAMSUNG_KEYS[key];
      if (!sKey) return false;
      ws.send(JSON.stringify({
        method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: sKey, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
      }));
      emit('keySent', { brand: 'samsung', key });
      return true;
    }

    return false;
  }

  // ─── Send PIN ──────────────────────────────────────────────────────────────
  function sendPin(pin) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({
      type: 'request', id: 'pin_0',
      uri: 'ssap://pairing/setPin',
      payload: { pin: String(pin) }
    }));
    return true;
  }

  // ─── Launch App ────────────────────────────────────────────────────────────
  function launchApp(appName) {
    if (!currentTV || !ws || ws.readyState !== WebSocket.OPEN) return false;
    const name = appName.toLowerCase().replace(/[\s+]/g, '');

    if (currentTV.brand === 'lg') {
      const appId = LG_APPS[name];
      if (!appId) return false;
      ws.send(JSON.stringify({
        type: 'request', id: 'launch_' + (cmdId++),
        uri: 'ssap://system.launcher/launch',
        payload: { id: appId }
      }));
      emit('appLaunched', { brand: 'lg', app: name });
      return true;
    }

    if (currentTV.brand === 'samsung') {
      const appId = SAMSUNG_APPS[name];
      if (!appId) return false;
      ws.send(JSON.stringify({
        method: 'ms.channel.emit',
        params: { event: 'ed.apps.launch', to: 'host', data: { appId, action_type: 'DEEP_LINK' } }
      }));
      emit('appLaunched', { brand: 'samsung', app: name });
      return true;
    }

    return false;
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────
  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = MAX_RECONNECT;
    if (ws) { try { ws.close(); } catch(e){} ws = null; }
    const prev = currentTV;
    currentTV = null;
    registered = false;
    emit('disconnected', { brand: prev && prev.brand });
  }

  // ─── Manual Connect ────────────────────────────────────────────────────────
  async function manualConnect(ip) {
    emit('probing', { ip });
    const tv = await probeTV(ip);
    if (!tv) throw new Error('No TV found at ' + ip);
    return tv;
  }

  // ─── Discovery (subnet scan) ───────────────────────────────────────────────
  async function discover() {
    // In pure client mode, we can't do SSDP. Instead try common IPs.
    // This is a best-effort scan of the local subnet.
    throw new Error('Auto-discovery requires entering your TV IP address');
  }

  // ─── Expose API ────────────────────────────────────────────────────────────
  window.TVController = {
    discover, connect, manualConnect, sendKey, sendPin, launchApp,
    disconnect, on, off, getSavedTV, probeTV,
    getStatus: () => ({
      connected: registered && ws && ws.readyState === WebSocket.OPEN,
      tv: currentTV, wsState: ws ? ws.readyState : null,
    }),
  };
})();
