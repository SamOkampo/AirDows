'use strict';

const { test, expect } = require('@playwright/test');
const { isAllowedE2EUrl } = require('./url-policy.js');

const DATA_CHANNEL_TIMEOUT_MS = 45_000;
const RECOVERY_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 60_000;

async function createDevice(browser, baseURL) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', async (route) => {
    if (isAllowedE2EUrl(route.request().url(), baseURL)) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket('**/*', (route) => {
    if (isAllowedE2EUrl(route.url(), baseURL)) return route.connectToServer();
    return route.close({ code: 1008, reason: 'E2E network isolation' }).catch(() => {});
  });
  return { context, page: await context.newPage() };
}

async function waitForDiagnostics(page) {
  await expect.poll(
    () => page.evaluate(() => Boolean(
      window.airDowsDiagnostics &&
      typeof window.airDowsDiagnostics.getConnectionSnapshot === 'function' &&
      typeof window.airDowsDiagnostics.getCompletedTransfers === 'function'
    )),
    { timeout: 15_000 }
  ).toBe(true);
}

async function connectionState(page) {
  return page.evaluate(() => window.airDowsDiagnostics?.getConnectionSnapshot?.() || null);
}

async function completedTransfers(page) {
  return page.evaluate(() => window.airDowsDiagnostics?.getCompletedTransfers?.() || []);
}

async function waitForOpenDataChannels(sender, receiver, timeout = DATA_CHANNEL_TIMEOUT_MS) {
  await Promise.all([
    expect.poll(async () => (await connectionState(sender))?.dataChannelState, { timeout }).toBe('open'),
    expect.poll(async () => (await connectionState(receiver))?.dataChannelState, { timeout }).toBe('open')
  ]);
}

async function waitForPairingCode(page) {
  await expect.poll(
    async () => (await page.locator('#d1, #d2, #d3, #d4').allTextContents()).join('').trim(),
    { timeout: 15_000 }
  ).toMatch(/^\d{4}$/);
  return (await page.locator('#d1, #d2, #d3, #d4').allTextContents()).join('').trim();
}

async function pair(sender, receiver) {
  await receiver.locator('#btn-role-receive').click();
  const code = await waitForPairingCode(receiver);
  await sender.locator('#btn-role-send').click();
  await sender.locator('#join-code-input').fill(code);
  await sender.locator('#btn-join').click();
  await waitForOpenDataChannels(sender, receiver);
}

async function transferAndDownload(sender, receiver) {
  const senderInitial = (await completedTransfers(sender)).length;
  const receiverInitial = (await completedTransfers(receiver)).length;
  const file = {
    name: 'airdows-e2e-recovery.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(96 * 1024, 73)
  };

  await sender.locator('#file-input').setInputFiles(file);
  await expect(sender.locator('#btn-confirm-send')).toBeEnabled();
  await sender.locator('#btn-confirm-send').click();

  await Promise.all([
    expect.poll(async () => (await completedTransfers(sender)).length, { timeout: TRANSFER_TIMEOUT_MS })
      .toBe(senderInitial + 1),
    expect.poll(async () => (await completedTransfers(receiver)).length, { timeout: TRANSFER_TIMEOUT_MS })
      .toBe(receiverInitial + 1)
  ]);

  const sent = (await completedTransfers(sender)).at(-1);
  const received = (await completedTransfers(receiver)).at(-1);
  expect(sent).toMatchObject({ direction: 'send', status: 'completed', completionCount: 1 });
  expect(received).toMatchObject({ direction: 'receive', status: 'completed', completionCount: 1 });
  expect(sent.ackReceivedAtEpochMs).toEqual(expect.any(Number));
  expect(received.ackSentAtEpochMs).toEqual(expect.any(Number));

  const row = receiver.locator('#received-files-list .received-file-item.is-ready', { hasText: file.name });
  await expect(row).toHaveCount(1);
  const downloadPromise = receiver.waitForEvent('download');
  await row.locator('.received-file-download').click();
  expect((await downloadPromise).suggestedFilename()).toBe(file.name);
  await expect(receiver.locator('#received-files-list .received-file-item.is-downloaded', { hasText: file.name }))
    .toContainText('Downloaded');
}

test('recovers a paired session after signaling loss and transfers again', async ({ browser, baseURL }) => {
  const sender = await createDevice(browser, baseURL);
  const receiver = await createDevice(browser, baseURL);

  try {
    await Promise.all([
      sender.page.goto('/app?diagnostics=1'),
      receiver.page.goto('/app?diagnostics=1')
    ]);
    await Promise.all([waitForDiagnostics(sender.page), waitForDiagnostics(receiver.page)]);
    await pair(sender.page, receiver.page);

    const initialSenderConnection = await connectionState(sender.page);
    expect(initialSenderConnection?.generation).toEqual(expect.any(Number));

    // The app renders this exact recovery state only after SocketManager reports
    // signaling-disconnected/recovering. Unlike a generic status change, it cannot be
    // satisfied merely by WebRTC reacting to the offline transition.
    await sender.context.setOffline(true);
    await expect(sender.page.locator('#connection-status-text')).toHaveText(
      /^(Try again|Intenta nuevamente)$/,
      { timeout: 15_000 }
    );
    await sender.context.setOffline(false);

    await expect.poll(
      async () => (await connectionState(sender.page))?.generation,
      { timeout: RECOVERY_TIMEOUT_MS }
    ).toBeGreaterThan(initialSenderConnection.generation);

    await waitForOpenDataChannels(sender.page, receiver.page, RECOVERY_TIMEOUT_MS);
    await transferAndDownload(sender.page, receiver.page);
  } finally {
    await sender.context.close().catch(() => {});
    await receiver.context.close().catch(() => {});
  }
});
