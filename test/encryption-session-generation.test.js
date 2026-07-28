'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebRTCManager = require('../public/js/webrtc-manager');
const VALID_PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'public-x',
  y: 'public-y'
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManager() {
  const signals = [];
  const manager = new WebRTCManager({
    sendSignal: (...args) => signals.push(args),
    sendRelayUsage() {}
  });
  manager.roomCode = '1234';
  manager.rtcConfig = { iceServers: [] };
  return { manager, signals };
}

async function withCrypto(fakeCrypto, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: fakeCrypto
  });
  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

test('a new manual pairing generation clears all previous encryption keys', () => {
  const { manager } = createManager();
  const previousState = manager.encryption;
  previousState.keyPair = { privateKey: {}, publicKey: {} };
  previousState.remotePublicKey = {};
  previousState.sessionKey = {};

  manager.startNewPairingSession();

  assert.notEqual(manager.encryption, previousState);
  assert.equal(manager.encryption.generation, previousState.generation + 1);
  assert.equal(manager.encryption.keyPair, null);
  assert.equal(manager.encryption.remotePublicKey, null);
  assert.equal(manager.encryption.sessionKey, null);
});

test('a late key-pair generation cannot write into a replacement encryption session', async () => {
  const generated = deferred();
  const stalePair = { privateKey: { id: 'old-private' }, publicKey: { id: 'old-public' } };

  await withCrypto({
    subtle: {
      generateKey: () => generated.promise,
      exportKey: async () => ({ kty: 'EC' })
    }
  }, async () => {
    const { manager, signals } = createManager();
    const staleState = manager.encryption;
    const starting = manager.startEncryptionSession();

    manager.startNewPairingSession();
    generated.resolve(stalePair);
    await starting;

    assert.equal(staleState.keyPair, null);
    assert.equal(manager.encryption.keyPair, null);
    assert.equal(manager.encryption.remotePublicKey, null);
    assert.equal(manager.encryption.sessionKey, null);
    assert.equal(signals.length, 0);
  });
});

test('a late remote-key import cannot populate a new encryption generation', async () => {
  const imported = deferred();

  await withCrypto({
    subtle: {
      importKey: () => imported.promise
    }
  }, async () => {
    const { manager } = createManager();
    const staleState = manager.encryption;
    const accepting = manager.acceptRemoteCryptoKey(VALID_PUBLIC_JWK);

    manager.startNewPairingSession();
    imported.resolve({ id: 'stale-remote-key' });
    await accepting;

    assert.equal(staleState.remotePublicKey, null);
    assert.equal(manager.encryption.remotePublicKey, null);
  });
});

test('a late derived key cannot become the key for a replacement session', async () => {
  const derived = deferred();

  await withCrypto({
    subtle: {
      deriveKey: () => derived.promise
    }
  }, async () => {
    const { manager } = createManager();
    const staleState = manager.encryption;
    staleState.keyPair = {
      privateKey: { id: 'old-private' },
      publicKey: { id: 'old-public' }
    };
    staleState.remotePublicKey = { id: 'old-remote' };
    manager.ensureEncryptionReadyPromise(staleState);
    const deriving = manager.deriveSessionKey();

    manager.startNewPairingSession();
    derived.resolve({ id: 'stale-session-key' });
    await deriving;

    assert.equal(staleState.sessionKey, null);
    assert.equal(manager.encryption.sessionKey, null);
  });
});

test('recovery within the same pairing session preserves encryption material', () => {
  const { manager } = createManager();
  const keyPair = { privateKey: {}, publicKey: {} };
  const remotePublicKey = {};
  const sessionKey = {};
  manager.encryption.keyPair = keyPair;
  manager.encryption.remotePublicKey = remotePublicKey;
  manager.encryption.sessionKey = sessionKey;
  const generation = manager.encryptionGeneration;

  manager.prepareForRecovery();

  assert.equal(manager.encryptionGeneration, generation);
  assert.equal(manager.encryption.keyPair, keyPair);
  assert.equal(manager.encryption.remotePublicKey, remotePublicKey);
  assert.equal(manager.encryption.sessionKey, sessionKey);
});

test('full close invalidates the encryption session and clears its material', () => {
  const { manager } = createManager();
  const previousState = manager.encryption;
  previousState.keyPair = { privateKey: {}, publicKey: {} };
  previousState.remotePublicKey = {};
  previousState.sessionKey = {};

  manager.close();

  assert.notEqual(manager.encryption, previousState);
  assert.equal(manager.encryption.generation, previousState.generation + 1);
  assert.equal(manager.encryption.keyPair, null);
  assert.equal(manager.encryption.remotePublicKey, null);
  assert.equal(manager.encryption.sessionKey, null);
});

