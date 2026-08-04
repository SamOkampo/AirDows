'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { test, expect } = require('@playwright/test');
const { isAllowedE2EUrl } = require('./url-policy.js');

const MEBIBYTE = 1024 * 1024;
const DATA_CHANNEL_TIMEOUT_MS = 45_000;
const TRANSFER_TIMEOUT_MS = 90_000;
const TEST_FILE_NAMES = [
  'airdows-e2e-small.bin',
  'airdows-e2e-baseline.bin',
  'airdows-e2e-queue-a.bin',
  'airdows-e2e-queue-b.bin'
];

function createTestFile(name, size, seed) {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = (index + seed) % 251;
  }
  return {
    name,
    mimeType: 'application/octet-stream',
    buffer
  };
}

function sanitizeLog(value) {
  let sanitized = String(value);
  for (const fileName of TEST_FILE_NAMES) {
    sanitized = sanitized.replaceAll(fileName, '[synthetic-test-file]');
  }
  return sanitized
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]{0,4}\b/gi, '[redacted-ip]')
    .replace(/\b\d{4}\b/g, '[redacted-four-digits]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]');
}

function installBrowserLogCapture(page, device, baseURL, entries) {
  page.on('console', (message) => {
    entries.push(`[${device}] [console:${message.type()}] ${sanitizeLog(message.text())}`);
  });
  page.on('pageerror', (error) => {
    entries.push(`[${device}] [pageerror] ${sanitizeLog(error?.message || 'Unknown page error')}`);
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (!isAllowedE2EUrl(url, baseURL)) return;
    entries.push(
      `[${device}] [requestfailed] ${sanitizeLog(url.pathname)} ` +
      `${sanitizeLog(request.failure()?.errorText || 'request failed')}`
    );
  });
}

async function createIsolatedDevice(browser, baseURL, device, browserLogs) {
  const context = await browser.newContext({
    acceptDownloads: true
  });
  await context.route('**/*', async (route) => {
    if (isAllowedE2EUrl(route.request().url(), baseURL)) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  await context.routeWebSocket('**/*', (webSocketRoute) => {
    if (isAllowedE2EUrl(webSocketRoute.url(), baseURL)) {
      webSocketRoute.connectToServer();
      return;
    }
    webSocketRoute.close({ code: 1008, reason: 'E2E network isolation' }).catch(() => {});
  });

  const page = await context.newPage();
  installBrowserLogCapture(page, device, baseURL, browserLogs);
  const deviceState = { context, page, traceStarted: false, downloadCount: 0 };
  page.on('download', () => {
    deviceState.downloadCount += 1;
  });
  return deviceState;
}

async function readConnectionSnapshot(page) {
  return page.evaluate(() => {
    if (!window.airDowsDiagnostics ||
        typeof window.airDowsDiagnostics.getConnectionSnapshot !== 'function') {
      return null;
    }
    return window.airDowsDiagnostics.getConnectionSnapshot();
  });
}

async function readCompletedTransfers(page) {
  return page.evaluate(() => {
    if (!window.airDowsDiagnostics ||
        typeof window.airDowsDiagnostics.getCompletedTransfers !== 'function') {
      return null;
    }
    return window.airDowsDiagnostics.getCompletedTransfers();
  });
}

async function waitForDiagnostics(page) {
  await expect.poll(
    async () => page.evaluate(() => Boolean(
      window.airDowsDiagnostics &&
      typeof window.airDowsDiagnostics.getConnectionSnapshot === 'function' &&
      typeof window.airDowsDiagnostics.getCompletedTransfers === 'function'
    )),
    {
      message: 'AirDows local E2E diagnostics did not become available.',
      timeout: 15_000
    }
  ).toBe(true);
}

async function calibratePageClock(page, sampleCount = 9) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const hostBefore = performance.timeOrigin + performance.now();
    const pageEpochMs = await page.evaluate(() => (
      performance.timeOrigin + performance.now()
    ));
    const hostAfter = performance.timeOrigin + performance.now();
    samples.push({
      offsetToHostMs: ((hostBefore + hostAfter) / 2) - pageEpochMs,
      uncertaintyMs: (hostAfter - hostBefore) / 2
    });
  }
  return samples.reduce((best, sample) => (
    !best || sample.uncertaintyMs < best.uncertaintyMs ? sample : best
  ), null);
}

