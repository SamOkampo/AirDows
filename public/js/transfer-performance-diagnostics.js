(function attachTransferPerformanceDiagnostics(root, factory) {
  const TransferPerformanceDiagnostics = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = TransferPerformanceDiagnostics;
  }

  if (root) {
    root.AirDowsTransferPerformanceDiagnostics = TransferPerformanceDiagnostics;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDiagnosticsModule() {
  'use strict';

  const ROUTES = new Set(['host', 'srflx', 'relay', 'unknown']);
  const DIRECTIONS = new Set(['send', 'receive']);
  const RECEIVER_MODES = new Set(['memory', 'disk', 'send', 'unknown']);
  const PERFORMANCE_PROFILES = new Set([
    'Directa veloz',
    'Relay optimizado',
    'Directa adaptable',
    'Compatibilidad segura',
    'Ahorro de red',
    'Modo inteligente',
    'unknown'
  ]);

  function finiteNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  }

  function safeInteger(value, fallback = 0) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  function elapsed(start, end) {
    return Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, end - start)
      : null;
  }

  function cloneSnapshot(snapshot) {
    return snapshot ? { ...snapshot } : null;
  }

  function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function defaultEpochNow() {
    if (typeof performance !== 'undefined' &&
        Number.isFinite(performance.timeOrigin) &&
        typeof performance.now === 'function') {
      return performance.timeOrigin + performance.now();
    }
    return Date.now();
  }

  class TransferPerformanceDiagnostics {
    constructor(options = {}) {
      this.now = typeof options.now === 'function' ? options.now : defaultNow;
      this.epochNow = typeof options.epochNow === 'function' ? options.epochNow : defaultEpochNow;
      this.maxCompleted = Number.isSafeInteger(options.maxCompleted)
        ? Math.max(1, options.maxCompleted)
        : 20;
      this.connectionSequence = 0;
      this.transferSequence = 0;
      this.connection = null;
      this.activeTransfer = null;
      this.completedTransfers = [];
    }

    beginPairing(options = {}) {
      const now = this.readNow();
      const generation = Number.isSafeInteger(options.generation)
        ? options.generation
        : this.connectionSequence + 1;

      this.connectionSequence += 1;
      this.connection = {
        generation,
        sequence: this.connectionSequence,
        pairingStartedAt: now,
        pairedAt: null,
        dataChannelOpenedAt: null,
        dataChannelState: 'connecting'
      };
      return generation;
    }

    markPaired(generation = this.connection && this.connection.generation) {
      const connection = this.resolveConnection(generation);
      if (!connection) return false;
      if (connection.pairedAt === null) connection.pairedAt = this.readNow();
      return true;
    }

    markDataChannelState(state, generation = this.connection && this.connection.generation) {
      const connection = this.resolveConnection(generation);
      if (!connection || typeof state !== 'string') return false;

      connection.dataChannelState = state;
      if (state === 'open' && connection.dataChannelOpenedAt === null) {
        connection.dataChannelOpenedAt = this.readNow();
      }
      return true;
    }

    startTransfer(transferIdOrOptions = {}, transferOptions = {}) {
      const options = typeof transferIdOrOptions === 'string'
        ? { ...transferOptions, transferId: transferIdOrOptions }
        : transferIdOrOptions;
      if (!this.isValidTransferId(options.transferId)) return null;

      const now = this.readNow();
      const generation = Number.isSafeInteger(options.generation)
        ? options.generation
        : this.transferSequence + 1;
      const current = this.activeTransfer;

      if (current &&
          current.transferId === options.transferId &&
          current.generation === generation) {
        return this.toPublicTransfer(current);
      }

      this.transferSequence += 1;
      this.activeTransfer = {
        transferId: options.transferId,
        generation,
        sessionGeneration: Number.isSafeInteger(options.sessionGeneration)
          ? options.sessionGeneration
          : this.connection && this.connection.generation,
        sequence: this.transferSequence,
        status: 'active',
        direction: DIRECTIONS.has(options.direction) ? options.direction : 'send',
        totalBytes: safeInteger(options.totalBytes),
        bytesTransferred: 0,
        route: ROUTES.has(options.route) ? options.route : 'unknown',
        performanceProfile: PERFORMANCE_PROFILES.has(options.performanceProfile)
          ? options.performanceProfile
          : 'unknown',
        chunkSize: safeInteger(options.chunkSize),
        bufferThreshold: safeInteger(options.bufferThreshold),
        receiverMode: RECEIVER_MODES.has(options.receiverMode)
          ? options.receiverMode
          : 'unknown',
        selectedAt: Number.isFinite(options.selectedAt) && options.selectedAt <= now
          ? options.selectedAt
          : now,
        startedAt: now,
        firstByteAt: null,
        dataFinishedAt: null,
        senderEnqueueStartedAt: null,
        senderEnqueueFinishedAt: null,
        senderEnqueueStartedAtEpochMs: null,
        senderEnqueueFinishedAtEpochMs: null,
        senderBufferedAmountBeforeTerminalBytes: null,
        senderBufferedAmountAfterTerminalBytes: null,
        receiverFirstByteArrivedAt: null,
        receiverFirstByteArrivedAtEpochMs: null,
        receiverLastByteArrivedAt: null,
        receiverLastByteArrivedAtEpochMs: null,
        receiverTerminalArrivedAt: null,
        receiverTerminalArrivedAtEpochMs: null,
        receiverFinalizationStartedAt: null,
        receiverFinalizationFinishedAt: null,
        terminalSentAt: null,
        terminalSentAtEpochMs: null,
        ackSentAt: null,
        ackSentAtEpochMs: null,
        ackReceivedAt: null,
        ackReceivedAtEpochMs: null,
        completedAt: null,
        encryptionTimeMs: 0,
        backpressureWaitMs: 0,
        backpressurePauses: 0,
        completionCount: 0
      };

      return this.toPublicTransfer(this.activeTransfer);
    }

    updateTransfer(transferId, updates = {}, generation) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return false;
      }

      let updated = false;
      if (Object.prototype.hasOwnProperty.call(updates, 'route')) {
        transfer.route = ROUTES.has(updates.route) ? updates.route : 'unknown';
        updated = true;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'performanceProfile')) {
        transfer.performanceProfile = PERFORMANCE_PROFILES.has(updates.performanceProfile)
          ? updates.performanceProfile
          : 'unknown';
        updated = true;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'chunkSize')) {
        transfer.chunkSize = safeInteger(updates.chunkSize);
        updated = true;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'bufferThreshold')) {
        transfer.bufferThreshold = safeInteger(updates.bufferThreshold);
        updated = true;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'receiverMode')) {
        transfer.receiverMode = RECEIVER_MODES.has(updates.receiverMode)
          ? updates.receiverMode
          : 'unknown';
        updated = true;
      }
      return updated;
    }

    markFirstByte(transferId, observedBytes = undefined, generation = undefined) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer) return false;
      if (transfer.firstByteAt === null) transfer.firstByteAt = this.readNow();
      return true;
    }

    markBytes(transferId, bytesTransferred, generation = undefined) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer || !Number.isSafeInteger(bytesTransferred) || bytesTransferred < 0) {
        return false;
      }

      transfer.bytesTransferred = Math.max(
        transfer.bytesTransferred,
        Math.min(bytesTransferred, transfer.totalBytes)
      );
      return true;
    }

    markDataFinished(transferId, generation = undefined) {
      return this.markOnce(transferId, generation, 'dataFinishedAt');
    }

    markSenderEnqueueStart(transferId, generation = undefined, timing = undefined) {
      return this.markTimedOnce(
        transferId,
        generation,
        'senderEnqueueStartedAt',
        'senderEnqueueStartedAtEpochMs',
        timing
      );
    }

    markSenderEnqueueEnd(transferId, generation = undefined, timing = undefined) {
      return this.markTimedOnce(
        transferId,
        generation,
        'senderEnqueueFinishedAt',
        'senderEnqueueFinishedAtEpochMs',
        timing
      );
    }

    markSenderBufferedAmountBeforeTerminal(
      transferId,
      bufferedAmount,
      generation = undefined
    ) {
      return this.markSafeIntegerOnce(
        transferId,
        generation,
        'senderBufferedAmountBeforeTerminalBytes',
        bufferedAmount
      );
    }

    markSenderBufferedAmountAfterTerminal(
      transferId,
      bufferedAmount,
      generation = undefined
    ) {
      return this.markSafeIntegerOnce(
        transferId,
        generation,
        'senderBufferedAmountAfterTerminalBytes',
        bufferedAmount
      );
    }

    markReceiverByteArrival(
      transferId,
      receivedBytesAfter,
      timing = undefined,
      generation = undefined
    ) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer || !Number.isSafeInteger(receivedBytesAfter) || receivedBytesAfter < 0) {
        return false;
      }

      const captured = this.normalizeTiming(timing);
      if (transfer.receiverFirstByteArrivedAt === null && receivedBytesAfter > 0) {
        transfer.receiverFirstByteArrivedAt = captured.monotonicMs;
        transfer.receiverFirstByteArrivedAtEpochMs = captured.epochMs;
        if (transfer.firstByteAt === null) transfer.firstByteAt = captured.monotonicMs;
      }
      if (receivedBytesAfter === transfer.totalBytes && transfer.totalBytes > 0 &&
          transfer.receiverLastByteArrivedAt === null) {
        transfer.receiverLastByteArrivedAt = captured.monotonicMs;
        transfer.receiverLastByteArrivedAtEpochMs = captured.epochMs;
      }
      return true;
    }

    markReceiverTerminalArrival(transferId, timing = undefined, generation = undefined) {
      return this.markTimedOnce(
        transferId,
        generation,
        'receiverTerminalArrivedAt',
        'receiverTerminalArrivedAtEpochMs',
        timing
      );
    }

    addEncryptionTime(transferId, durationMs, generation = undefined) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer || !Number.isFinite(durationMs) || durationMs < 0) return false;
      transfer.encryptionTimeMs += durationMs;
      return true;
    }

    addBackpressureWait(transferId, durationMs, pauses = 1, generation = undefined) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer || !Number.isFinite(durationMs) || durationMs < 0 ||
          !Number.isSafeInteger(pauses) || pauses < 0) {
        return false;
      }

      transfer.backpressureWaitMs += durationMs;
      transfer.backpressurePauses += pauses;
      return true;
    }

    markReceiverFinalizationStart(transferId, generation = undefined) {
      return this.markOnce(transferId, generation, 'receiverFinalizationStartedAt');
    }

    markReceiverFinalizationEnd(transferId, generation = undefined) {
      return this.markOnce(transferId, generation, 'receiverFinalizationFinishedAt');
    }

    markTerminalSent(transferId, generation = undefined, timing = undefined) {
      return this.markTimedOnce(
        transferId,
        generation,
        'terminalSentAt',
        'terminalSentAtEpochMs',
        timing
      );
    }

    markAckSent(transferId, generation = undefined, timing = undefined) {
      return this.markTimedOnce(
        transferId,
        generation,
        'ackSentAt',
        'ackSentAtEpochMs',
        timing
      );
    }

    markAckReceived(transferId, generation = undefined, timing = undefined) {
      return this.markTimedOnce(
        transferId,
        generation,
        'ackReceivedAt',
        'ackReceivedAtEpochMs',
        timing
      );
    }

    completeTransfer(transferId, generation = undefined) {
      return this.finishTransfer(transferId, generation, 'completed');
    }

    failTransfer(transferId, generation = undefined) {
      return this.finishTransfer(transferId, generation, 'failed');
    }

    cancelTransfer(transferId, generation = undefined) {
      return this.finishTransfer(transferId, generation, 'cancelled');
    }

    getConnectionSnapshot() {
      if (!this.connection) return null;
      return {
        generation: this.connection.generation,
        sequence: this.connection.sequence,
        dataChannelState: this.connection.dataChannelState,
        pairingTimeMs: elapsed(this.connection.pairingStartedAt, this.connection.pairedAt),
        dataChannelOpenTimeMs: elapsed(
          this.connection.pairedAt,
          this.connection.dataChannelOpenedAt
        )
      };
    }

    getActiveTransfer() {
      return this.toPublicTransfer(this.activeTransfer);
    }

    getCompletedTransfers() {
      return this.completedTransfers.map(cloneSnapshot);
    }

    getLatestTransfer() {
      const latest = this.completedTransfers[this.completedTransfers.length - 1];
      return cloneSnapshot(latest) || this.getActiveTransfer();
    }

    createPublicApi() {
      return Object.freeze({
        getConnectionSnapshot: () => this.getConnectionSnapshot(),
        getActiveTransfer: () => this.getActiveTransfer(),
        getCompletedTransfers: () => this.getCompletedTransfers(),
        getLatestTransfer: () => this.getLatestTransfer(),
        clear: () => this.clear()
      });
    }

    clear() {
      this.connectionSequence += 1;
      this.transferSequence += 1;
      this.connection = null;
      this.activeTransfer = null;
      this.completedTransfers = [];
    }

    readNow() {
      try {
        return finiteNumber(this.now(), 0);
      } catch (err) {
        return 0;
      }
    }

    readEpochNow() {
      try {
        return finiteNumber(this.epochNow(), 0);
      } catch (err) {
        return 0;
      }
    }

    normalizeTiming(timing) {
      return {
        monotonicMs: timing && Number.isFinite(timing.monotonicMs)
          ? timing.monotonicMs
          : this.readNow(),
        epochMs: timing && Number.isFinite(timing.epochMs)
          ? timing.epochMs
          : this.readEpochNow()
      };
    }

    resolveConnection(generation) {
      return this.connection && this.connection.generation === generation
        ? this.connection
        : null;
    }

    resolveTransfer(transferId, generation) {
      const transfer = this.activeTransfer;
      return transfer &&
        transfer.status === 'active' &&
        transfer.transferId === transferId &&
        (generation === undefined || transfer.generation === generation) &&
        transfer.sessionGeneration === (this.connection && this.connection.generation)
        ? transfer
        : null;
    }

    markOnce(transferId, generation, field) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer) return false;
      if (transfer[field] === null) transfer[field] = this.readNow();
      return true;
    }

    markTimedOnce(transferId, generation, monotonicField, epochField, timing) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer) return false;
      if (transfer[monotonicField] !== null) return true;

      const captured = this.normalizeTiming(timing);
      transfer[monotonicField] = captured.monotonicMs;
      transfer[epochField] = captured.epochMs;
      return true;
    }

    markSafeIntegerOnce(transferId, generation, field, value) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer || !Number.isSafeInteger(value) || value < 0) return false;
      if (transfer[field] === null) transfer[field] = value;
      return true;
    }

    finishTransfer(transferId, generation, status) {
      const transfer = this.resolveTransfer(transferId, generation);
      if (!transfer) return false;

      transfer.status = status;
      transfer.completedAt = this.readNow();
      if (status === 'completed') transfer.completionCount = 1;

      const snapshot = this.toPublicTransfer(transfer);
      this.activeTransfer = null;
      this.completedTransfers.push(snapshot);
      if (this.completedTransfers.length > this.maxCompleted) {
        this.completedTransfers.splice(0, this.completedTransfers.length - this.maxCompleted);
      }
      return true;
    }

    toPublicTransfer(transfer) {
      if (!transfer) return null;

      const totalDurationMs = elapsed(transfer.selectedAt, transfer.completedAt);
      const throughput = totalDurationMs > 0
        ? transfer.bytesTransferred / (totalDurationMs / 1000)
        : 0;

      return {
        sequence: transfer.sequence,
        status: transfer.status,
        direction: transfer.direction,
        pairingTimeMs: this.getConnectionSnapshot()?.pairingTimeMs ?? null,
        dataChannelOpenTimeMs: this.getConnectionSnapshot()?.dataChannelOpenTimeMs ?? null,
        selectionToStartMs: elapsed(transfer.selectedAt, transfer.startedAt),
        timeToFirstByteMs: elapsed(transfer.startedAt, transfer.firstByteAt),
        senderEnqueueDurationMs: elapsed(
          transfer.senderEnqueueStartedAt,
          transfer.senderEnqueueFinishedAt
        ),
        senderEnqueueFinishedAtEpochMs: transfer.senderEnqueueFinishedAtEpochMs,
        senderBufferedAmountBeforeTerminalBytes:
          transfer.senderBufferedAmountBeforeTerminalBytes,
        senderBufferedAmountAfterTerminalBytes:
          transfer.senderBufferedAmountAfterTerminalBytes,
        receiverFirstByteArrivedAtEpochMs: transfer.receiverFirstByteArrivedAtEpochMs,
        receiverLastByteArrivedAtEpochMs: transfer.receiverLastByteArrivedAtEpochMs,
        receiverTerminalArrivedAtEpochMs: transfer.receiverTerminalArrivedAtEpochMs,
        receiverFinalizationDurationMs: elapsed(
          transfer.receiverFinalizationStartedAt,
          transfer.receiverFinalizationFinishedAt
        ),
        receiverTerminalToAckSendMs: elapsed(
          transfer.receiverTerminalArrivedAt,
          transfer.ackSentAt
        ),
        terminalSentAtEpochMs: transfer.terminalSentAtEpochMs,
        ackSentAtEpochMs: transfer.ackSentAtEpochMs,
        ackReceivedAtEpochMs: transfer.ackReceivedAtEpochMs,
        senderTerminalQueuedToAckMs: elapsed(transfer.terminalSentAt, transfer.ackReceivedAt),
        totalDurationMs,
        bytesTransferred: transfer.bytesTransferred,
        totalBytes: transfer.totalBytes,
        averageThroughputBytesPerSecond: throughput,
        averageThroughputMBps: throughput / (1024 * 1024),
        route: transfer.route,
        performanceProfile: transfer.performanceProfile,
        chunkSize: transfer.chunkSize,
        bufferThreshold: transfer.bufferThreshold,
        backpressureWaitMs: transfer.backpressureWaitMs,
        encryptionTimeMs: transfer.encryptionTimeMs,
        backpressurePauses: transfer.backpressurePauses,
        receiverMode: transfer.receiverMode,
        completionCount: transfer.completionCount
      };
    }

    isValidTransferId(transferId) {
      return typeof transferId === 'string' &&
        transferId.trim().length > 0 &&
        transferId.length <= 128;
    }

    static isRequested(inputUrl) {
      try {
        const url = new URL(String(inputUrl), 'http://localhost');
        const values = url.searchParams.getAll('diagnostics');
        return values.length === 1 && values[0] === '1';
      } catch (err) {
        return false;
      }
    }
  }

  return TransferPerformanceDiagnostics;
});
