/**
 * TVController - Client-side module for controlling TVs via the Remo server.
 * Exposes window.TVController
 */
(function () {
  'use strict';

  const SERVER = `${window.location.protocol}//${window.location.hostname}:3456`;
  const WS_SERVER = `ws://${window.location.hostname}:3456`;

  // ─── State ─────────────────────────────────────────────────────────────────

  let currentTV = null; // { ip, brand, name }
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 3000;

  // ─── Key Mappings ──────────────────────────────────────────────────────────

  const SAMSUNG_KEYS = {
    power: 'KEY_POWER',
    volUp: 'KEY_VOLUP',
    volDown: 'KEY_VOLDOWN',
    mute: 'KEY_MUTE',
    chUp: 'KEY_CHUP',
    chDown: 'KEY_CHDOWN',
    up: 'KEY_UP',
    down: 'KEY_DOWN',
    left: 'KEY_LEFT',
    right: 'KEY_RIGHT',
    ok: 'KEY_ENTER',
    back: 'KEY_RETURN',
    home: 'KEY_HOME',
    menu: 'KEY_MENU',
    play: 'KEY_PLAY',
    pause: 'KEY_PAUSE',
    rewind: 'KEY_REWIND',
    forward: 'KEY_FF',
    info: 'KEY_INFO',
    exit: 'KEY_EXIT',
    num0: 'KEY_0',
    num1: 'KEY_1',
    num2: 'KEY_2',
    num3: 'KEY_3',
    num4: 'KEY_4',
    num5: 'KEY_5',
    num6: 'KEY_6',
    num7: 'KEY_7',
    num8: 'KEY_8',
    num9: 'KEY_9',
  };

  const LG_KEYS = {
    power: 'POWER',
    volUp: 'VOLUMEUP',
    volDown: 'VOLUMEDOWN',
    mute: 'MUTE',
    chUp: 'CHANNELUP',
    chDown: 'CHANNELDOWN',
    up: 'UP',
    down: 'DOWN',
    left: 'LEFT',
    right: 'RIGHT',
    ok: 'ENTER',
    back: 'BACK',
    home: 'HOME',
    menu: 'MENU',
    play: 'PLAY',
    pause: 'PAUSE',
    rewind: 'REWIND',
    forward: 'FASTFORWARD',
    info: 'INFO',
    exit: 'EXIT',
    num0: '0',
    num1: '1',
    num2: '2',
    num3: '3',
    num4: '4',
    num5: '5',
    num6: '6',
    num7: '7',
    num8: '8',
    num9: '9',
  };

  const ROKU_KEYS = {
    power: 'Power',
    volUp: 'VolumeUp',
    volDown: 'VolumeDown',
    mute: 'VolumeMute',
    chUp: 'ChannelUp',
    chDown: 'ChannelDown',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    ok: 'Select',
    back: 'Back',
    home: 'Home',
    menu: 'Info',
    play: 'Play',
    pause: 'Play',
    rewind: 'Rev',
    forward: 'Fwd',
    info: 'Info',
    exit: 'Home',
    num0: 'Lit_0',
    num1: 'Lit_1',
    num2: 'Lit_2',
    num3: 'Lit_3',
    num4: 'Lit_4',
    num5: 'Lit_5',
    num6: 'Lit_6',
    num7: 'Lit_7',
    num8: 'Lit_8',
    num9: 'Lit_9',
  };

  // ─── App Mappings ──────────────────────────────────────────────────────────

  const SAMSUNG_APPS = {
    netflix: 'Netflix',
    youtube: 'YouTube',
    prime: 'Amazon Prime Video',
    disney: 'Disney+',
    hulu: 'Hulu',
    appletv: 'Apple TV',
  };

  const LG_APPS = {
    netflix: 'netflix',
    youtube: 'youtube.leanback.v4',
    prime: 'amazon',
    disney: 'com.disney.disneyplus-prod',
    hulu: 'hulu',
    appletv: 'com.apple.appletv',
  };

  const ROKU_APPS = {
    netflix: '12',
    youtube: '837',
    prime: '13',
    disney: '291097',
    hulu: '2285',
    appletv: '551012',
  };

  // ─── Event listeners ──────────────────────────────────────────────────────

  const listeners = {};

  function on(event, callback) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
  }

  function off(event, callback) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter((cb) => cb !== callback);
  }

  function emit(event, data) {
    if (listeners[event]) {
      listeners[event].forEach((cb) => cb(data));
    }
  }

  // ─── Discover ──────────────────────────────────────────────────────────────

  async function discover() {
    try {
      const response = await fetch(`${SERVER}/api/discover`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tvs = await response.json();
      emit('discovered', tvs);
      return tvs;
    } catch (err) {
      console.error('[TVController] Discovery failed:', err);
      emit('error', { type: 'discover', message: err.message });
      return [];
    }
  }

  // ─── Connect ───────────────────────────────────────────────────────────────

  async function connect(tv) {
    if (ws) {
      disconnect();
    }

    currentTV = tv;
    reconnectAttempts = 0;

    if (tv.brand === 'samsung') {
      return connectWebSocket(`${WS_SERVER}/api/samsung/ws?ip=${tv.ip}`);
    } else if (tv.brand === 'lg') {
      return connectWebSocket(`${WS_SERVER}/api/lg/ws?ip=${tv.ip}`);
    } else if (tv.brand === 'roku') {
      // Roku uses REST calls, no persistent WebSocket needed
      emit('connected', { brand: 'roku', ip: tv.ip });
      return { brand: 'roku', ip: tv.ip, connected: true };
    }

    throw new Error(`Unsupported brand: ${tv.brand}`);
  }

  function connectWebSocket(url) {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      ws.onopen = () => {
        console.log('[TVController] WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.event === 'connected') {
            clearTimeout(timeout);
            reconnectAttempts = 0;
            emit('connected', msg);
            resolve({ brand: msg.brand, ip: msg.ip, connected: true });
          } else if (msg.event === 'tv_disconnected') {
            emit('tv_disconnected', msg);
            attemptReconnect();
          } else {
            emit('message', msg);
          }
        } catch (e) {
          emit('message', event.data);
        }
      };

      ws.onclose = () => {
        console.log('[TVController] WebSocket closed');
        emit('disconnected', { brand: currentTV?.brand });
        ws = null;
      };

      ws.onerror = (err) => {
        console.error('[TVController] WebSocket error:', err);
        clearTimeout(timeout);
        emit('error', { type: 'connection', message: 'WebSocket error' });
      };
    });
  }

  function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS || !currentTV) return;
    reconnectAttempts++;
    console.log(
      `[TVController] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`
    );
    emit('reconnecting', { attempt: reconnectAttempts });
    reconnectTimer = setTimeout(() => {
      connect(currentTV).catch((err) => {
        console.error('[TVController] Reconnect failed:', err);
      });
    }, RECONNECT_DELAY);
  }

  // ─── Send Key ──────────────────────────────────────────────────────────────

  async function sendKey(key) {
    if (!currentTV) {
      console.error('[TVController] No TV connected');
      return false;
    }

    const brand = currentTV.brand;
    console.log(`[TVController] Sending key "${key}" to ${brand} TV`);

    if (brand === 'samsung') {
      return sendSamsungKey(key);
    } else if (brand === 'lg') {
      return sendLGKey(key);
    } else if (brand === 'roku') {
      return sendRokuKey(key);
    }

    return false;
  }

  function sendSamsungKey(key) {
    const samsungKey = SAMSUNG_KEYS[key];
    if (!samsungKey) {
      console.warn(`[TVController] Unknown Samsung key: ${key}`);
      return false;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[TVController] Samsung WebSocket not connected');
      return false;
    }

    const cmd = {
      method: 'ms.remote.control',
      params: {
        Cmd: 'Click',
        DataOfCmd: samsungKey,
        Option: 'false',
        TypeOfRemote: 'SendRemoteKey',
      },
    };

    ws.send(JSON.stringify(cmd));
    emit('keySent', { brand: 'samsung', key, mapped: samsungKey });
    return true;
  }

  function sendLGKey(key) {
    const lgKey = LG_KEYS[key];
    if (!lgKey) {
      console.warn(`[TVController] Unknown LG key: ${key}`);
      return false;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[TVController] LG WebSocket not connected');
      return false;
    }

    const cmd = { type: 'button', name: lgKey };
    ws.send(JSON.stringify(cmd));
    emit('keySent', { brand: 'lg', key, mapped: lgKey });
    return true;
  }

  async function sendRokuKey(key) {
    const rokuKey = ROKU_KEYS[key];
    if (!rokuKey) {
      console.warn(`[TVController] Unknown Roku key: ${key}`);
      return false;
    }

    try {
      const response = await fetch(`${SERVER}/api/roku/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: currentTV.ip, key: rokuKey }),
      });
      const result = await response.json();
      emit('keySent', { brand: 'roku', key, mapped: rokuKey });
      return result.success;
    } catch (err) {
      console.error('[TVController] Roku command failed:', err);
      emit('error', { type: 'command', message: err.message });
      return false;
    }
  }

  // ─── Launch App ────────────────────────────────────────────────────────────

  async function launchApp(appName) {
    if (!currentTV) {
      console.error('[TVController] No TV connected');
      return false;
    }

    const brand = currentTV.brand;
    const normalizedName = appName.toLowerCase().replace(/[\s+]/g, '');
    console.log(`[TVController] Launching "${appName}" on ${brand} TV`);

    if (brand === 'samsung') {
      return launchSamsungApp(normalizedName);
    } else if (brand === 'lg') {
      return launchLGApp(normalizedName);
    } else if (brand === 'roku') {
      return launchRokuApp(normalizedName);
    }

    return false;
  }

  function launchSamsungApp(appName) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[TVController] Samsung WebSocket not connected');
      return false;
    }

    const appId = SAMSUNG_APPS[appName];
    if (!appId) {
      console.warn(`[TVController] Unknown Samsung app: ${appName}`);
      return false;
    }

    const cmd = {
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        data: {
          appId: appId,
          action_type: 'DEEP_LINK',
        },
      },
    };

    ws.send(JSON.stringify(cmd));
    emit('appLaunched', { brand: 'samsung', app: appName });
    return true;
  }

  function launchLGApp(appName) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[TVController] LG WebSocket not connected');
      return false;
    }

    const appId = LG_APPS[appName];
    if (!appId) {
      console.warn(`[TVController] Unknown LG app: ${appName}`);
      return false;
    }

    const cmd = {
      type: 'request',
      id: `launch_${Date.now()}`,
      uri: 'ssap://system.launcher/launch',
      payload: { id: appId },
    };

    ws.send(JSON.stringify(cmd));
    emit('appLaunched', { brand: 'lg', app: appName });
    return true;
  }

  async function launchRokuApp(appName) {
    const appId = ROKU_APPS[appName];
    if (!appId) {
      console.warn(`[TVController] Unknown Roku app: ${appName}`);
      return false;
    }

    try {
      const response = await fetch(`${SERVER}/api/roku/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: currentTV.ip, appId }),
      });
      const result = await response.json();
      emit('appLaunched', { brand: 'roku', app: appName });
      return result.success;
    } catch (err) {
      console.error('[TVController] Roku app launch failed:', err);
      emit('error', { type: 'launch', message: err.message });
      return false;
    }
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect

    if (ws) {
      ws.close();
      ws = null;
    }

    const prev = currentTV;
    currentTV = null;
    emit('disconnected', { brand: prev?.brand });
    console.log('[TVController] Disconnected');
  }

  // ─── Manual Connect ────────────────────────────────────────────────────────

  async function manualConnect(ip) {
    try {
      const response = await fetch(`${SERVER}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tv = await response.json();
      return connect(tv);
    } catch (err) {
      console.error('[TVController] Manual connect failed:', err);
      emit('error', { type: 'connect', message: err.message });
      throw err;
    }
  }

  // ─── LG-specific: request pointer input socket ─────────────────────────────

  function requestPointerSocket() {
    if (!ws || ws.readyState !== WebSocket.OPEN || currentTV?.brand !== 'lg') {
      return false;
    }
    const cmd = {
      type: 'request',
      id: 'pointer_0',
      uri: 'ssap://com.webos.service.networkinput/getPointerInputSocket',
    };
    ws.send(JSON.stringify(cmd));
    return true;
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  function getStatus() {
    return {
      connected: currentTV !== null && (currentTV.brand === 'roku' || (ws && ws.readyState === WebSocket.OPEN)),
      tv: currentTV,
      wsState: ws ? ws.readyState : null,
    };
  }

  // ─── Expose API ────────────────────────────────────────────────────────────

  window.TVController = {
    discover,
    connect,
    manualConnect,
    sendKey,
    launchApp,
    disconnect,
    requestPointerSocket,
    getStatus,
    on,
    off,
  };
})();