function crossContextDuration(startEpochMs, startClock, endEpochMs, endClock) {
  if (!Number.isFinite(startEpochMs) || !Number.isFinite(endEpochMs) ||
      !startClock || !endClock) {
    return { durationMs: null, uncertaintyMs: null };
  }

  const startOnHostClock = startEpochMs + startClock.offsetToHostMs;
  const endOnHostClock = endEpochMs + endClock.offsetToHostMs;
  const rawDurationMs = endOnHostClock - startOnHostClock;
  const uncertaintyMs = startClock.uncertaintyMs + endClock.uncertaintyMs;
  if (rawDurationMs < -uncertaintyMs) {
    throw new Error(
      `Cross-context performance milestones were out of order by ${(-rawDurationMs).toFixed(2)} ms.`
    );
  }
  return {
    durationMs: Math.max(0, rawDurationMs),
    uncertaintyMs
  };
}

async function waitForPairingCode(page) {
  const code = await expect.poll(
    async () => page.locator('#d1, #d2, #d3, #d4').allTextContents()
      .then((digits) => digits.join('').trim()),
    {
      message: 'AirDows did not generate a four-digit pairing code.',
      timeout: 15_000
    }
  ).toMatch(/^\d{4}$/).then(async () => (
    page.locator('#d1, #d2, #d3, #d4').allTextContents()
      .then((digits) => digits.join('').trim())
  ));
  return code;
}

async function removePairingSecretsFromPage(page) {
  await page.evaluate(() => {
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      const digit = document.getElementById(id);
      if (digit) digit.textContent = '•';
    }
    const codeInput = document.getElementById('join-code-input');
    if (codeInput) codeInput.value = '';
    const qrCode = document.getElementById('qrcode');
    if (qrCode) qrCode.replaceChildren();
  }).catch(() => {});
}

async function waitForOpenDataChannels(senderPage, receiverPage) {
  try {
    await Promise.all([
      expect.poll(
        async () => (await readConnectionSnapshot(senderPage))?.dataChannelState,
        {
          message: 'Connecting and establishing P2P channel (sender)',
          timeout: DATA_CHANNEL_TIMEOUT_MS
        }
      ).toBe('open'),
      expect.poll(
        async () => (await readConnectionSnapshot(receiverPage))?.dataChannelState,
        {
          message: 'Connecting and establishing P2P channel (receiver)',
          timeout: DATA_CHANNEL_TIMEOUT_MS
        }
      ).toBe('open')
    ]);
  } catch (error) {
    const senderState = await readConnectionSnapshot(senderPage).catch(() => null);
    const receiverState = await readConnectionSnapshot(receiverPage).catch(() => null);
    throw new Error(
      'Connecting and establishing P2P channel timed out. ' +
      `Sender state: ${senderState?.dataChannelState || 'unavailable'}; ` +
      `receiver state: ${receiverState?.dataChannelState || 'unavailable'}.`,
      { cause: error }
    );
  }
}

async function waitForNewTransfers(page, initialCount, count, direction) {
  await expect.poll(
    async () => {
      const transfers = await readCompletedTransfers(page);
      return Array.isArray(transfers) ? transfers.length : -1;
    },
    {
      message: direction === 'sender'
        ? `Sender did not receive the delivery ACK for ${count} expected transfer(s).`
        : `Receiver did not finalize ${count} expected transfer(s).`,
      timeout: TRANSFER_TIMEOUT_MS
    }
  ).toBe(initialCount + count);

  const transfers = await readCompletedTransfers(page);
  return transfers.slice(initialCount);
}

function assertCompletedTransfer(snapshot, expected) {
  expect(snapshot).toMatchObject({
    direction: expected.direction,
    status: 'completed',
    totalBytes: expected.totalBytes,
    completionCount: 1
  });
  expect(snapshot.sequence).toEqual(expect.any(Number));
  expect(snapshot.bytesTransferred).toBe(expected.totalBytes);
  expect(snapshot.bytesTransferred).toBeGreaterThan(0);
  expect(snapshot.selectionToStartMs).toEqual(expect.any(Number));
  expect(snapshot.timeToFirstByteMs).toEqual(expect.any(Number));
  expect(snapshot.totalDurationMs).toEqual(expect.any(Number));
  expect(snapshot.totalDurationMs).toBeGreaterThanOrEqual(0);
  expect(snapshot.averageThroughputBytesPerSecond).toBeGreaterThan(0);

  if (expected.direction === 'send') {
    expect(snapshot.senderEnqueueDurationMs).toEqual(expect.any(Number));
    expect(snapshot.senderEnqueueDurationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.senderEnqueueFinishedAtEpochMs).toEqual(expect.any(Number));
    expect(snapshot.senderBufferedAmountBeforeTerminalBytes).toEqual(expect.any(Number));
    expect(snapshot.senderBufferedAmountAfterTerminalBytes).toEqual(expect.any(Number));
    expect(snapshot.senderTerminalQueuedToAckMs).toEqual(expect.any(Number));
    expect(snapshot.senderTerminalQueuedToAckMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.ackReceivedAtEpochMs).toEqual(expect.any(Number));
  } else {
    expect(snapshot.receiverFirstByteArrivedAtEpochMs).toEqual(expect.any(Number));
    expect(snapshot.receiverLastByteArrivedAtEpochMs).toEqual(expect.any(Number));
    expect(snapshot.receiverTerminalArrivedAtEpochMs).toEqual(expect.any(Number));
    expect(snapshot.receiverFinalizationDurationMs).toEqual(expect.any(Number));
    expect(snapshot.receiverFinalizationDurationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.ackSentAtEpochMs).toEqual(expect.any(Number));
  }
}

