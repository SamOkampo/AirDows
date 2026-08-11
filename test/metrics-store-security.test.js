'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pgPath = require.resolve('pg');
const metricsStorePath = require.resolve('../metrics-store');

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function loadMetricsStoreWithPool(FakePool) {
  const originalPgExports = require(pgPath);
  const pgCacheEntry = require.cache[pgPath];
  pgCacheEntry.exports = { ...originalPgExports, Pool: FakePool };
  delete require.cache[metricsStorePath];

  try {
    return require(metricsStorePath).MetricsStore;
  } finally {
    pgCacheEntry.exports = originalPgExports;
    delete require.cache[metricsStorePath];
  }
}

function createFakePoolClass() {
  return class FakePool {
    static instances = [];

    constructor(options) {
      this.options = options;
      this.queries = [];
      this.ended = false;
      this.constructor.instances.push(this);
    }

    async query(sql, values) {
      const text = normalizeSql(sql);
      this.queries.push({ text, values });

      if (text.startsWith('SELECT')) {
        return {
          rows: [{
            samples: '7',
            completed: '6',
            failed: '1',
            cancelled: '0',
            host: '4',
            srflx: '2',
            relay: '1',
            unknown_route: '0',
            relay_chunks: '8',
            relay_estimated_bytes: '4096',
            pro_required_events: '0',
            started_at: '2026-08-11T00:00:00.000Z'
          }]
        };
      }

      return { rows: [] };
    }

    async end() {
      this.ended = true;
    }
  };
}

test('initialize creates and locks down the public metrics table in order', async () => {
  const FakePool = createFakePoolClass();
  const MetricsStore = loadMetricsStoreWithPool(FakePool);
  const store = new MetricsStore('postgres://backend:secret@example.invalid/db');

  assert.equal(await store.initialize(), true);

  const pool = FakePool.instances[0];
  assert.ok(pool);
  const queries = pool.queries.map(({ text }) => text);

  assert.match(
    queries[0],
    /^CREATE TABLE IF NOT EXISTS public\.airdows_daily_metrics \(/
  );
  assert.equal(
    queries[1],
    'ALTER TABLE public.airdows_daily_metrics ENABLE ROW LEVEL SECURITY'
  );
  assert.equal(
    queries[2],
    'REVOKE ALL ON TABLE public.airdows_daily_metrics FROM anon'
  );
  assert.equal(
    queries[3],
    'REVOKE ALL ON TABLE public.airdows_daily_metrics FROM authenticated'
  );

  const initializationSql = queries.slice(0, 4).join('\n');
  assert.doesNotMatch(initializationSql, /CREATE\s+POLICY/i);
  assert.doesNotMatch(initializationSql, /GRANT\s+/i);
  assert.doesNotMatch(initializationSql, /REVOKE[^\n]*(?:service_role|postgres)/i);

  await store.close();
  assert.equal(pool.ended, true);
});

test('backend metric writes and reads still use the same store after hardening', async () => {
  const FakePool = createFakePoolClass();
  const MetricsStore = loadMetricsStoreWithPool(FakePool);
  const store = new MetricsStore('postgres://backend:secret@example.invalid/db');

  assert.equal(await store.initialize(), true);

  await store.writeDailyMetrics({
    samples: 1,
    completed: 1,
    failed: 0,
    cancelled: 0,
    host: 1,
    srflx: 0,
    relay: 0,
    unknownRoute: 0,
    relayChunks: 0,
    relayEstimatedBytes: 0,
    proRequiredEvents: 0
  });

  const totals = await store.getTotals();
  const pool = FakePool.instances[0];
  const queries = pool.queries.map(({ text }) => text);

  assert.ok(queries.some((query) => query.startsWith('INSERT INTO airdows_daily_metrics')));
  assert.ok(queries.some((query) => /FROM airdows_daily_metrics$/.test(query)));
  assert.deepEqual(totals, {
    samples: 7,
    completed: 6,
    failed: 1,
    cancelled: 0,
    host: 4,
    srflx: 2,
    relay: 1,
    unknownRoute: 0,
    relayChunks: 8,
    relayEstimatedBytes: 4096,
    proRequiredEvents: 0,
    startedAt: '2026-08-11T00:00:00.000Z'
  });

  await store.close();
  assert.equal(pool.ended, true);
});
