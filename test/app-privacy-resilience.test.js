'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PairingLinkPrivacy = require('../public/js/pairing-link-privacy');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const facadeSource = appSource.slice(0, appSource.indexOf("document.addEventListener('DOMContentLoaded'"));

function loadFacade(helper) {
  const context = {
    window: { PairingLinkPrivacy: helper },
    URL,
    console
  };
  vm.runInNewContext(`${facadeSource}\n;globalThis.auditResult = { pairingPrivacy, pairingLinkBootstrap };`, context);
  return context.auditResult;
}

test('undefined PairingLinkPrivacy does not crash and uses direct bootstrap fallback', () => {
  const result = loadFacade(undefined);
  assert.equal(result.pairingLinkBootstrap.code, null);
  assert.equal(result.pairingLinkBootstrap.entry, 'direct');
});

test('partially defined or throwing PairingLinkPrivacy methods do not crash', () => {
  const result = loadFacade({
    consumeBootstrap() { throw new Error('unavailable'); },
    isAllowedAnalyticsEvent() { throw new Error('unavailable'); },
    buildPairingLink() { throw new Error('unavailable'); }
  });
  assert.equal(result.pairingLinkBootstrap.code, null);
  assert.equal(result.pairingPrivacy.isAllowedAnalyticsEvent('app_open'), false);
  assert.equal(result.pairingPrivacy.sanitizeAnalyticsProperties('app_open', { entry: 'direct' }), null);
});

test('privacy fallback disables automatic pairing without rereading the URL', () => {
  const result = loadFacade(undefined);
  assert.equal(result.pairingLinkBootstrap.code, null);
  assert.doesNotMatch(facadeSource, /location\.(?:search|hash)/);
  assert.match(appSource, /let pendingAutoJoinCode = pairingLinkBootstrap\.code/);
  assert.match(appSource, /if \(!code\) return;[\s\S]*socketManager\.joinCode\(code\)/);
});

test('manual pairing remains independent of the privacy helper', () => {
  assert.match(appSource, /btnJoin\.addEventListener\('click',[\s\S]*joinCodeInput\.value\.trim\(\)[\s\S]*socketManager\.joinCode\(code\)/);
});

test('analytics safely skips when privacy validation is unavailable', () => {
  const result = loadFacade(undefined);
  assert.equal(result.pairingPrivacy.isAllowedAnalyticsEvent('app_open'), false);
  assert.equal(result.pairingPrivacy.sanitizeAnalyticsProperties('app_open', { entry: 'direct' }), null);
  assert.match(appSource, /if \(!pairingPrivacy\.isAllowedAnalyticsEvent\(eventName\)\) return false;/);
  assert.match(appSource, /if \(!safeProperties\) return false;/);
});

test('QR fallback validates four digits and uses a fragment only', () => {
  const result = loadFacade(undefined);
  const link = result.pairingPrivacy.buildPairingLink('https://airdows.com', '1234');
  assert.equal(link, 'https://airdows.com/app#code=1234');
  assert.equal(link.includes('?code='), false);
  assert.throws(() => result.pairingPrivacy.buildPairingLink('https://airdows.com', '12345'));
});

test('malformed helper QR output cannot reintroduce a code query', () => {
  const result = loadFacade({
    buildPairingLink() { return 'https://airdows.com/app?code=1234'; }
  });
  assert.equal(
    result.pairingPrivacy.buildPairingLink('https://airdows.com', '1234'),
    'https://airdows.com/app#code=1234'
  );
});

test('existing PairingLinkPrivacy behavior is preserved when all methods are present', () => {
  PairingLinkPrivacy.initializeBrowser({
    location: { href: 'https://airdows.com/app#code=1234' },
    history: { state: null, replaceState() {} },
    document: { title: 'AirDows' }
  });
  const result = loadFacade(PairingLinkPrivacy);
  assert.equal(result.pairingLinkBootstrap.code, '1234');
  assert.equal(result.pairingLinkBootstrap.entry, 'pairing_link');
  assert.equal(result.pairingPrivacy.isAllowedAnalyticsEvent('app_open'), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.pairingPrivacy.sanitizeAnalyticsProperties('app_open', { entry: 'pairing_link' }))),
    { entry: 'pairing_link' }
  );
  assert.equal(
    result.pairingPrivacy.buildPairingLink('https://airdows.com', '1234'),
    'https://airdows.com/app#code=1234'
  );
});