function formatDuration(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : 'n/a';
}

function formatBytes(value) {
  return `${(value / MEBIBYTE).toFixed(2)} MB`;
}

function formatChunk(value) {
  return `${(value / 1024).toFixed(0)} KB`;
}

function formatThroughput(snapshot) {
  const throughput = Number.isFinite(snapshot.averageThroughputMBps)
    ? snapshot.averageThroughputMBps
    : snapshot.averageThroughputBytesPerSecond / MEBIBYTE;
  return Number.isFinite(throughput) ? `${throughput.toFixed(2)} MB/s` : 'n/a';
}

function formatBufferedAmount(before, after) {
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) return 'n/a';
  return `${before} → ${after} bytes`;
}

function formatCalibratedDuration(measurement) {
  if (!measurement || !Number.isFinite(measurement.durationMs)) return 'n/a';
  const uncertainty = Number.isFinite(measurement.uncertaintyMs)
    ? ` (±${measurement.uncertaintyMs.toFixed(2)} ms clock uncertainty)`
    : '';
  return `${measurement.durationMs.toFixed(1)} ms${uncertainty}`;
}

function buildPerformanceReport(sender, receiver, clocks) {
  const route = sender.route !== 'unknown' ? sender.route : receiver.route;
  const profile = sender.performanceProfile || receiver.performanceProfile || 'unknown';
  const lastByteDelivery = crossContextDuration(
    sender.senderEnqueueFinishedAtEpochMs,
    clocks.sender,
    receiver.receiverLastByteArrivedAtEpochMs,
    clocks.receiver
  );
  const ackAfterTerminalArrival = crossContextDuration(
    receiver.receiverTerminalArrivedAtEpochMs,
    clocks.receiver,
    sender.ackReceivedAtEpochMs,
    clocks.sender
  );
  const report = [
    'AirDows E2E Performance',
    '',
    `Route: ${route || 'unknown'}`,
    `Profile: ${profile}`,
    `Size: ${formatBytes(sender.totalBytes)}`,
    `Chunk: ${formatChunk(sender.chunkSize || 0)}`,
    `Buffer threshold: ${formatBytes(sender.bufferThreshold || 0)}`,
    `Receiver mode: ${receiver.receiverMode || 'unknown'}`,
    `Pairing time: ${formatDuration(sender.pairingTimeMs ?? receiver.pairingTimeMs)}`,
    `DataChannel open time: ${formatDuration(
      sender.dataChannelOpenTimeMs ?? receiver.dataChannelOpenTimeMs
    )}`,
    `Selection to start: ${formatDuration(sender.selectionToStartMs)}`,
    `Sender first chunk queued: ${formatDuration(sender.timeToFirstByteMs)}`,
    `Sender enqueue duration: ${formatDuration(sender.senderEnqueueDurationMs)}`,
    `Sender buffered amount at terminal: ${formatBufferedAmount(
      sender.senderBufferedAmountBeforeTerminalBytes,
      sender.senderBufferedAmountAfterTerminalBytes
    )}`,
    `Last-byte delivery duration: ${formatCalibratedDuration(lastByteDelivery)}`,
    `Encryption time: ${formatDuration(sender.encryptionTimeMs)}`,
    `Receiver decryption: ${formatDuration(receiver.encryptionTimeMs)}`,
    `Backpressure wait: ${formatDuration(sender.backpressureWaitMs)}`,
    `Backpressure pauses: ${sender.backpressurePauses ?? 0}`,
    `Receiver finalization duration: ${formatDuration(
      receiver.receiverFinalizationDurationMs
    )}`,
    `Receiver terminal to ACK send: ${formatDuration(
      receiver.receiverTerminalToAckSendMs
    )}`,
    `ACK round-trip after terminal arrival: ${formatCalibratedDuration(
      ackAfterTerminalArrival
    )}`,
    `Sender terminal queued to ACK: ${formatDuration(
      sender.senderTerminalQueuedToAckMs
    )}`,
    `User-perceived total duration: ${formatDuration(sender.totalDurationMs)}`,
    `Bytes transferred: ${sender.bytesTransferred}`,
    `Average throughput: ${formatThroughput(sender)}`
  ].join('\n');

  return `${report}\n`;
}

