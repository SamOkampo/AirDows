class WebRTCManager {
  constructor(socketManager) {
    this.CHUNK_SIZE = 65536;
    this.BUFFER_THRESHOLD = 4194304;
    this.RECEIVER_READY_TIMEOUT = 15000;
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
    this.onNetworkDiagnostics = null; // ({ connectionType, speed, qualityLabel, isLocal, percent })

    this.receiverState = this.createEmptyReceiverState();

    // Configuracion ICE (STUN/TURN) - se recibe dinamicamente desde el servidor.
    this.rtcConfig = null;
    this.pendingSignals = [];
    this.pendingRemoteCandidates = [];
    this.isClosing = false;
    this.activeSendTransfer = null;
    this.resumeWaiters = new Map();

    this.diagnosticsInterval = null;
    this.diagnosticsTransfer = null;
    this.lastDiagnosticsBytes = 0;
    this.lastDiagnosticsTimestamp = 0;
    this.lastDiagnosticsMetrics = null;
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
      writeFailed: false
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

    this.role = role;
    this.roomCode = roomCode;
    this.isClosing = false;
    console.log(`Initializing WebRTC as ${role} in room ${roomCode}`);

    this.createPeerConnection();
    this.flushPendingSignals();

    if (this.role === 'initiator') {
      this.createDataChannel();
      this.createOffer();
    }
  }

  createPeerConnection() {
    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('Sending local ICE Candidate to peer');
        this.socketManager.sendSignal(this.roomCode, {
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state: ${this.peerConnection.connectionState}`);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.peerConnection.connectionState);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log(`ICE connection state: ${this.peerConnection.iceConnectionState}`);
      if (this.peerConnection.iceConnectionState === 'failed') {
        console.error('ICE failed: no compatible host, STUN or TURN candidate pair was found.');
      }
    };

    this.peerConnection.onicecandidateerror = (event) => {
      console.error('ICE candidate error:', {
        url: event.url,
        errorCode: event.errorCode,
        errorText: event.errorText
      });
    };

    if (this.role === 'receiver') {
      this.peerConnection.ondatachannel = (event) => {
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
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = this.BUFFER_THRESHOLD / 2;

    this.dataChannel.onopen = () => {
      console.log('Data channel state is: OPEN');
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange('connected');
      }
    };

    this.dataChannel.onclose = () => {
      console.log('Data channel state is: CLOSED');
      this.stopNetworkDiagnostics();
      if (!this.isClosing && this.onConnectionStateChange) {
        this.onConnectionStateChange('disconnected');
      }
    };

    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.cleanupReceiverDiskStream().catch((err) => {
        console.error('Error cleaning receiver stream after data channel error:', err);
      });
    };

    this.dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data).catch((err) => {
        console.error('Error handling incoming WebRTC message:', err);
        this.cleanupReceiverDiskStream().catch((cleanupErr) => {
          console.error('Error cleaning receiver stream after incoming message failure:', cleanupErr);
        });
      });
    };
  }

  async handleSignal(data) {
    if (!this.peerConnection) {
      console.warn('WebRTC signal received before peer connection was ready. Queueing it.');
      this.pendingSignals.push(data);
      return;
    }

    try {
      if (data.type === 'offer') {
        console.log('Received SDP Offer, creating Answer...');
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        await this.flushPendingRemoteCandidates();
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        this.socketManager.sendSignal(this.roomCode, {
          type: 'answer',
          answer: answer
        });
      } else if (data.type === 'answer') {
        console.log('Received SDP Answer...');
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        await this.flushPendingRemoteCandidates();
      } else if (data.type === 'candidate') {
        console.log('Received remote ICE candidate');
        if (!this.peerConnection.remoteDescription) {
          this.pendingRemoteCandidates.push(data.candidate);
          return;
        }
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
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
      this.handleSignal(signal);
    });
  }

  async flushPendingRemoteCandidates() {
    if (!this.pendingRemoteCandidates.length || !this.peerConnection.remoteDescription) return;

    const candidates = [...this.pendingRemoteCandidates];
    this.pendingRemoteCandidates = [];

    for (const candidate of candidates) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  async createOffer() {
    try {
      console.log('Creating SDP Offer...');
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.socketManager.sendSignal(this.roomCode, {
        type: 'offer',
        offer: offer
      });
    } catch (err) {
      console.error('Error creating SDP Offer:', err);
    }
  }

  async handleIncomingMessage(data) {
    if (typeof data === 'string') {
      await this.handleIncomingTextMessage(data);
      return;
    }

    if (data instanceof ArrayBuffer) {
      await this.handleIncomingFileChunk(data);
      return;
    }

    console.warn('Received unsupported data channel payload:', data);
  }

  async handleIncomingFileChunk(data) {
    const state = this.receiverState;
    if (!state.metadata) {
      console.error('Received binary chunk without file metadata!');
      return;
    }

    if (state.receivedSize + data.byteLength > state.metadata.size) {
      throw new Error('Se recibió más información de la esperada.');
    }

    if (state.writeMode === 'disk' && state.writable) {
      try {
        state.writeChain = state.writeChain.then(() => state.writable.write(data));
        await state.writeChain;
      } catch (err) {
        state.writeFailed = true;
        await this.abortReceiverDiskStream();
        throw new Error(`No se pudo escribir el archivo en disco: ${err.message}`);
      }
    } else {
      state.receivedBuffers.push(data);
    }

    state.receivedSize += data.byteLength;
    this.reportTransferProgress(state.receivedSize, state.metadata.size, state.metadata.name, false);

    if (state.receivedSize >= state.metadata.size) {
      await this.finalizeIncomingFile();
    }
  }

  async handleIncomingTextMessage(rawText) {
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
        console.error('Received invalid file metadata:', message);
        await this.resetReceiverState();
        return;
      }

      await this.prepareIncomingFile(message);
      this.sendReceiverReady(message.transferId);
      return;
    }

    if (message.type === 'receiver-ready') {
      const waiter = this.resumeWaiters.get(message.transferId);
      if (waiter) {
        this.resumeWaiters.delete(message.transferId);
        waiter(Math.max(0, Math.min(Number(message.offset) || 0, Number(message.size) || 0)));
      }
      return;
    }

    if (message.type === 'resume-offset') {
      const waiter = this.resumeWaiters.get(message.transferId);
      if (waiter) {
        this.resumeWaiters.delete(message.transferId);
        waiter(Math.max(0, Math.min(Number(message.offset) || 0, Number(message.size) || 0)));
      }
      return;
    }

    if (message.type === 'clipboard') {
      if (typeof message.text !== 'string') {
        console.error('Received clipboard message without text payload:', message);
        return;
      }
      this.emitClipboardMessage(message.text);
      return;
    }

    if (message.type === 'transfer-cancelled') {
      const fileName = typeof message.name === 'string' ? message.name : '';
      await this.cleanupReceiverDiskStream();
      await this.resetReceiverState();
      this.stopNetworkDiagnostics();

      if (this.onFileTransferCancelled) {
        this.onFileTransferCancelled(fileName, false);
      }
      return;
    }

    console.warn('Unknown JSON data channel message type:', message.type);
  }

  async prepareIncomingFile(metadata) {
    const current = this.receiverState;
    const canResume = current.metadata &&
      current.metadata.transferId === metadata.transferId &&
      current.metadata.name === metadata.name &&
      current.metadata.size === metadata.size &&
      current.receivedSize > 0;

    if (canResume) {
      console.log(`Resuming incoming transfer at byte ${current.receivedSize}`);
      if (current.writeMode === 'disk' && current.writable) {
        await current.writeChain;
        await current.writable.seek(current.receivedSize);
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
        supportsDiskWrite: this.supportsDiskWriteMode()
      });
    }

    this.startNetworkDiagnostics({
      direction: 'receive',
      fileName: metadata.name,
      totalBytes: metadata.size,
      getBytesTransferred: () => this.receiverState.receivedSize
    });
  }

  sendReceiverReady(transferId) {
    if (!transferId || !this.dataChannel || this.dataChannel.readyState !== 'open') return;

    const state = this.receiverState;
    const offset = state.metadata && state.metadata.transferId === transferId
      ? state.receivedSize
      : 0;

    this.dataChannel.send(JSON.stringify({
      type: 'receiver-ready',
      transferId,
      offset,
      size: state.metadata ? state.metadata.size : 0,
      writeMode: state.writeMode
    }));
  }

  async finalizeIncomingFile() {
    const state = this.receiverState;
    const metadata = state.metadata;
    if (!metadata) return;

    this.stopNetworkDiagnostics();

    if (state.writeMode === 'disk' && state.writable) {
      try {
        await state.writeChain;
        await state.writable.close();
        state.writable = null;

        if (this.onFileTransferComplete) {
          this.onFileTransferComplete(null, metadata.name, {
            writeMode: 'disk',
            savedToDisk: true
          });
        }
      } catch (err) {
        console.error('Error finalizing direct-to-disk file:', err);
        await this.cleanupReceiverDiskStream();
        throw err;
      } finally {
        this.receiverState = this.createEmptyReceiverState();
      }
      return;
    }

    console.log('File transfer complete, reconstructing blob...');
    const fileBlob = new Blob(state.receivedBuffers, { type: metadata.mime });

    if (this.onFileTransferComplete) {
      this.onFileTransferComplete(fileBlob, metadata.name, {
        writeMode: 'memory',
        savedToDisk: false
      });
    }

    this.receiverState = this.createEmptyReceiverState();
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
      typeof message.transferId === 'string' &&
      message.transferId.trim().length > 0 &&
      Number.isSafeInteger(message.size) &&
      message.size >= 0 &&
      typeof message.mime === 'string' &&
      message.mime.trim().length > 0
    );
  }

  emitClipboardMessage(text) {
    console.log('Received clipboard text:', text);
    if (this.onClipboardMessage) {
      this.onClipboardMessage(text);
    }
  }

  async sendFile(file) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data connection is not ready or open yet!');
    }

    const CHUNK_SIZE = this.CHUNK_SIZE;
    const BUFFER_THRESHOLD = this.BUFFER_THRESHOLD;

    const transfer = {
      fileName: file.name,
      transferId: crypto.randomUUID(),
      reader: null,
      cancelled: false,
      abortController: new AbortController(),
      bytesTransferred: 0,
      totalBytes: file.size
    };
    this.activeSendTransfer = transfer;

    if (this.onFileTransferStart) {
      this.onFileTransferStart(file.name, file.size, true, {
        writeMode: 'send'
      });
    }

    const metadata = {
      type: 'metadata',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      transferId: transfer.transferId
    };
    this.dataChannel.send(JSON.stringify(metadata));

    let resumeOffset;
    try {
      resumeOffset = await this.waitForReceiverReady(transfer);
      if (resumeOffset === null) {
        throw new Error('El receptor no confirmó que está listo para recibir.');
      }
    } catch (err) {
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

          if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
            await this.waitForBufferedAmountLow(transfer.abortController.signal);
          }

          this.throwIfTransferCancelled(transfer);
          if (this.dataChannel.readyState !== 'open') {
            throw new Error('Data connection closed during transfer.');
          }

          this.dataChannel.send(chunk);
          chunkOffset += sliceSize;
          offset += sliceSize;
          transfer.bytesTransferred = offset;

          this.reportTransferProgress(offset, file.size, file.name, true);
        }
      }

      this.throwIfTransferCancelled(transfer);
      console.log('Finished sending all chunks for:', file.name);
      this.stopNetworkDiagnostics();

      if (this.onFileTransferComplete) {
        this.onFileTransferComplete(null, file.name, {
          writeMode: 'send'
        });
      }
    } catch (err) {
      this.stopNetworkDiagnostics();

      if (transfer.cancelled || err.name === 'AbortError') {
        const cancelError = new Error('Transfer cancelled.');
        cancelError.name = 'TransferCancelledError';
        throw cancelError;
      }

      console.error('Error during file stream send:', err);
      throw err;
    } finally {
      reader.releaseLock();
      if (this.activeSendTransfer === transfer) {
        this.activeSendTransfer = null;
      }
    }
  }

  waitForReceiverReady(transfer) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.resumeWaiters.delete(transfer.transferId);
        resolve(null);
      }, this.RECEIVER_READY_TIMEOUT);

      this.resumeWaiters.set(transfer.transferId, (offset) => {
        clearTimeout(timeout);
        resolve(offset);
      });
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
  }

  cancelActiveTransfer() {
    const transfer = this.activeSendTransfer;
    if (!transfer || transfer.cancelled) return false;

    transfer.cancelled = true;
    transfer.abortController.abort();
    this.stopNetworkDiagnostics();

    if (transfer.reader) {
      transfer.reader.cancel().catch(() => {});
    }

    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({
        type: 'transfer-cancelled',
        name: transfer.fileName
      }));
    }

    if (this.onFileTransferCancelled) {
      this.onFileTransferCancelled(transfer.fileName, true);
    }

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
      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', handleLow);
        channel.removeEventListener('close', handleClose);
        channel.removeEventListener('error', handleError);
        if (signal) signal.removeEventListener('abort', handleAbort);
      };

      const handleLow = () => {
        cleanup();
        resolve();
      };

      const handleClose = () => {
        cleanup();
        reject(new Error('Data connection closed during transfer.'));
      };

      const handleError = () => {
        cleanup();
        reject(new Error('Data connection error during transfer.'));
      };

      const handleAbort = () => {
        cleanup();
        const err = new Error('Transfer cancelled.');
        err.name = 'AbortError';
        reject(err);
      };

      channel.addEventListener('bufferedamountlow', handleLow, { once: true });
      channel.addEventListener('close', handleClose, { once: true });
      channel.addEventListener('error', handleError, { once: true });
      if (signal) signal.addEventListener('abort', handleAbort, { once: true });

      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        handleLow();
      }
    });
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

    this.lastDiagnosticsBytes = bytesTransferred;
    this.lastDiagnosticsTimestamp = now;
    this.lastDiagnosticsMetrics = metrics;
    this.onNetworkDiagnostics(metrics);
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
    this.stopNetworkDiagnostics();

    if (this.activeSendTransfer) {
      this.activeSendTransfer.cancelled = true;
      this.activeSendTransfer.abortController.abort();
    }

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
    this.pendingSignals = [];
    this.pendingRemoteCandidates = [];
    this.resumeWaiters.clear();
    this.receiverState = this.createEmptyReceiverState();
  }

  reconnect() {
    if (!this.role || !this.roomCode || !this.rtcConfig) {
      return false;
    }

    console.log('WebRTC: recreating peer connection for automatic reconnection.');
    this.isClosing = false;
    this.stopNetworkDiagnostics();
    this.pendingSignals = [];
    this.pendingRemoteCandidates = [];

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

    this.createPeerConnection();

    if (this.role === 'initiator') {
      this.createDataChannel();
      this.createOffer();
    }

    return true;
  }
}
