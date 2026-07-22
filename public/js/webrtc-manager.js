class WebRTCManager {
  constructor(socketManager, options = {}) {
    this.CHUNK_SIZE = 128 * 1024;
    this.DESKTOP_CHUNK_SIZE = 256 * 1024;
    this.FALLBACK_CHUNK_SIZE = 64 * 1024;
    this.BUFFER_THRESHOLD = 16 * 1024 * 1024;
    this.BUFFER_LOW_THRESHOLD = 4 * 1024 * 1024;
    this.RECEIVER_READY_TIMEOUT = 15000;
    this.DELIVERY_ACK_TIMEOUT = Number.isSafeInteger(options.deliveryAckTimeout)
      ? Math.max(1, options.deliveryAckTimeout)
      : 30000;
    this.MAX_TRANSFER_ID_LENGTH = 128;
    this.socketManager = socketManager;
    this.peerConnection = null;
    this.dataChannel = null;
    this.role = null; // 'initiator' or 'receiver'
    this.roomCode = null;

    // Callbacks for UI updates
    this.onConnectionStateChange = null;
    this.onFileTransferProgress = null; // (bytesReceived, totalBytes, fileName, isSending)
    this.onFileTransferComplete = null; // (fileBlob, fileName, options)
    this.onFileTransferStart = null; // (fileName, totalBytes, isSending, options)
    this.onPeerDisconnected = null;
    this.onClipboardMessage = null; // (text)
    this.onFileTransferCancelled = null; // (fileName, isLocal)
    this.onTransferError = null; // ({ type, message, fileName })
    this.onNetworkDiagnostics = null; // ({ connectionType, speed, qualityLabel, isLocal, percent })
    this.onRelayUsage = null; // ({ chunkSize, chunks })

    this.sessionGeneration = 0;
    this.receiverState = this.createEmptyReceiverState();

    // Configuracion ICE (STUN/TURN) - se recibe dinamicamente desde el servidor.
    this.rtcConfig = null;
    this.pendingSignals = [];
    this.signalQueueGeneration = 0;
    this.pendingRemoteCandidates = [];
    this.isClosing = false;
    this.activeSendTransfer = null;
    this.resumeWaiters = new Map();
    this.deliveryWaiters = new Map();
    this.completedTransfers = new Map();
    this.completedTransferIds = new Set();
    this.MAX_COMPLETED_TRANSFER_RECEIPTS = 128;
    this.incomingMessageChain = Promise.resolve();
    this.dataChannelGeneration = 0;
    this.peerConnectionGeneration = 0;
    this.recoveryPrepared = false;
    this.encryption = this.createEncryptionState();
    this.relayBudget = { plan: 'free', limitBytes: Number.POSITIVE_INFINITY, usedBytes: 0, blocked: false };
    this.pendingRelayUsageBytes = 0;

    this.diagnosticsInterval = null;
    this.diagnosticsTransfer = null;
    this.lastDiagnosticsBytes = 0;
    this.lastDiagnosticsTimestamp = 0;
    this.lastDiagnosticsMetrics = null;
    this.currentPerformanceProfile = null;
    this.transferDiagnostics = {
      bytesTransferred: 0,
      totalBytes: 0,
      percent: 0,
      speedBytesPerSecond: 0,
      speedMBps: 0,
      direction: null,
      fileName: null,
      updatedAt: null
    };

    if (typeof window !== 'undefined') {
      window.airDowsDiagnostics = this.transferDiagnostics;
    }
  }

  createEmptyReceiverState() {
    return {
      metadata: null,
      receivedBuffers: [],
      receivedSize: 0,
      writeMode: 'memory',
      fileHandle: null,
      writable: null,
      writeChain: Promise.resolve(),
      writeFailed: false,
      memoryChunkCount: 0,
      finalizing: false,
      terminalState: null,
      sessionGeneration: this.sessionGeneration
    };
  }

  createEncryptionState() {
    return {
      available: typeof crypto !== 'undefined' && Boolean(crypto.subtle),
      keyPair: null,
      remotePublicKey: null,
      sessionKey: null,
      ready: null,
      resolveReady: null,
      rejectReady: null
    };
  }

  setIceConfig(config) {
    console.log('WebRTC: Setting ICE configuration');
    this.rtcConfig = config;
  }

  initialize(role, roomCode) {
    if (!this.rtcConfig) {
      console.error('WebRTC: Cannot initialize without ICE configuration');
      return;
    }

    this.startNewPairingSession();
    this.role = role;
    this.roomCode = roomCode;
    this.isClosing = false;
    this.recoveryPrepared = false;
    if (!this.encryption.ready) {
      this.encryption.ready = new Promise((resolve, reject) => {
        this.encryption.resolveReady = resolve;
        this.encryption.rejectReady = reject;
      });
    }
    this.startEncryptionSession().catch((err) => {
      console.warn('Application encryption unavailable. WebRTC transport encryption remains active:', err.message);
    });
    console.log(`Initializing WebRTC as ${role}`);

    this.createPeerConnection();
    this.flushPendingSignals();

    if (this.role === 'initiator') {
      this.createDataChannel();
      this.createOffer();
    }
  }

  createPeerConnection() {
    const generation = ++this.peerConnectionGeneration;
    const peerConnection = new RTCPeerConnection(this.rtcConfig);
    this.peerConnection = peerConnection;

    peerConnection.onicecandidate = (event) => {
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
      if (event.candidate) {
        console.log('Sending local ICE Candidate to peer');
        this.socketManager.sendSignal(this.roomCode, {
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
      console.log(`Connection state: ${peerConnection.connectionState}`);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(peerConnection.connectionState);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
      console.log(`ICE connection state: ${peerConnection.iceConnectionState}`);
      if (peerConnection.iceConnectionState === 'failed') {
        console.error('ICE failed: no compatible host, STUN or TURN candidate pair was found.');
      }
    };

    peerConnection.onicecandidateerror = (event) => {
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
      console.error('ICE candidate error:', {
        url: event.url,
        errorCode: event.errorCode,
        errorText: event.errorText
      });
    };

    if (this.role === 'receiver') {
      peerConnection.ondatachannel = (event) => {
        if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
        console.log('Received data channel created by initiator');
        this.setDataChannel(event.channel);
      };
    }
  }

  createDataChannel() {
    console.log('Creating local data channel');
    const channel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true
    });
    this.setDataChannel(channel);
  }

  setDataChannel(channel) {
    if (this.dataChannel && this.dataChannel !== channel) {
      this.rejectAllDeliveryWaiters('DATA_CHANNEL_REPLACED', 'Data connection was replaced.');
    }

    const channelGeneration = ++this.dataChannelGeneration;
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = this.BUFFER_LOW_THRESHOLD;

    this.dataChannel.onopen = () => {
      if (this.dataChannel !== channel || this.dataChannelGeneration !== channelGeneration) return;
      console.log('Data channel state is: OPEN');
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange('connected');
      }
    };

    this.dataChannel.onclose = () => {
      if (this.dataChannel !== channel || this.dataChannelGeneration !== channelGeneration) return;
      this.dataChannelGeneration += 1;
      console.log('Data channel state is: CLOSED');
      this.rejectAllDeliveryWaiters('DATA_CHANNEL_CLOSED', 'Data connection closed before delivery confirmation.');
      this.stopNetworkDiagnostics();
      if (!this.isClosing && this.onConnectionStateChange) {
        this.onConnectionStateChange('disconnected');
      }
    };

    this.dataChannel.onerror = (error) => {
      if (this.dataChannel !== channel || this.dataChannelGeneration !== channelGeneration) return;
      this.dataChannelGeneration += 1;
      console.error('Data channel error:', error);
      this.rejectAllDeliveryWaiters('DATA_CHANNEL_ERROR', 'Data connection failed before delivery confirmation.');
      this.cleanupReceiverDiskStream().catch((err) => {
        console.error('Error cleaning receiver stream after data channel error:', err);
      });
    };

    this.dataChannel.onmessage = (event) => {
      if (this.dataChannel !== channel || this.dataChannelGeneration !== channelGeneration) return;
      this.enqueueIncomingMessage(event.data, channelGeneration);
    };
  }

  enqueueIncomingMessage(data, channelGeneration = this.dataChannelGeneration) {
    const rejectMetadata = this.isUnexpectedMetadataAtArrival(data);
    const task = this.incomingMessageChain.then(() => {
      if (channelGeneration !== this.dataChannelGeneration) return;
      if (rejectMetadata) {
        console.warn('Ignoring unexpected file metadata while another transfer is active');
        return;
      }
      return this.handleIncomingMessage(data, channelGeneration);
    });
    this.incomingMessageChain = task.catch(async (err) => {
      if (channelGeneration !== this.dataChannelGeneration) return;
      console.error('Error handling incoming WebRTC message:', err.message);
      try {
        await this.failIncomingTransfer(
          err.deliveryReason || 'FINALIZATION_FAILED',
          err,
          true,
          channelGeneration
        );
      } catch (cleanupErr) {
        console.error('Error cleaning receiver state after incoming message failure:', cleanupErr.message);
      }
    });
    return this.incomingMessageChain;
  }

  isUnexpectedMetadataAtArrival(data) {
    if (typeof data !== 'string' || !this.receiverState.metadata) return false;
    let message;
    try {
      message = JSON.parse(data);
    } catch (err) {
      return false;
    }
    if (!message || message.type !== 'metadata') return false;

    const current = this.receiverState;
    return current.finalizing || Boolean(current.terminalState) ||
      current.metadata.transferId !== message.transferId ||
      current.metadata.name !== message.name ||
      current.metadata.size !== message.size;
  }

  async startEncryptionSession() {
    if (!this.encryption.available || this.encryption.keyPair) return;

    this.encryption.keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey']
    );

    const publicKey = await crypto.subtle.exportKey('jwk', this.encryption.keyPair.publicKey);
    this.socketManager.sendSignal(this.roomCode, {
      type: 'crypto-key',
      publicKey
    });

    await this.deriveSessionKey();
  }

  async acceptRemoteCryptoKey(publicKeyJwk, isCurrentConnection = () => true) {
    if (!this.encryption.available || !publicKeyJwk || typeof publicKeyJwk !== 'object') return;

    const remotePublicKey = await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    if (!isCurrentConnection()) return;

    this.encryption.remotePublicKey = remotePublicKey;
    await this.startEncryptionSession();
    if (!isCurrentConnection()) return;
    await this.deriveSessionKey();
  }

  async deriveSessionKey() {
    if (this.encryption.sessionKey || !this.encryption.keyPair || !this.encryption.remotePublicKey) return;

    this.encryption.sessionKey = await crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: this.encryption.remotePublicKey
      },
      this.encryption.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.encryption.resolveReady?.(this.encryption.sessionKey);
    console.info('[AirDows] Application encryption ready: AES-GCM-256');
  }

  async waitForEncryption() {
    if (!this.encryption.available) return null;
    if (this.encryption.sessionKey) return this.encryption.sessionKey;

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('No se pudo negociar la clave de cifrado.')), 10000);
    });

    return Promise.race([this.encryption.ready, timeout]);
  }

  async encryptChunk(data) {
    const key = await this.waitForEncryption();
    if (!key) return data;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    const envelope = new Uint8Array(iv.byteLength + encrypted.byteLength);
    envelope.set(iv, 0);
    envelope.set(new Uint8Array(encrypted), iv.byteLength);
    return envelope.buffer;
  }

  async decryptChunk(data) {
    const key = await this.waitForEncryption();
    if (!key) return data;

    const envelope = new Uint8Array(data);
    if (envelope.byteLength <= 28) {
      const error = new Error('Invalid encrypted chunk.');
      error.code = 'INVALID_ENCRYPTED_CHUNK';
      throw error;
    }

    const iv = envelope.slice(0, 12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, envelope.slice(12));
  }

  async handleSignal(data) {
    if (!this.peerConnection) {
      console.warn('WebRTC signal received before peer connection was ready. Queueing it.');
      this.pendingSignals.push({
        data,
        signalQueueGeneration: this.signalQueueGeneration
      });
      return;
    }

    const peerConnection = this.peerConnection;
    const generation = this.peerConnectionGeneration;
    const isCurrentConnection = () => (
      this.peerConnection === peerConnection && this.peerConnectionGeneration === generation
    );

    try {
      if (data.type === 'crypto-key') {
        await this.acceptRemoteCryptoKey(data.publicKey, isCurrentConnection);
        if (!isCurrentConnection()) return;
      } else if (data.type === 'offer') {
        console.log('Received SDP Offer, creating Answer...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        if (!isCurrentConnection()) return;
        await this.flushPendingRemoteCandidates(peerConnection, generation);
        if (!isCurrentConnection()) return;
        const answer = await peerConnection.createAnswer();
        if (!isCurrentConnection()) return;
        await peerConnection.setLocalDescription(answer);
        if (!isCurrentConnection()) return;

        this.socketManager.sendSignal(this.roomCode, {
          type: 'answer',
          answer: answer
        });
      } else if (data.type === 'answer') {
        console.log('Received SDP Answer...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        if (!isCurrentConnection()) return;
        await this.flushPendingRemoteCandidates(peerConnection, generation);
      } else if (data.type === 'candidate') {
        console.log('Received remote ICE candidate');
        if (!peerConnection.remoteDescription) {
          this.pendingRemoteCandidates.push(data.candidate);
          return;
        }
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('Error during WebRTC signaling handling:', err);
    }
  }

  flushPendingSignals() {
    if (!this.pendingSignals.length) return;

    const signals = [...this.pendingSignals];
    this.pendingSignals = [];
    signals.forEach((signal) => {
      if (!signal || signal.signalQueueGeneration !== this.signalQueueGeneration) return;
      this.handleSignal(signal.data);
    });
  }

  prepareForNewPairingSignals() {
    this.signalQueueGeneration += 1;
    this.pendingSignals = [];
    this.pendingRemoteCandidates = [];
  }

  async flushPendingRemoteCandidates(
    peerConnection = this.peerConnection,
    generation = this.peerConnectionGeneration
  ) {
    if (!peerConnection || !this.pendingRemoteCandidates.length || !peerConnection.remoteDescription) return;

    const candidates = [...this.pendingRemoteCandidates];
    this.pendingRemoteCandidates = [];

    for (const candidate of candidates) {
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  async createOffer() {
    const peerConnection = this.peerConnection;
    const generation = this.peerConnectionGeneration;
    if (!peerConnection) return;
    try {
      console.log('Creating SDP Offer...');
      const offer = await peerConnection.createOffer();
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;
      await peerConnection.setLocalDescription(offer);
      if (this.peerConnection !== peerConnection || this.peerConnectionGeneration !== generation) return;

      this.socketManager.sendSignal(this.roomCode, {
        type: 'offer',
        offer: offer
      });
    } catch (err) {
      console.error('Error creating SDP Offer:', err);
    }
  }

  async handleIncomingMessage(data, channelGeneration = this.dataChannelGeneration) {
    if (typeof data === 'string') {
      await this.handleIncomingTextMessage(data, channelGeneration);
      return;
    }

    if (data instanceof ArrayBuffer) {
      await this.handleIncomingFileChunk(data, channelGeneration);
      return;
    }

    console.warn('Received unsupported data channel payload');
  }

  async handleIncomingFileChunk(data, channelGeneration = this.dataChannelGeneration) {
    const state = this.receiverState;
    if (!state.metadata) {
      console.error('Received binary chunk without file metadata!');
      return;
    }

    const chunkData = state.metadata.encryption === 'aes-gcm-256'
      ? await this.decryptChunk(data)
      : data;
    if (channelGeneration !== this.dataChannelGeneration || this.receiverState !== state) return;

    if (state.receivedSize + chunkData.byteLength > state.metadata.size) {
      const error = new Error('Received more data than expected.');
      error.code = 'UNEXPECTED_TRANSFER_SIZE';
      error.deliveryReason = 'SIZE_MISMATCH';
      throw error;
    }

    if (state.writeMode === 'disk' && state.writable) {
      try {
        state.writeChain = state.writeChain.then(() => state.writable.write(chunkData));
        await state.writeChain;
        if (channelGeneration !== this.dataChannelGeneration || this.receiverState !== state) {
          if (this.receiverState === state) state.finalizing = false;
          return;
        }
      } catch (err) {
        state.writeFailed = true;
        await this.abortReceiverDiskStream();
        const writeError = new Error('The received file could not be written.');
        writeError.code = 'RECEIVER_WRITE_FAILED';
        writeError.deliveryReason = 'WRITE_FAILED';
        throw writeError;
      }
    } else {
      const bufferIndex = state.receivedBuffers.length;
      state.receivedBuffers.push(chunkData);
      state.memoryChunkCount += 1;

      // Yield periodically so rendering and garbage collection can run between chunks.
      if (state.memoryChunkCount % 256 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (channelGeneration !== this.dataChannelGeneration || this.receiverState !== state) {
          if (state.receivedBuffers[bufferIndex] === chunkData) {
            state.receivedBuffers.splice(bufferIndex, 1);
            state.memoryChunkCount -= 1;
          }
          return;
        }
      }
    }

    state.receivedSize += chunkData.byteLength;
    this.reportTransferProgress(state.receivedSize, state.metadata.size, state.metadata.name, false);
  }

  async handleIncomingTextMessage(rawText, channelGeneration = this.dataChannelGeneration) {
    if (channelGeneration !== this.dataChannelGeneration) return;
    let message = null;

    try {
      message = JSON.parse(rawText);
    } catch (err) {
      this.emitClipboardMessage(rawText);
      return;
    }

    const isObjectMessage = message && typeof message === 'object' && !Array.isArray(message);
    const isProtocolMessage = isObjectMessage && typeof message.type === 'string';

    if (!isProtocolMessage) {
      this.emitClipboardMessage(rawText);
      return;
    }

    if (message.type === 'metadata') {
      if (!this.isValidFileMetadata(message)) {
        console.error('Received invalid file metadata');
        await this.resetReceiverState();
        return;
      }

      const current = this.receiverState;
      const completed = this.completedTransfers.get(message.transferId);
      if (!current.metadata && completed) {
        if (completed.sessionGeneration === this.sessionGeneration &&
            completed.name === message.name && completed.size === message.size) {
          this.sendReceiverReady(message.transferId, {
            offset: completed.size,
            size: completed.size,
            writeMode: completed.writeMode
          });
        }
        return;
      }
      if (!current.metadata && this.completedTransferIds.has(message.transferId)) return;
      if (current.metadata) {
        const sameTransfer = current.metadata.transferId === message.transferId &&
          current.metadata.name === message.name &&
          current.metadata.size === message.size;
        if (!sameTransfer || current.finalizing || current.terminalState) {
          console.warn('Ignoring unexpected file metadata while another transfer is active');
          return;
        }
      }

      await this.prepareIncomingFile(message);
      if (channelGeneration !== this.dataChannelGeneration) return;
      this.sendReceiverReady(message.transferId);
      return;
    }

    if (message.type === 'receiver-ready') {
      const waiter = this.resumeWaiters.get(message.transferId);
      const transfer = this.activeSendTransfer;
      if (waiter && transfer && transfer.transferId === message.transferId &&
          this.isValidTransferSize(message.offset) && this.isValidTransferSize(message.size) &&
          message.size === transfer.totalBytes) {
        this.resumeWaiters.delete(message.transferId);
        if (typeof waiter === 'function') {
          waiter(Math.min(message.offset, transfer.totalBytes));
        } else {
          clearTimeout(waiter.timeout);
          waiter.resolve(Math.min(message.offset, transfer.totalBytes));
        }
      }
      return;
    }

    if (message.type === 'resume-offset') {
      const waiter = this.resumeWaiters.get(message.transferId);
      const transfer = this.activeSendTransfer;
      if (waiter && transfer && transfer.transferId === message.transferId &&
          this.isValidTransferSize(message.offset) && this.isValidTransferSize(message.size) &&
          message.size === transfer.totalBytes) {
        this.resumeWaiters.delete(message.transferId);
        if (typeof waiter === 'function') {
          waiter(Math.min(message.offset, transfer.totalBytes));
        } else {
          clearTimeout(waiter.timeout);
          waiter.resolve(Math.min(message.offset, transfer.totalBytes));
        }
      }
      return;
    }

    if (message.type === 'transfer-ack') {
      this.handleTransferAck(message);
      return;
    }

    if (message.type === 'transfer-failed') {
      this.handleTransferFailed(message);
      return;
    }

    if (message.type === 'transfer-finished') {
      if (!this.isValidTransferTerminalMessage(message, true)) return;
      const state = this.receiverState;
      if (!state.metadata) {
        const completed = this.completedTransfers.get(message.transferId);
        if (completed && completed.sessionGeneration === this.sessionGeneration &&
            completed.size === message.size &&
            completed.lastAckGeneration !== this.dataChannelGeneration) {
          this.sendDeliveryControl({
            type: 'transfer-ack',
            transferId: message.transferId,
            size: message.size
          });
          completed.lastAckGeneration = this.dataChannelGeneration;
        }
        return;
      }
      if (state.metadata.transferId !== message.transferId || state.terminalState) return;
      await this.finalizeIncomingFile(message, channelGeneration);
      return;
    }

    if (message.type === 'clipboard') {
      if (typeof message.text !== 'string') {
        console.error('Received clipboard message without text payload');
        return;
      }
      this.emitClipboardMessage(message.text);
      return;
    }

    if (message.type === 'transfer-cancelled') {
      if (!this.hasExactMessageFields(message, ['type', 'transferId']) ||
          !this.isValidTransferId(message.transferId)) return;

      const transfer = this.activeSendTransfer;
      if (transfer && transfer.transferId === message.transferId && !transfer.cancelled) {
        const cancelError = this.createTransferCancelledError('Transfer cancelled by receiver.');
        const settled = this.rejectDeliveryWaiter(transfer.transferId, cancelError, 'cancelled');
        if (!settled && !this.transitionSenderTerminalState(transfer, 'cancelled')) return;
        transfer.cancelled = true;
        transfer.abortController.abort();
        this.invokeSenderTerminalCallback(transfer, 'cancelled', () => {
          if (this.onFileTransferCancelled) this.onFileTransferCancelled(transfer.fileName, false);
        });
        return;
      }

      const state = this.receiverState;
      if (state.metadata && state.metadata.transferId === message.transferId && !state.terminalState) {
        const fileName = state.metadata.name;
        await this.failIncomingTransfer('CANCELLED');
        try {
          if (this.onFileTransferCancelled) this.onFileTransferCancelled(fileName, false);
        } catch (err) {
          console.error('Receiver cancellation callback failed');
        }
      }
      return;
    }

    console.warn('Unknown JSON data channel message type:', message.type);
  }

  async prepareIncomingFile(metadata) {
    const current = this.receiverState;
    const canResume = current.metadata &&
      current.sessionGeneration === this.sessionGeneration &&
      current.metadata.transferId === metadata.transferId &&
      current.metadata.name === metadata.name &&
      current.metadata.size === metadata.size;

    if (canResume) {
      console.log(`Resuming incoming transfer at byte ${current.receivedSize}`);
      if (current.writeMode === 'disk' && current.writable) {
        await current.writeChain;
        await current.writable.seek(current.receivedSize);
        console.info('[AirDows] Resume seek', {
          fileName: metadata.name,
          offset: current.receivedSize,
          totalBytes: metadata.size,
          percent: this.calculatePercent(current.receivedSize, metadata.size)
        });
      }
      return;
    }

    await this.cleanupReceiverDiskStream();

    const nextState = this.createEmptyReceiverState();
    nextState.metadata = metadata;
    this.receiverState = nextState;

    if (this.supportsDiskWriteMode()) {
      try {
        const extension = this.getFileExtension(metadata.name);
        const pickerOptions = { suggestedName: metadata.name };

        if (extension) {
          pickerOptions.types = [{
            description: metadata.mime || 'File',
            accept: { [metadata.mime || 'application/octet-stream']: ['.' + extension] }
          }];
        }

        const fileHandle = await window.showSaveFilePicker({
          ...pickerOptions
        });

        nextState.fileHandle = fileHandle;
        nextState.writable = await fileHandle.createWritable();
        nextState.writeMode = 'disk';
        console.log('Pro mode enabled: receiving file directly to disk.');
      } catch (err) {
        console.warn('Direct-to-disk mode unavailable or declined. Falling back to memory mode:', err);
        nextState.writeMode = 'memory';
        nextState.fileHandle = null;
        nextState.writable = null;
      }
    }

    if (this.onFileTransferStart) {
      this.onFileTransferStart(metadata.name, metadata.size, false, {
        writeMode: nextState.writeMode,
        supportsDiskWrite: this.supportsDiskWriteMode(),
        performanceProfile: metadata.performanceProfile || 'Modo inteligente',
        connectionType: metadata.connectionType || 'unknown',
        chunkSize: metadata.chunkSize || 0
      });
    }

    this.startNetworkDiagnostics({
      direction: 'receive',
      fileName: metadata.name,
      totalBytes: metadata.size,
      getBytesTransferred: () => this.receiverState.receivedSize
    });
  }

  sendReceiverReady(transferId, completed = null) {
    if (!transferId || !this.dataChannel || this.dataChannel.readyState !== 'open') return;

    const state = this.receiverState;
    const offset = completed
      ? completed.offset
      : state.metadata && state.metadata.transferId === transferId
        ? Math.min(state.receivedSize, state.metadata.size)
        : 0;

    this.dataChannel.send(JSON.stringify({
      type: 'receiver-ready',
      transferId,
      offset,
      size: completed ? completed.size : state.metadata ? state.metadata.size : 0,
      writeMode: completed ? completed.writeMode : state.writeMode
    }));
  }

  rememberCompletedTransfer(metadata, writeMode, channelGeneration) {
    this.completedTransferIds.add(metadata.transferId);
    this.completedTransfers.delete(metadata.transferId);
    this.completedTransfers.set(metadata.transferId, {
      name: metadata.name,
      size: metadata.size,
      writeMode,
      sessionGeneration: this.sessionGeneration,
      lastAckGeneration: channelGeneration
    });
    while (this.completedTransfers.size > this.MAX_COMPLETED_TRANSFER_RECEIPTS) {
      this.completedTransfers.delete(this.completedTransfers.keys().next().value);
    }
  }

  sendDeliveryControl(message) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
    try {
      this.dataChannel.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.warn('Delivery control message could not be sent');
      return false;
    }
  }

  async finalizeIncomingFile(finishedMessage, channelGeneration = this.dataChannelGeneration) {
    const state = this.receiverState;
    const metadata = state.metadata;
    if (!metadata || state.finalizing || state.terminalState ||
        channelGeneration !== this.dataChannelGeneration) return;

    state.finalizing = true;

    if (finishedMessage.size !== metadata.size || state.receivedSize !== metadata.size) {
      await this.failIncomingTransfer('SIZE_MISMATCH');
      return;
    }

    if (state.writeFailed) {
      await this.failIncomingTransfer('WRITE_FAILED');
      return;
    }

    let fileBlob = null;
    let completionOptions = null;

    if (state.writeMode === 'disk') {
      if (!state.writable) {
        await this.failIncomingTransfer('FINALIZATION_FAILED');
        return;
      }

      try {
        await state.writeChain;
        if (channelGeneration !== this.dataChannelGeneration || this.receiverState !== state) return;
        if (state.writeFailed) {
          await this.failIncomingTransfer('WRITE_FAILED');
          return;
        }
        await state.writable.close();
        state.writable = null;
        if (channelGeneration !== this.dataChannelGeneration || this.receiverState !== state) {
          if (this.receiverState === state) this.receiverState = this.createEmptyReceiverState();
          return;
        }
        completionOptions = {
          writeMode: 'disk',
          savedToDisk: true
        };
      } catch (err) {
        await this.failIncomingTransfer(
          state.writeFailed ? 'WRITE_FAILED' : 'FINALIZATION_FAILED',
          err
        );
        return;
      }
    } else {
      try {
        fileBlob = new Blob(state.receivedBuffers, { type: metadata.mime });
      } catch (err) {
        await this.failIncomingTransfer('FINALIZATION_FAILED', err);
        return;
      }

      if (fileBlob.size !== metadata.size) {
        await this.failIncomingTransfer('SIZE_MISMATCH');
        return;
      }

      completionOptions = {
        writeMode: 'memory',
        savedToDisk: false
      };
    }

    if (channelGeneration !== this.dataChannelGeneration || this.receiverState !== state) return;
    this.rememberCompletedTransfer(metadata, completionOptions.writeMode, channelGeneration);
    state.terminalState = 'completed';
    this.stopNetworkDiagnostics();
    this.sendDeliveryControl({
      type: 'transfer-ack',
      transferId: metadata.transferId,
      size: metadata.size
    });

    try {
      if (this.onFileTransferComplete) {
        this.onFileTransferComplete(fileBlob, metadata.name, completionOptions);
      }
    } catch (err) {
      console.error('Receiver completion callback failed');
    } finally {
      state.receivedBuffers.length = 0;
      if (this.receiverState === state) {
        this.receiverState = this.createEmptyReceiverState();
      }
    }
  }

  async failIncomingTransfer(
    reason,
    error = null,
    notifyPeer = true,
    channelGeneration = this.dataChannelGeneration
  ) {
    const state = this.receiverState;
    const metadata = state && state.metadata;
    if (!metadata || state.terminalState || channelGeneration !== this.dataChannelGeneration) return false;

    state.terminalState = reason === 'CANCELLED' ? 'cancelled' : 'failed';
    this.stopNetworkDiagnostics();

    if (notifyPeer) {
      this.sendDeliveryControl({
        type: 'transfer-failed',
        transferId: metadata.transferId,
        reason: this.isAllowedDeliveryFailureReason(reason) ? reason : 'FINALIZATION_FAILED'
      });
    }

    await this.cleanupReceiverDiskStream();
    state.receivedBuffers.length = 0;
    if (this.receiverState === state) {
      this.receiverState = this.createEmptyReceiverState();
    }

    if (error || reason !== 'CANCELLED') {
      this.reportTransferError(
        reason === 'WRITE_FAILED' ? 'write' : 'protocol',
        error || new Error('The receiver could not finalize the transfer.'),
        metadata.name
      );
    }
    return true;
  }

  supportsDiskWriteMode() {
    return typeof window !== 'undefined' &&
      window.isSecureContext === true &&
      typeof window.showSaveFilePicker === 'function';
  }

  getFileExtension(fileName) {
    const parts = String(fileName || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  async cleanupReceiverDiskStream() {
    const state = this.receiverState;
    if (!state || !state.writable) return;

    try {
      await state.writeChain.catch(() => {});
      await state.writable.close();
    } catch (err) {
      try {
        await state.writable.abort();
      } catch (abortErr) {}
    } finally {
      state.writable = null;
      state.fileHandle = null;
    }
  }

  async abortReceiverDiskStream() {
    const state = this.receiverState;
    if (!state || !state.writable) return;

    try {
      await state.writeChain.catch(() => {});
      await state.writable.abort();
    } catch (err) {
      console.error('Error aborting receiver disk stream:', err);
      this.reportTransferError('disk-abort', err, state.metadata && state.metadata.name);
    } finally {
      state.writable = null;
      state.fileHandle = null;
    }
  }

  async resetReceiverState() {
    await this.cleanupReceiverDiskStream();
    this.receiverState = this.createEmptyReceiverState();
  }

  isValidFileMetadata(message) {
    return (
      typeof message.name === 'string' &&
      message.name.trim().length > 0 &&
      this.isValidTransferId(message.transferId) &&
      Number.isSafeInteger(message.size) &&
      message.size >= 0 &&
      typeof message.mime === 'string' &&
      message.mime.trim().length > 0 &&
      (message.encryption === null || message.encryption === undefined || message.encryption === 'aes-gcm-256')
    );
  }

  isValidTransferId(transferId) {
    return typeof transferId === 'string' &&
      transferId.trim().length > 0 &&
      transferId.length <= this.MAX_TRANSFER_ID_LENGTH;
  }

  isValidTransferSize(size) {
    return Number.isSafeInteger(size) && size >= 0;
  }

  hasExactMessageFields(message, fields) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const keys = Object.keys(message).sort();
    return keys.length === fields.length &&
      fields.slice().sort().every((field, index) => keys[index] === field);
  }

  isValidTransferTerminalMessage(message, requireSize = false) {
    const fields = requireSize
      ? ['type', 'transferId', 'size']
      : ['type', 'transferId', 'reason'];
    if (!this.hasExactMessageFields(message, fields) || !this.isValidTransferId(message.transferId)) {
      return false;
    }
    return requireSize
      ? this.isValidTransferSize(message.size)
      : this.isAllowedDeliveryFailureReason(message.reason);
  }

  isAllowedDeliveryFailureReason(reason) {
    return ['SIZE_MISMATCH', 'WRITE_FAILED', 'FINALIZATION_FAILED', 'CANCELLED'].includes(reason);
  }

  handleTransferAck(message) {
    if (!message || message.type !== 'transfer-ack' || !this.isValidTransferTerminalMessage(message, true)) return false;
    const waiter = this.deliveryWaiters.get(message.transferId);
    if (!waiter || waiter.size !== message.size) return false;
    return this.settleDeliveryWaiter(message.transferId, 'resolve', null, 'completed');
  }

  handleTransferFailed(message) {
    if (!message || message.type !== 'transfer-failed' || !this.isValidTransferTerminalMessage(message, false)) return false;
    const waiter = this.deliveryWaiters.get(message.transferId);
    if (!waiter) return false;

    const error = new Error('The receiver rejected the transfer.');
    error.code = 'DELIVERY_REJECTED';
    error.reason = message.reason;
    return this.settleDeliveryWaiter(message.transferId, 'reject', error, 'failed');
  }

  createDeliveryWaiter(transferId, size) {
    if (!this.isValidTransferId(transferId) || !this.isValidTransferSize(size)) {
      return Promise.reject(new Error('Invalid delivery waiter parameters.'));
    }

    this.rejectDeliveryWaiter(
      transferId,
      this.createDeliveryError('DELIVERY_REPLACED', 'Delivery confirmation was replaced.')
    );

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        size,
        transfer: this.activeSendTransfer && this.activeSendTransfer.transferId === transferId
          ? this.activeSendTransfer
          : null,
        settled: false,
        timeout: null
      };

      waiter.timeout = setTimeout(() => {
        this.settleDeliveryWaiter(
          transferId,
          'reject',
          this.createDeliveryError('DELIVERY_ACK_TIMEOUT', 'Delivery confirmation timed out.'),
          'failed'
        );
      }, this.DELIVERY_ACK_TIMEOUT);
      if (typeof waiter.timeout.unref === 'function') waiter.timeout.unref();

      this.deliveryWaiters.set(transferId, waiter);
    });
  }

  createDeliveryError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  createTransferCancelledError(message = 'Transfer cancelled.') {
    const error = new Error(message);
    error.name = 'TransferCancelledError';
    error.code = 'TRANSFER_CANCELLED';
    return error;
  }

  transitionSenderTerminalState(transfer, terminalState) {
    if (!transfer || transfer.terminalState) return false;
    transfer.terminalState = terminalState;
    return true;
  }

  invokeSenderTerminalCallback(transfer, terminalState, callback) {
    if (!transfer || transfer.terminalState !== terminalState || transfer.terminalCallbackInvoked) return false;
    transfer.terminalCallbackInvoked = true;
    try {
      callback();
    } catch (err) {
      console.error('Sender terminal callback failed');
    }
    return true;
  }

  settleDeliveryWaiter(transferId, outcome, error, terminalState = outcome === 'resolve' ? 'completed' : 'failed') {
    const waiter = this.deliveryWaiters.get(transferId);
    if (!waiter || waiter.settled) return false;
    if (waiter.transfer && !this.transitionSenderTerminalState(waiter.transfer, terminalState)) return false;

    waiter.settled = true;
    clearTimeout(waiter.timeout);
    this.deliveryWaiters.delete(transferId);

    if (outcome === 'resolve') waiter.resolve();
    else waiter.reject(error);
    return true;
  }

  rejectDeliveryWaiter(transferId, error, terminalState = 'failed') {
    return this.settleDeliveryWaiter(transferId, 'reject', error, terminalState);
  }

  rejectAllDeliveryWaiters(code, message) {
    for (const transferId of [...this.deliveryWaiters.keys()]) {
      this.rejectDeliveryWaiter(transferId, this.createDeliveryError(code, message));
    }
  }

  emitClipboardMessage(text) {
    console.log('Received clipboard text:', text);
    if (this.onClipboardMessage) {
      this.onClipboardMessage(text);
    }
  }

  async sendFile(file, options = {}) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data connection is not ready or open yet!');
    }
    const channelGeneration = this.dataChannelGeneration;

    const performanceProfile = await this.selectPerformanceProfile();
    const CHUNK_SIZE = performanceProfile.chunkSize;
    const BUFFER_THRESHOLD = performanceProfile.bufferThreshold;
    this.dataChannel.bufferedAmountLowThreshold = performanceProfile.lowThreshold;

    console.info('[AirDows] Performance profile:', {
      mode: performanceProfile.label,
      route: performanceProfile.connectionType,
      chunkKB: CHUNK_SIZE / 1024,
      bufferMB: BUFFER_THRESHOLD / (1024 * 1024)
    });
    const sessionKey = await this.waitForEncryption();

    const transfer = {
      fileName: file.name,
      transferId: options.transferId || this.createTransferId(),
      reader: null,
      cancelled: false,
      terminalState: null,
      terminalCallbackInvoked: false,
      proRequired: false,
      abortController: new AbortController(),
      bytesTransferred: 0,
      totalBytes: file.size,
      connectionType: performanceProfile.connectionType,
      relayChunks: 0,
      relayChunkSize: CHUNK_SIZE,
      channelGeneration
    };
    if (!this.isValidTransferId(transfer.transferId) || !this.isValidTransferSize(transfer.totalBytes)) {
      const error = new Error('Invalid transfer metadata.');
      error.code = 'INVALID_TRANSFER_METADATA';
      throw error;
    }
    this.throwIfTransferCancelled(transfer);
    this.activeSendTransfer = transfer;

    if (this.onFileTransferStart) {
      this.onFileTransferStart(file.name, file.size, true, {
        writeMode: 'send',
        performanceProfile: performanceProfile.label,
        connectionType: performanceProfile.connectionType,
        chunkSize: CHUNK_SIZE
      });
    }

    const metadata = {
      type: 'metadata',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      transferId: transfer.transferId,
      encryption: sessionKey ? 'aes-gcm-256' : null,
      performanceProfile: performanceProfile.label,
      connectionType: performanceProfile.connectionType,
      chunkSize: CHUNK_SIZE
    };
    let resumeOffset;
    try {
      this.throwIfTransferCancelled(transfer);
      await this.sendWithBackpressure(
        JSON.stringify(metadata),
        BUFFER_THRESHOLD,
        transfer.abortController.signal
      );
      resumeOffset = await this.waitForReceiverReady(transfer);
      if (resumeOffset === null) {
        const error = new Error('The receiver did not confirm readiness.');
        error.code = 'RECEIVER_NOT_READY';
        throw error;
      }
    } catch (err) {
      const resumeWaiter = this.resumeWaiters.get(transfer.transferId);
      if (resumeWaiter) clearTimeout(resumeWaiter.timeout);
      this.resumeWaiters.delete(transfer.transferId);
      if (this.activeSendTransfer === transfer) {
        this.activeSendTransfer = null;
      }
      throw err;
    }

    this.startNetworkDiagnostics({
      direction: 'send',
      fileName: file.name,
      totalBytes: file.size,
      getBytesTransferred: () => transfer.bytesTransferred
    });

    let offset = resumeOffset;
    const stream = file.slice(resumeOffset).stream();
    const reader = stream.getReader();
    transfer.reader = reader;

    try {
      while (true) {
        this.throwIfTransferCancelled(transfer);
        const { done, value } = await reader.read();
        this.throwIfTransferCancelled(transfer);
        if (done) break;

        let chunkOffset = 0;
        while (chunkOffset < value.length) {
          this.throwIfTransferCancelled(transfer);
          const sliceSize = Math.min(CHUNK_SIZE, value.length - chunkOffset);
          const chunk = value.slice(chunkOffset, chunkOffset + sliceSize);

          if (this.dataChannel.readyState !== 'open') {
            throw new Error('Data connection closed during transfer.');
          }

          const outgoingChunk = sessionKey ? await this.encryptChunk(chunk) : chunk;
          this.throwIfTransferCancelled(transfer);
          if (performanceProfile.connectionType === 'relay') {
            if (!this.reserveRelayBudget(outgoingChunk.byteLength)) {
              transfer.proRequired = true;
              this.notifyPeerTransferCancelled(transfer);
              const error = this.createProRequiredError();
              this.transitionSenderTerminalState(transfer, 'failed');
              this.invokeSenderTerminalCallback(transfer, 'failed', () => {
                this.reportTransferError('relay-budget', error, file.name);
              });
              throw error;
            }

            transfer.relayChunks += 1;
            this.queueRelayUsage(outgoingChunk.byteLength);
            if (this.onRelayUsage) {
              this.onRelayUsage({ chunkSize: CHUNK_SIZE, chunks: 1 });
            }
          }
          await this.sendWithBackpressure(
            outgoingChunk,
            BUFFER_THRESHOLD,
            transfer.abortController.signal
          );
          this.throwIfTransferCancelled(transfer);
          chunkOffset += sliceSize;
          offset += sliceSize;
          transfer.bytesTransferred = offset;

          this.reportTransferProgress(offset, file.size, file.name, true);
        }
      }

      this.throwIfTransferCancelled(transfer);
      const deliveryPromise = this.createDeliveryWaiter(transfer.transferId, file.size);
      deliveryPromise.catch(() => {});

      try {
        await this.sendWithBackpressure(
          JSON.stringify({
            type: 'transfer-finished',
            transferId: transfer.transferId,
            size: file.size
          }),
          BUFFER_THRESHOLD,
          transfer.abortController.signal
        );
      } catch (err) {
        this.rejectDeliveryWaiter(transfer.transferId, err);
        throw err;
      }

      await deliveryPromise;
      this.stopNetworkDiagnostics();

      this.invokeSenderTerminalCallback(transfer, 'completed', () => {
        if (this.onFileTransferComplete) {
          this.onFileTransferComplete(null, file.name, {
            writeMode: 'send',
            connectionType: performanceProfile.connectionType,
            relayChunks: transfer.relayChunks,
            relayChunkSize: transfer.relayChunkSize
          });
        }
      });
    } catch (err) {
      this.stopNetworkDiagnostics();

      if (transfer.proRequired || err.name === 'ProRequiredError') {
        this.transitionSenderTerminalState(transfer, 'failed');
        throw this.createProRequiredError();
      }

      if (transfer.cancelled || err.name === 'AbortError') {
        this.transitionSenderTerminalState(transfer, 'cancelled');
        throw this.createTransferCancelledError();
      }

      if (['DELIVERY_ACK_TIMEOUT', 'DELIVERY_REJECTED'].includes(err.code)) {
        this.invokeSenderTerminalCallback(transfer, 'failed', () => {
          this.reportTransferError('protocol', err, file.name);
        });
      }

      this.transitionSenderTerminalState(transfer, 'failed');

      console.error('Error during file stream send:', err);
      throw err;
    } finally {
      this.rejectDeliveryWaiter(
        transfer.transferId,
        this.createDeliveryError('DELIVERY_ABORTED', 'Delivery confirmation was abandoned.')
      );
      this.flushRelayUsage();
      reader.releaseLock();
      if (this.activeSendTransfer === transfer) {
        this.activeSendTransfer = null;
      }
    }
  }

  createTransferId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  waitForReceiverReady(transfer) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.resumeWaiters.delete(transfer.transferId);
        resolve(null);
      }, this.RECEIVER_READY_TIMEOUT);

      this.resumeWaiters.set(transfer.transferId, { resolve, reject, timeout });
    });
  }

  rejectAllResumeWaiters(code, message) {
    for (const [transferId, waiter] of this.resumeWaiters.entries()) {
      this.resumeWaiters.delete(transferId);
      if (typeof waiter === 'function') {
        waiter(null);
      } else {
        clearTimeout(waiter.timeout);
        waiter.reject(this.createDeliveryError(code, message));
      }
    }
  }

  startNewPairingSession() {
    this.sessionGeneration += 1;
    this.completedTransfers.clear();
    this.completedTransferIds.clear();
    this.rejectAllDeliveryWaiters('SESSION_REPLACED', 'The paired session was replaced.');
    this.rejectAllResumeWaiters('SESSION_REPLACED', 'The paired session was replaced.');
    this.cleanupReceiverDiskStream().catch((err) => {
      console.error('Error cleaning receiver stream for a new pairing session:', err.message);
    });
    this.receiverState = this.createEmptyReceiverState();
  }

  isMobileDevice() {
    return typeof navigator !== 'undefined' && (
      navigator.userAgentData?.mobile === true ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
  }

  async selectPerformanceProfile() {
    const mobile = this.isMobileDevice();
    const connection = await this.getActiveCandidatePairDetails().catch(() => ({ connectionType: 'unknown' }));
    const networkInfo = typeof navigator !== 'undefined' ? navigator.connection : null;
    const saveData = Boolean(networkInfo && networkInfo.saveData);
    const slowNetwork = networkInfo && /(^|-)2g$/.test(networkInfo.effectiveType || '');
    const lowMemory = typeof navigator !== 'undefined' && Number(navigator.deviceMemory) > 0 && navigator.deviceMemory <= 4;

    let chunkSize = mobile ? this.CHUNK_SIZE : this.DESKTOP_CHUNK_SIZE;
    let bufferThreshold = 8 * 1024 * 1024;
    let lowThreshold = 2 * 1024 * 1024;
    let label = 'Directa veloz';

    if (connection.connectionType === 'relay') {
      chunkSize = mobile ? this.FALLBACK_CHUNK_SIZE : this.CHUNK_SIZE;
      bufferThreshold = 4 * 1024 * 1024;
      lowThreshold = 1 * 1024 * 1024;
      label = 'Relay optimizado';
    } else if (connection.connectionType === 'srflx') {
      chunkSize = mobile ? this.FALLBACK_CHUNK_SIZE : this.CHUNK_SIZE;
      bufferThreshold = 4 * 1024 * 1024;
      lowThreshold = 1 * 1024 * 1024;
      label = 'Directa adaptable';
    } else if (connection.connectionType === 'unknown') {
      chunkSize = this.CHUNK_SIZE;
      bufferThreshold = 4 * 1024 * 1024;
      lowThreshold = 1 * 1024 * 1024;
      label = 'Compatibilidad segura';
    }

    if (saveData || slowNetwork || lowMemory) {
      chunkSize = Math.min(chunkSize, this.FALLBACK_CHUNK_SIZE);
      bufferThreshold = Math.min(bufferThreshold, 2 * 1024 * 1024);
      lowThreshold = Math.min(lowThreshold, 512 * 1024);
      label = 'Ahorro de red';
    }

    const maxMessageSize = this.peerConnection?.sctp?.maxMessageSize;
    if (Number.isFinite(maxMessageSize) && maxMessageSize > 0) {
      const safeSctpLimit = Math.max(16 * 1024, Math.floor(maxMessageSize * 0.75));
      chunkSize = Math.min(chunkSize, safeSctpLimit);
    }

    const profile = {
      connectionType: connection.connectionType,
      chunkSize,
      bufferThreshold,
      lowThreshold,
      label
    };

    this.currentPerformanceProfile = profile;
    return profile;
  }

  async getAdaptiveChunkSize() {
    return (await this.selectPerformanceProfile()).chunkSize;
  }

  setRelayBudget(budget = {}) {
    const limitBytes = Number.isSafeInteger(budget.limitBytes) && budget.limitBytes >= 0
      ? budget.limitBytes
      : Number.POSITIVE_INFINITY;
    const usedBytes = Number.isSafeInteger(budget.usedBytes) && budget.usedBytes >= 0
      ? Math.min(budget.usedBytes, limitBytes)
      : 0;

    this.relayBudget = {
      plan: budget.plan === 'pro' ? 'pro' : 'free',
      limitBytes,
      usedBytes,
      blocked: Boolean(budget.blocked)
    };
  }

  reserveRelayBudget(bytes) {
    if (this.relayBudget.plan === 'pro') return true;
    if (this.relayBudget.blocked || this.relayBudget.usedBytes + bytes > this.relayBudget.limitBytes) {
      this.relayBudget.blocked = true;
      this.flushRelayUsage();
      this.socketManager.requestRelayUpgrade();
      return false;
    }

    this.relayBudget.usedBytes += bytes;
    return true;
  }

  queueRelayUsage(bytes) {
    this.pendingRelayUsageBytes += bytes;
    if (this.pendingRelayUsageBytes >= 1024 * 1024) this.flushRelayUsage();
  }

  flushRelayUsage() {
    if (!this.pendingRelayUsageBytes) return;
    this.socketManager.sendRelayUsage(this.pendingRelayUsageBytes);
    this.pendingRelayUsageBytes = 0;
  }

  createProRequiredError() {
    const error = new Error('The free relay limit has been reached.');
    error.name = 'ProRequiredError';
    error.code = 'RELAY_LIMIT_REACHED';
    return error;
  }

  notifyPeerTransferCancelled(transfer) {
    this.sendDeliveryControl({
      type: 'transfer-cancelled',
      transferId: transfer.transferId
    });
  }

  handleProRequired() {
    this.relayBudget.blocked = true;
    const transfer = this.activeSendTransfer;
    if (!transfer || transfer.connectionType !== 'relay' || transfer.proRequired) return;

    transfer.proRequired = true;
    transfer.abortController.abort();
    if (transfer.reader) transfer.reader.cancel().catch(() => {});
    this.notifyPeerTransferCancelled(transfer);
    const error = this.createProRequiredError();
    const settled = this.rejectDeliveryWaiter(transfer.transferId, error, 'failed');
    if (!settled) this.transitionSenderTerminalState(transfer, 'failed');
    this.invokeSenderTerminalCallback(transfer, 'failed', () => {
      this.reportTransferError('relay-budget', error, transfer.fileName);
    });
  }

  reportTransferProgress(bytesTransferred, totalBytes, fileName, isSending) {
    if (this.onFileTransferProgress) {
      this.onFileTransferProgress(bytesTransferred, totalBytes, fileName, isSending);
    }
  }

  throwIfTransferCancelled(transfer) {
    if (transfer.cancelled) {
      const err = new Error('Transfer cancelled.');
      err.name = 'AbortError';
      throw err;
    }
    if (transfer.channelGeneration !== this.dataChannelGeneration) {
      throw this.createDeliveryError(
        'DATA_CHANNEL_REPLACED',
        'Data connection was replaced during transfer.'
      );
    }
  }

  cancelActiveTransfer() {
    const transfer = this.activeSendTransfer;
    if (!transfer || transfer.cancelled || transfer.terminalState) return false;

    const cancelError = this.createTransferCancelledError();
    const settled = this.rejectDeliveryWaiter(transfer.transferId, cancelError, 'cancelled');
    if (!settled && !this.transitionSenderTerminalState(transfer, 'cancelled')) return false;
    transfer.cancelled = true;
    transfer.abortController.abort();
    this.stopNetworkDiagnostics();

    if (transfer.reader) {
      transfer.reader.cancel().catch(() => {});
    }

    this.sendDeliveryControl({
      type: 'transfer-cancelled',
      transferId: transfer.transferId
    });

    this.invokeSenderTerminalCallback(transfer, 'cancelled', () => {
      if (this.onFileTransferCancelled) this.onFileTransferCancelled(transfer.fileName, true);
    });

    return true;
  }

  waitForBufferedAmountLow(signal) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      return Promise.reject(new Error('Data connection closed during transfer.'));
    }

    if (signal && signal.aborted) {
      const err = new Error('Transfer cancelled.');
      err.name = 'AbortError';
      return Promise.reject(err);
    }

    const channel = this.dataChannel;

    return new Promise((resolve, reject) => {
      let pollTimer = null;
      let settled = false;

      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', handleLow);
        channel.removeEventListener('close', handleClose);
        channel.removeEventListener('error', handleError);
        if (signal) signal.removeEventListener('abort', handleAbort);
        if (pollTimer) clearInterval(pollTimer);
      };

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };

      const handleLow = () => {
        if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
          finish(resolve);
        }
      };

      const handleClose = () => {
        finish(reject, new Error('Data connection closed during transfer.'));
      };

      const handleError = () => {
        finish(reject, new Error('Data connection error during transfer.'));
      };

      const handleAbort = () => {
        const err = new Error('Transfer cancelled.');
        err.name = 'AbortError';
        finish(reject, err);
      };

      channel.addEventListener('bufferedamountlow', handleLow);
      channel.addEventListener('close', handleClose);
      channel.addEventListener('error', handleError);
      if (signal) signal.addEventListener('abort', handleAbort, { once: true });

      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        handleLow();
        return;
      }

      // Some browsers do not dispatch bufferedamountlow consistently under load.
      pollTimer = setInterval(handleLow, 100);
    });
  }

  async sendWithBackpressure(data, highWaterMark, signal) {
    const byteLength = typeof data === 'string'
      ? new TextEncoder().encode(data).byteLength
      : Number(data && (data.byteLength || data.size)) || 0;
    let queueFullRetries = 0;

    while (true) {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error('Data connection closed during transfer.');
      }

      if (signal && signal.aborted) {
        const err = new Error('Transfer cancelled.');
        err.name = 'AbortError';
        throw err;
      }

      const channel = this.dataChannel;
      if (channel.bufferedAmount + byteLength > highWaterMark) {
        await this.waitForBufferedAmountLow(signal);
        continue;
      }

      try {
        channel.send(data);
        return;
      } catch (err) {
        const queueIsFull = err && (
          /queue is full|send queue|bufferedamount/i.test(err.message || '') ||
          (err.name === 'OperationError' && channel.bufferedAmount > channel.bufferedAmountLowThreshold)
        );

        if (!queueIsFull || queueFullRetries >= 3) throw err;

        queueFullRetries += 1;
        console.warn('[AirDows] RTCDataChannel queue full, waiting before retry', {
          retry: queueFullRetries,
          bufferedAmount: channel.bufferedAmount,
          chunkBytes: byteLength
        });
        await this.waitForBufferedAmountLow(signal);
      }
    }
  }

  startNetworkDiagnostics(transferInfo) {
    this.stopNetworkDiagnostics();

    this.diagnosticsTransfer = transferInfo;
    this.lastDiagnosticsBytes = transferInfo.getBytesTransferred();
    this.lastDiagnosticsTimestamp = performance.now();

    this.emitNetworkDiagnostics().catch((err) => {
      console.warn('Initial WebRTC diagnostics failed:', err);
    });

    this.diagnosticsInterval = setInterval(() => {
      this.emitNetworkDiagnostics().catch((err) => {
        console.warn('WebRTC diagnostics failed:', err);
      });
    }, 2000);
  }

  stopNetworkDiagnostics() {
    if (this.diagnosticsInterval) {
      clearInterval(this.diagnosticsInterval);
      this.diagnosticsInterval = null;
    }

    this.diagnosticsTransfer = null;
    this.lastDiagnosticsBytes = 0;
    this.lastDiagnosticsTimestamp = 0;
  }

  async emitNetworkDiagnostics() {
    if (!this.peerConnection || !this.diagnosticsTransfer || !this.onNetworkDiagnostics) return;

    const now = performance.now();
    const bytesTransferred = this.diagnosticsTransfer.getBytesTransferred();
    const elapsedSeconds = Math.max((now - this.lastDiagnosticsTimestamp) / 1000, 0.001);
    const speed = Math.max((bytesTransferred - this.lastDiagnosticsBytes) / elapsedSeconds, 0);
    const percent = this.diagnosticsTransfer.totalBytes > 0
      ? Math.min(100, (bytesTransferred / this.diagnosticsTransfer.totalBytes) * 100)
      : 0;

    const connection = await this.getActiveCandidatePairDetails();
    const metrics = {
      connectionType: connection.connectionType,
      speed,
      qualityLabel: this.getQualityLabel(connection.connectionType, speed),
      isLocal: connection.connectionType === 'host',
      percent,
      direction: this.diagnosticsTransfer.direction,
      fileName: this.diagnosticsTransfer.fileName
    };

    this.transferDiagnostics.bytesTransferred = bytesTransferred;
    this.transferDiagnostics.totalBytes = this.diagnosticsTransfer.totalBytes;
    this.transferDiagnostics.percent = percent;
    this.transferDiagnostics.speedBytesPerSecond = speed;
    this.transferDiagnostics.speedMBps = speed / (1024 * 1024);
    this.transferDiagnostics.direction = this.diagnosticsTransfer.direction;
    this.transferDiagnostics.fileName = this.diagnosticsTransfer.fileName;
    this.transferDiagnostics.updatedAt = new Date().toISOString();

    console.info('[AirDows] Transfer metrics', {
      fileName: this.transferDiagnostics.fileName,
      direction: this.transferDiagnostics.direction,
      speedMBps: Number(this.transferDiagnostics.speedMBps.toFixed(2)),
      percent: Number(this.transferDiagnostics.percent.toFixed(2)),
      bytes: `${bytesTransferred}/${this.transferDiagnostics.totalBytes}`
    });

    this.lastDiagnosticsBytes = bytesTransferred;
    this.lastDiagnosticsTimestamp = now;
    this.lastDiagnosticsMetrics = metrics;
    this.onNetworkDiagnostics(metrics);
  }

  calculatePercent(bytesTransferred, totalBytes) {
    return totalBytes > 0
      ? Math.min(100, (bytesTransferred / totalBytes) * 100)
      : 0;
  }

  reportTransferError(type, error, fileName = null) {
    const payload = {
      type,
      message: error && error.message ? error.message : String(error),
      fileName
    };

    console.error('[AirDows] Transfer error', payload);
    if (this.onTransferError) {
      this.onTransferError(payload);
    }
  }

  async getActiveCandidatePairDetails() {
    const fallback = {
      connectionType: 'unknown',
      localCandidateType: 'unknown',
      remoteCandidateType: 'unknown'
    };

    if (!this.peerConnection) return fallback;

    const stats = await this.peerConnection.getStats();
    let activePair = null;

    stats.forEach((report) => {
      const isCandidatePair = report.type === 'candidate-pair';
      const isActive = report.selected === true || report.nominated === true || report.state === 'succeeded';
      if (isCandidatePair && isActive) {
        activePair = report;
      }
    });

    if (!activePair) return fallback;

    const localCandidate = stats.get(activePair.localCandidateId);
    const remoteCandidate = stats.get(activePair.remoteCandidateId);
    const localCandidateType = localCandidate && localCandidate.candidateType
      ? localCandidate.candidateType
      : 'unknown';
    const remoteCandidateType = remoteCandidate && remoteCandidate.candidateType
      ? remoteCandidate.candidateType
      : 'unknown';

    return {
      connectionType: this.resolveConnectionType(localCandidateType, remoteCandidateType),
      localCandidateType,
      remoteCandidateType
    };
  }

  resolveConnectionType(localCandidateType, remoteCandidateType) {
    if (localCandidateType === 'relay' || remoteCandidateType === 'relay') return 'relay';
    if (localCandidateType === 'host' && remoteCandidateType === 'host') return 'host';
    if (localCandidateType === 'srflx' || remoteCandidateType === 'srflx') return 'srflx';
    return localCandidateType || remoteCandidateType || 'unknown';
  }

  getQualityLabel(connectionType, speed) {
    if (connectionType === 'relay') return 'Relay TURN';
    if (connectionType === 'host' && speed >= 10 * 1024 * 1024) return 'Local rapida';
    if (connectionType === 'host') return 'Red local';
    if (connectionType === 'srflx' && speed >= 3 * 1024 * 1024) return 'Directa estable';
    if (connectionType === 'srflx') return 'Directa limitada';
    return 'Analizando red';
  }

  sendClipboardText(text) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data connection is not ready or open yet!');
    }

    this.dataChannel.send(JSON.stringify({
      type: 'clipboard',
      text: text
    }));
  }

  close() {
    console.log('Cleaning up WebRTC connections...');
    this.isClosing = true;
    this.recoveryPrepared = false;
    this.sessionGeneration += 1;
    this.peerConnectionGeneration += 1;
    this.dataChannelGeneration += 1;
    this.stopNetworkDiagnostics();

    if (this.activeSendTransfer) {
      this.activeSendTransfer.cancelled = true;
      this.activeSendTransfer.abortController.abort();
      const cancelError = this.createTransferCancelledError('WebRTC closed during transfer.');
      const settled = this.rejectDeliveryWaiter(
        this.activeSendTransfer.transferId,
        cancelError,
        'cancelled'
      );
      if (!settled) this.transitionSenderTerminalState(this.activeSendTransfer, 'cancelled');
    }
    this.rejectAllDeliveryWaiters('WEBRTC_CLOSED', 'WebRTC was closed before delivery confirmation.');
    this.rejectAllResumeWaiters('WEBRTC_CLOSED', 'WebRTC was closed before receiver readiness.');

    this.cleanupReceiverDiskStream().catch((err) => {
      console.error('Error cleaning receiver disk stream during close:', err);
    });

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (e) {}
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (e) {}
      this.peerConnection = null;
    }

    this.role = null;
    this.roomCode = null;
    this.activeSendTransfer = null;
    this.signalQueueGeneration += 1;
    this.pendingSignals = [];
    this.pendingRemoteCandidates = [];
    this.resumeWaiters.clear();
    this.deliveryWaiters.clear();
    this.completedTransfers.clear();
    this.completedTransferIds.clear();
    this.incomingMessageChain = Promise.resolve();
    this.encryption = this.createEncryptionState();
    this.receiverState = this.createEmptyReceiverState();
  }

  reconnect(role = this.role, roomCode = this.roomCode) {
    if (!role || !roomCode || !this.rtcConfig) {
      return false;
    }

    this.role = role;
    this.roomCode = roomCode;
    console.log('WebRTC: recreating peer connection for automatic reconnection.');
    this.prepareForRecovery();
    this.isClosing = false;
    this.recoveryPrepared = false;

    this.createPeerConnection();
    this.flushPendingSignals();

    if (this.role === 'initiator') {
      this.createDataChannel();
      this.createOffer();
    }

    return true;
  }

  prepareForRecovery() {
    if (this.recoveryPrepared) return true;
    this.recoveryPrepared = true;
    this.peerConnectionGeneration += 1;
    this.dataChannelGeneration += 1;
    this.signalQueueGeneration += 1;
    this.stopNetworkDiagnostics();
    this.rejectAllDeliveryWaiters('DATA_CHANNEL_REPLACED', 'Data connection was replaced.');
    this.rejectAllResumeWaiters('DATA_CHANNEL_REPLACED', 'Data connection was replaced before receiver readiness.');
    this.pendingSignals = [];
    this.pendingRemoteCandidates = [];
    this.incomingMessageChain = Promise.resolve();

    if (this.activeSendTransfer && this.activeSendTransfer.reader) {
      this.activeSendTransfer.reader.cancel().catch(() => {});
    }

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (err) {}
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (err) {}
      this.peerConnection = null;
    }

    return true;
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = WebRTCManager;
}