async function savePerformanceReport(testInfo, index, sender, receiver, clocks) {
  const report = buildPerformanceReport(sender, receiver, clocks);
  const reportDirectory = path.resolve('test-results', 'performance');
  const reportPath = path.join(
    reportDirectory,
    `transfer-${String(index).padStart(2, '0')}.txt`
  );
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`\n${report}`);
  await testInfo.attach(`AirDows E2E Performance ${index}`, {
    body: report,
    contentType: 'text/plain'
  });
}

async function submitFiles(page, files) {
  await page.locator('#file-input').setInputFiles(files);
}

async function sanitizePageForScreenshot(page) {
  await removePairingSecretsFromPage(page);
  await page.evaluate(() => {
    const selectors = [
      '#progress-file-name',
      '#completed-file-name',
      '.queue-file-name',
      '.history-item-name'
    ];
    document.querySelectorAll(selectors.join(',')).forEach((element) => {
      element.textContent = '[synthetic test file]';
    });
  }).catch(() => {});
}

async function captureFailureArtifacts(testInfo, devices, browserLogs) {
  for (const [name, device] of Object.entries(devices)) {
    if (!device) continue;
    await sanitizePageForScreenshot(device.page);
    await device.page.screenshot({
      path: testInfo.outputPath(`${name}-failure.png`),
      fullPage: true
    }).catch(() => {});
    if (!device.traceStarted) {
      await device.context.tracing.start({
        screenshots: false,
        snapshots: false,
        sources: false
      }).catch(() => {});
      device.traceStarted = true;
    }
    await device.page.evaluate(() => document.visibilityState).catch(() => {});
    await device.context.tracing.stop({
      path: testInfo.outputPath(`${name}-trace.zip`)
    }).catch(() => {});
    device.traceStarted = false;
  }
  fs.writeFileSync(
    testInfo.outputPath('browser.log'),
    `${browserLogs.map(sanitizeLog).join('\n')}\n`,
    'utf8'
  );
}