test('two consecutive pairing sessions generate isolated key pairs', async () => {
  let keyIndex = 0;
  await withCrypto({
    subtle: {
      generateKey: async () => {
        keyIndex += 1;
        return {
          privateKey: { id: `private-${keyIndex}` },
          publicKey: { id: `public-${keyIndex}` }
        };
      },
      exportKey: async (_format, publicKey) => ({ kty: 'EC', id: publicKey.id })
    }
  }, async () => {
    const { manager, signals } = createManager();
    manager.startNewPairingSession();
    await manager.startEncryptionSession();
    const firstState = manager.encryption;
    const firstPair = firstState.keyPair;

    manager.startNewPairingSession();
    await manager.startEncryptionSession();

    assert.notEqual(manager.encryption, firstState);
    assert.notEqual(manager.encryption.keyPair, firstPair);
    assert.equal(manager.encryption.keyPair.privateKey.id, 'private-2');
    assert.equal(signals.length, 2);
  });
});

test('recovery retransmits a local public key when the remote key was never received', async () => {
  await withCrypto({
    subtle: {
      generateKey: async () => ({
        privateKey: { id: 'private' },
        publicKey: { id: 'public' }
      }),
      exportKey: async () => VALID_PUBLIC_JWK
    }
  }, async () => {
    const { manager, signals } = createManager();
    manager.peerConnectionGeneration = 1;
    await manager.startEncryptionSession();
    assert.equal(signals.length, 1);
    assert.equal(manager.encryption.remotePublicKey, null);

    manager.peerConnectionGeneration = 2;
    assert.equal(manager.resumeEncryptionHandshake(), true);
    await Promise.resolve();

    assert.equal(signals.length, 2);
    assert.deepEqual(signals[1][1], {
      type: 'crypto-key',
      publicKey: VALID_PUBLIC_JWK
    });
  });
});

test('duplicate recovery hooks retransmit the public key only once per peer generation', async () => {
  await withCrypto({
    subtle: {
      generateKey: async () => ({
        privateKey: { id: 'private' },
        publicKey: { id: 'public' }
      }),
      exportKey: async () => VALID_PUBLIC_JWK
    }
  }, async () => {
    const { manager, signals } = createManager();
    manager.peerConnectionGeneration = 4;
    await manager.startEncryptionSession();
    manager.peerConnectionGeneration = 5;

    manager.resumeEncryptionHandshake();
    manager.resumeEncryptionHandshake();
    await Promise.resolve();

    assert.equal(signals.length, 2);
    assert.equal(manager.encryption.lastPublicKeySignalGeneration, 5);
  });
});

test('recovered encryption handshake derives one session key after retransmission', async () => {
  let derives = 0;
  await withCrypto({
    subtle: {
      generateKey: async () => ({
        privateKey: { id: 'private' },
        publicKey: { id: 'public' }
      }),
      exportKey: async () => VALID_PUBLIC_JWK,
      importKey: async () => ({ id: 'remote' }),
      deriveKey: async () => {
        derives += 1;
        return { id: 'session-key' };
      }
    }
  }, async () => {
    const { manager, signals } = createManager();
    manager.peerConnectionGeneration = 1;
    await manager.startEncryptionSession();
    manager.peerConnectionGeneration = 2;
    manager.resumeEncryptionHandshake();
    await manager.acceptRemoteCryptoKey(VALID_PUBLIC_JWK);
    await manager.acceptRemoteCryptoKey(VALID_PUBLIC_JWK);

    assert.equal(signals.length, 2);
    assert.equal(manager.encryption.sessionKey.id, 'session-key');
    assert.equal(derives, 1);
  });
});

test('an obsolete encryption timeout is cancelled and cannot affect a new session', async () => {
  const timers = new Map();
  let nextTimer = 1;
  const { manager } = createManager();
  manager.encryptionSetTimeout = (callback) => {
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  };
  manager.encryptionClearTimeout = (id) => timers.delete(id);
  manager.encryption.available = true;
  manager.ensureEncryptionReadyPromise();

  const waiting = manager.waitForEncryption();
  const staleTimeout = timers.values().next().value;
  manager.startNewPairingSession();

  await assert.rejects(waiting, { code: 'ENCRYPTION_SESSION_REPLACED' });
  assert.equal(timers.size, 0);
  assert.doesNotThrow(() => staleTimeout());
  assert.equal(manager.encryption.sessionKey, null);
});
