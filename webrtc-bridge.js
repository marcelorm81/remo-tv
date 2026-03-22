(function() {
  const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
  const API_BASE = ''; // same origin (localhost:3456)

  class BridgeAgent {
    constructor() {
      this.roomCode = null;
      this.hostId = null;
      this.pc = null;
      this.dataChannel = null;
      this.tvWs = null; // WebSocket to TV via local server proxy
      this.tvBrand = null;
      this.tvIp = null;
      this.pollTimer = null;
      this.heartbeatTimer = null;
      this.lastSignalIndex = 0;
      this.onStatusChange = null;
      this.onCommand = null;
    }

    async connectTV(ip, brand) {
      this.tvIp = ip;
      this.tvBrand = brand;

      return new Promise((resolve, reject) => {
        var wsUrl = brand === 'samsung'
          ? 'ws://localhost:3456/api/samsung/ws?ip=' + ip
          : 'ws://localhost:3456/api/lg/ws?ip=' + ip;

        if (brand === 'roku') {
          // Roku uses REST, no persistent connection needed
          this.tvWs = null;
          resolve({ ip: ip, brand: brand, name: 'Roku TV' });
          return;
        }

        this.tvWs = new WebSocket(wsUrl);
        var self = this;
        var resolved = false;

        this.tvWs.onopen = function() {
          console.log('[Bridge] TV WebSocket open');
        };

        this.tvWs.onmessage = function(e) {
          var data;
          try { data = JSON.parse(e.data); } catch(err) { return; }

          if (!resolved && data.event === 'connected') {
            resolved = true;
            resolve({ ip: ip, brand: brand, name: data.name || (brand.toUpperCase() + ' TV') });
          }

          // Forward TV responses to remote if data channel is open
          if (self.dataChannel && self.dataChannel.readyState === 'open') {
            self.dataChannel.send(JSON.stringify({ type: 'tv-event', data: data }));
          }
        };

        this.tvWs.onerror = function() {
          if (!resolved) {
            resolved = true;
            reject(new Error('TV connection failed'));
          }
        };

        setTimeout(function() {
          if (!resolved) {
            resolved = true;
            reject(new Error('TV connection timeout'));
          }
        }, 10000);
      });
    }

    async createRoom() {
      var res = await fetch(API_BASE + '/api/signal/create-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      var data = await res.json();
      this.roomCode = data.code;
      this.hostId = data.hostId;
      this.startPolling();
      return data.code;
    }

    startPolling() {
      var self = this;
      this.pollTimer = setInterval(async function() {
        try {
          var res = await fetch(
            API_BASE + '/api/signal/poll?code=' + self.roomCode +
            '&senderId=' + self.hostId +
            '&lastIndex=' + self.lastSignalIndex
          );
          var data = await res.json();
          self.lastSignalIndex = data.nextIndex;

          for (var i = 0; i < data.messages.length; i++) {
            var msg = data.messages[i];
            if (msg.type === 'offer') await self.handleOffer(msg.payload);
            if (msg.type === 'ice-candidate') await self.handleIceCandidate(msg.payload);
            if (msg.type === 'joined') {
              if (self.onStatusChange) self.onStatusChange('Remote connected, establishing P2P...');
            }
          }
        } catch(e) {
          console.error('[Bridge] Poll error:', e);
        }
      }, 1000);
    }

    async handleOffer(offer) {
      var self = this;
      this.pc = new RTCPeerConnection({ iceServers: [STUN] });

      this.pc.ondatachannel = function(e) {
        self.dataChannel = e.channel;
        self.setupDataChannel();
      };

      this.pc.onicecandidate = function(e) {
        if (e.candidate) {
          fetch(API_BASE + '/api/signal/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: self.roomCode,
              senderId: self.hostId,
              type: 'ice-candidate',
              payload: e.candidate
            })
          });
        }
      };

      this.pc.onconnectionstatechange = function() {
        if (self.onStatusChange) self.onStatusChange('WebRTC: ' + self.pc.connectionState);
        if (self.pc.connectionState === 'connected') {
          clearInterval(self.pollTimer); // Stop polling once connected
        }
      };

      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      var answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      await fetch(API_BASE + '/api/signal/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: self.roomCode,
          senderId: self.hostId,
          type: 'answer',
          payload: answer
        })
      });
    }

    async handleIceCandidate(candidate) {
      if (this.pc) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    }

    setupDataChannel() {
      var self = this;

      this.dataChannel.onopen = function() {
        console.log('[Bridge] Data channel open!');
        if (self.onStatusChange) self.onStatusChange('Connected! Relaying commands...');
        // Start heartbeat
        self.heartbeatTimer = setInterval(function() {
          if (self.dataChannel && self.dataChannel.readyState === 'open') {
            self.dataChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
          }
        }, 5000);
      };

      this.dataChannel.onmessage = function(e) {
        var cmd = JSON.parse(e.data);
        if (cmd.type === 'pong') return;
        if (self.onCommand) self.onCommand(cmd);
        self.relayCommand(cmd);
      };

      this.dataChannel.onclose = function() {
        if (self.onStatusChange) self.onStatusChange('Remote disconnected');
        clearInterval(self.heartbeatTimer);
        // Resume polling for reconnection
        self.startPolling();
      };
    }

    relayCommand(cmd) {
      if (cmd.type === 'key') {
        this.sendTVKey(cmd.key);
      } else if (cmd.type === 'app') {
        this.launchTVApp(cmd.app);
      }
    }

    sendTVKey(key) {
      var SAMSUNG_KEYS = {
        power:'KEY_POWER',volUp:'KEY_VOLUP',volDown:'KEY_VOLDOWN',mute:'KEY_MUTE',
        chUp:'KEY_CHUP',chDown:'KEY_CHDOWN',up:'KEY_UP',down:'KEY_DOWN',left:'KEY_LEFT',
        right:'KEY_RIGHT',ok:'KEY_ENTER',back:'KEY_RETURN',home:'KEY_HOME',menu:'KEY_MENU',
        play:'KEY_PLAY',pause:'KEY_PAUSE',rewind:'KEY_REWIND',forward:'KEY_FF',
        info:'KEY_INFO',exit:'KEY_EXIT',
        num0:'KEY_0',num1:'KEY_1',num2:'KEY_2',num3:'KEY_3',num4:'KEY_4',
        num5:'KEY_5',num6:'KEY_6',num7:'KEY_7',num8:'KEY_8',num9:'KEY_9',
        guide:'KEY_GUIDE'
      };
      var LG_KEYS = {
        power:'POWER',volUp:'VOLUMEUP',volDown:'VOLUMEDOWN',mute:'MUTE',
        chUp:'CHANNELUP',chDown:'CHANNELDOWN',up:'UP',down:'DOWN',left:'LEFT',
        right:'RIGHT',ok:'ENTER',back:'BACK',home:'HOME',menu:'MENU',
        play:'PLAY',pause:'PAUSE',rewind:'REWIND',forward:'FASTFORWARD',
        info:'INFO',exit:'EXIT',
        num0:'0',num1:'1',num2:'2',num3:'3',num4:'4',
        num5:'5',num6:'6',num7:'7',num8:'8',num9:'9',
        guide:'GUIDE'
      };
      var ROKU_KEYS = {
        power:'Power',volUp:'VolumeUp',volDown:'VolumeDown',mute:'VolumeMute',
        chUp:'ChannelUp',chDown:'ChannelDown',up:'Up',down:'Down',left:'Left',
        right:'Right',ok:'Select',back:'Back',home:'Home',play:'Play',
        rewind:'Rev',forward:'Fwd',info:'Info',exit:'Home',
        num0:'Lit_0',num1:'Lit_1',num2:'Lit_2',num3:'Lit_3',num4:'Lit_4',
        num5:'Lit_5',num6:'Lit_6',num7:'Lit_7',num8:'Lit_8',num9:'Lit_9'
      };

      if (this.tvBrand === 'samsung') {
        var sKey = SAMSUNG_KEYS[key];
        if (sKey && this.tvWs && this.tvWs.readyState === WebSocket.OPEN) {
          this.tvWs.send(JSON.stringify({
            method: 'ms.remote.control',
            params: { Cmd: 'Click', DataOfCmd: sKey, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
          }));
        }
      } else if (this.tvBrand === 'lg') {
        var lKey = LG_KEYS[key];
        if (lKey && this.tvWs && this.tvWs.readyState === WebSocket.OPEN) {
          this.tvWs.send(JSON.stringify({ type: 'button', name: lKey }));
        }
      } else if (this.tvBrand === 'roku') {
        var rKey = ROKU_KEYS[key];
        if (rKey) {
          fetch('/api/roku/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: this.tvIp, key: rKey })
          });
        }
      }
    }

    launchTVApp(app) {
      var SAMSUNG_APPS = {
        netflix: 'org.tizen.browser?url=https://www.netflix.com',
        youtube: '111299001912',
        prime: 'org.tizen.browser?url=https://www.primevideo.com',
        disney: 'MCmYXNxgcu.DisneyPlus'
      };
      var LG_APPS = {
        netflix: 'netflix',
        youtube: 'youtube.leanback.v4',
        prime: 'amazon',
        disney: 'com.disney.disneyplus-prod'
      };
      var ROKU_APPS = {
        netflix: '12',
        youtube: '837',
        prime: '13',
        disney: '291097'
      };

      if (this.tvBrand === 'samsung' && this.tvWs && this.tvWs.readyState === WebSocket.OPEN) {
        var appId = SAMSUNG_APPS[app];
        if (appId) {
          this.tvWs.send(JSON.stringify({
            method: 'ms.channel.emit',
            params: { event: 'ed.apps.launch', to: 'host', data: { appId: appId, action_type: 'DEEP_LINK' } }
          }));
        }
      } else if (this.tvBrand === 'lg' && this.tvWs && this.tvWs.readyState === WebSocket.OPEN) {
        var lgAppId = LG_APPS[app];
        if (lgAppId) {
          this.tvWs.send(JSON.stringify({
            type: 'request',
            id: 'launch_' + Date.now(),
            uri: 'ssap://system.launcher/launch',
            payload: { id: lgAppId }
          }));
        }
      } else if (this.tvBrand === 'roku') {
        var rokuAppId = ROKU_APPS[app];
        if (rokuAppId) {
          fetch('/api/roku/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: this.tvIp, key: 'launch/' + rokuAppId })
          });
        }
      }
    }

    destroy() {
      clearInterval(this.pollTimer);
      clearInterval(this.heartbeatTimer);
      if (this.dataChannel) this.dataChannel.close();
      if (this.pc) this.pc.close();
      if (this.tvWs) this.tvWs.close();
    }
  }

  window.BridgeAgent = BridgeAgent;
})();
