(function() {
  var STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };

  function RemoteClient() {
    this.roomCode = null;
    this.clientId = null;
    this.hostId = null;
    this.pc = null;
    this.dataChannel = null;
    this.pollTimer = null;
    this.lastSignalIndex = 0;
    this.signalBase = '';
    this.onConnected = null;
    this.onDisconnected = null;
    this.onTVList = null;
    this._cmdId = 0;
  }

  // Detect signaling server base URL
  RemoteClient.prototype.getSignalBase = function() {
    // Same origin works for both local (localhost:3456) and Vercel (serverless functions)
    return '';
  };

  RemoteClient.prototype.joinRoom = async function(code) {
    this.roomCode = code;
    this.signalBase = this.getSignalBase();

    var res = await fetch(this.signalBase + '/api/signal/join-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    });

    if (!res.ok) throw new Error('Room not found');

    var data = await res.json();
    this.clientId = data.clientId;
    this.hostId = data.hostId;
    if (data.tvList && data.tvList.length && this.onTVList) {
      this.onTVList(data.tvList);
    }

    // Notify bridge that we joined
    await fetch(this.signalBase + '/api/signal/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, senderId: this.clientId, type: 'joined', payload: {} })
    });

    // Create WebRTC connection
    await this.createPeerConnection();
  };

  RemoteClient.prototype.createPeerConnection = async function() {
    var self = this;
    this.pc = new RTCPeerConnection({ iceServers: [STUN] });

    // Create data channel (remote is the initiator)
    this.dataChannel = this.pc.createDataChannel('remo-commands', { ordered: true });
    this.setupDataChannel();

    this.pc.onicecandidate = function(e) {
      if (e.candidate) {
        fetch(self.signalBase + '/api/signal/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: self.roomCode,
            senderId: self.clientId,
            type: 'ice-candidate',
            payload: e.candidate
          })
        });
      }
    };

    this.pc.onconnectionstatechange = function() {
      console.log('[Remote] Connection state:', self.pc.connectionState);
      if (self.pc.connectionState === 'connected') {
        clearInterval(self.pollTimer);
        if (self.onConnected) self.onConnected();
      }
      if (self.pc.connectionState === 'disconnected' || self.pc.connectionState === 'failed') {
        if (self.onDisconnected) self.onDisconnected();
      }
    };

    // Create and send offer
    var offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    await fetch(this.signalBase + '/api/signal/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.roomCode,
        senderId: this.clientId,
        type: 'offer',
        payload: offer
      })
    });

    // Start polling for answer and ICE candidates
    this.startPolling();
  };

  RemoteClient.prototype.startPolling = function() {
    var self = this;
    this.pollTimer = setInterval(async function() {
      try {
        var res = await fetch(
          self.signalBase + '/api/signal/poll?code=' + self.roomCode +
          '&senderId=' + self.clientId +
          '&lastIndex=' + self.lastSignalIndex
        );
        var data = await res.json();
        self.lastSignalIndex = data.nextIndex;

        for (var i = 0; i < data.messages.length; i++) {
          var msg = data.messages[i];
          if (msg.type === 'answer') {
            await self.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
          }
          if (msg.type === 'ice-candidate') {
            await self.pc.addIceCandidate(new RTCIceCandidate(msg.payload));
          }
        }
      } catch(e) {
        console.error('[Remote] Poll error:', e);
      }
    }, 1000);
  };

  RemoteClient.prototype.setupDataChannel = function() {
    var self = this;

    this.dataChannel.onopen = function() {
      console.log('[Remote] Data channel open!');
    };

    this.dataChannel.onmessage = function(e) {
      var msg = JSON.parse(e.data);
      if (msg.type === 'ping') {
        self.dataChannel.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      }
      if (msg.type === 'tv-event') {
        // Handle TV events (e.g., pairing registered)
      }
    };

    this.dataChannel.onclose = function() {
      if (self.onDisconnected) self.onDisconnected();
    };
  };

  RemoteClient.prototype.sendKey = function(key) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'key', key: key, id: ++this._cmdId }));
      return true;
    }
    return false;
  };

  RemoteClient.prototype.launchApp = function(app) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'app', app: app, id: ++this._cmdId }));
      return true;
    }
    return false;
  };

  RemoteClient.prototype.disconnect = function() {
    clearInterval(this.pollTimer);
    if (this.dataChannel) this.dataChannel.close();
    if (this.pc) this.pc.close();
  };

  window.RemoteClient = RemoteClient;
})();