test('pairs two devices and establishes a real transfer performance baseline', async ({
  browser,
  baseURL
}, testInfo) => {
  const browserLogs = [];
  const devices = {
    sender: null,
    receiver: null
  };
  let failed = true;

  try {
    devices.sender = await createIsolatedDevice(browser, baseURL, 'sender', browserLogs);
    devices.receiver = await createIsolatedDevice(browser, baseURL, 'receiver', browserLogs);

    await Promise.all([
      devices.sender.page.goto('/app?diagnostics=1'),
      devices.receiver.page.goto('/app?diagnostics=1')
    ]);
    await Promise.all([
      waitForDiagnostics(devices.sender.page),
      waitForDiagnostics(devices.receiver.page)
    ]);

    await devices.sender.page.locator('#btn-generate').click();
    const pairingCode = await waitForPairingCode(devices.sender.page);
    await devices.receiver.page.locator('#join-code-input').fill(pairingCode);
    await devices.receiver.page.locator('#btn-join').click();
    await Promise.all([
      removePairingSecretsFromPage(devices.sender.page),
      removePairingSecretsFromPage(devices.receiver.page)
    ]);

    await waitForOpenDataChannels(devices.sender.page, devices.receiver.page);
    const clocks = {
      sender: await calibratePageClock(devices.sender.page),
      receiver: await calibratePageClock(devices.receiver.page)
    };

    // Tracing begins only after pairing and DataChannel establishment. With DOM/network
    // snapshots disabled it cannot retain the pairing code, recovery token, SDP or IPs.
    await Promise.all(Object.values(devices).map(async (device) => {
      await device.context.tracing.start({
        screenshots: true,
        snapshots: false,
        sources: false
      });
      device.traceStarted = true;
    }));

    const transferCases = [
      [createTestFile(TEST_FILE_NAMES[0], 64 * 1024, 11)],
      [createTestFile(TEST_FILE_NAMES[1], 5 * MEBIBYTE, 29)],
      [
        createTestFile(TEST_FILE_NAMES[2], 256 * 1024, 47),
        createTestFile(TEST_FILE_NAMES[3], 384 * 1024, 83)
      ]
    ];

    let reportIndex = 0;
    for (const files of transferCases) {
      const senderInitial = (await readCompletedTransfers(devices.sender.page)).length;
      const receiverInitial = (await readCompletedTransfers(devices.receiver.page)).length;
      const receiverDownloadsInitial = devices.receiver.downloadCount;

      await submitFiles(devices.sender.page, files);

      const [senderTransfers, receiverTransfers] = await Promise.all([
        waitForNewTransfers(devices.sender.page, senderInitial, files.length, 'sender'),
        waitForNewTransfers(devices.receiver.page, receiverInitial, files.length, 'receiver')
      ]);

      expect(senderTransfers).toHaveLength(files.length);
      expect(receiverTransfers).toHaveLength(files.length);
      await expect.poll(
        () => devices.receiver.downloadCount,
        {
          message: 'Receiver completion did not produce exactly one download per file.',
          timeout: 15_000
        }
      ).toBe(receiverDownloadsInitial + files.length);

      for (let index = 0; index < files.length; index += 1) {
        const expectedSize = files[index].buffer.length;
        const senderSnapshot = senderTransfers[index];
        const receiverSnapshot = receiverTransfers[index];

        assertCompletedTransfer(senderSnapshot, {
          direction: 'send',
          totalBytes: expectedSize
        });
        assertCompletedTransfer(receiverSnapshot, {
          direction: 'receive',
          totalBytes: expectedSize
        });
        expect(receiverSnapshot.receiverFirstByteArrivedAtEpochMs)
          .toBeLessThanOrEqual(receiverSnapshot.receiverLastByteArrivedAtEpochMs);
        expect(receiverSnapshot.receiverLastByteArrivedAtEpochMs)
          .toBeLessThanOrEqual(receiverSnapshot.receiverTerminalArrivedAtEpochMs);
        expect(receiverSnapshot.receiverTerminalArrivedAtEpochMs)
          .toBeLessThanOrEqual(receiverSnapshot.ackSentAtEpochMs);

        const lastByteDelivery = crossContextDuration(
          senderSnapshot.senderEnqueueFinishedAtEpochMs,
          clocks.sender,
          receiverSnapshot.receiverLastByteArrivedAtEpochMs,
          clocks.receiver
        );
        const ackAfterTerminalArrival = crossContextDuration(
          receiverSnapshot.receiverTerminalArrivedAtEpochMs,
          clocks.receiver,
          senderSnapshot.ackReceivedAtEpochMs,
          clocks.sender
        );
        expect(lastByteDelivery.durationMs).toBeGreaterThanOrEqual(0);
        expect(ackAfterTerminalArrival.durationMs).toBeGreaterThanOrEqual(0);
        expect(
          senderSnapshot.senderTerminalQueuedToAckMs +
          ackAfterTerminalArrival.uncertaintyMs
        ).toBeGreaterThanOrEqual(ackAfterTerminalArrival.durationMs);
        expect(
          ackAfterTerminalArrival.durationMs +
          ackAfterTerminalArrival.uncertaintyMs
        ).toBeGreaterThanOrEqual(receiverSnapshot.receiverFinalizationDurationMs);
        if (index > 0) {
          expect(senderSnapshot.sequence).toBeGreaterThan(senderTransfers[index - 1].sequence);
          expect(receiverSnapshot.sequence).toBeGreaterThan(receiverTransfers[index - 1].sequence);
        }

        reportIndex += 1;
        await savePerformanceReport(
          testInfo,
          reportIndex,
          senderSnapshot,
          receiverSnapshot,
          clocks
        );
      }

      await expect(devices.sender.page.locator('#history-list .history-item.sent'))
        .toHaveCount(reportIndex);
      await expect(devices.receiver.page.locator('#history-list .history-item.received'))
        .toHaveCount(reportIndex);
      await expect(devices.sender.page.locator('#queue-list .queue-item.done'))
        .toHaveCount(reportIndex);
    }

    expect(reportIndex).toBe(4);
    failed = false;
  } catch (error) {
    await captureFailureArtifacts(testInfo, devices, browserLogs);
    throw error;
  } finally {
    if (!failed) {
      for (const device of Object.values(devices)) {
        if (device?.traceStarted) {
          await device.context.tracing.stop().catch(() => {});
          device.traceStarted = false;
        }
      }
    }
    for (const device of Object.values(devices)) {
      await device?.context.close().catch(() => {});
    }
  }
});
