const { Pool } = require('pg');

const METRIC_FIELDS = [
  'samples', 'completed', 'failed', 'cancelled', 'host', 'srflx', 'relay',
  'unknownRoute', 'relayChunks', 'relayEstimatedBytes', 'proRequiredEvents'
];

function createEmptyMetrics() {
  return Object.fromEntries(METRIC_FIELDS.map((field) => [field, 0]));
}

class MetricsStore {
  constructor(connectionString) {
    this.enabled = Boolean(connectionString);
    this.pending = createEmptyMetrics();
    this.flushTimer = null;
    this.flushPromise = null;
    this.pool = this.enabled
      ? new Pool({
          connectionString,
          ssl: process.env.METRICS_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
        })
      : null;
  }

  async initialize() {
    if (!this.enabled) {
      console.info('[AirDows] Persistent metrics disabled: set METRICS_DATABASE_URL to enable them.');
      return false;
    }

    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS airdows_daily_metrics (
          metric_date DATE PRIMARY KEY,
          samples BIGINT NOT NULL DEFAULT 0,
          completed BIGINT NOT NULL DEFAULT 0,
          failed BIGINT NOT NULL DEFAULT 0,
          cancelled BIGINT NOT NULL DEFAULT 0,
          host BIGINT NOT NULL DEFAULT 0,
          srflx BIGINT NOT NULL DEFAULT 0,
          relay BIGINT NOT NULL DEFAULT 0,
          unknown_route BIGINT NOT NULL DEFAULT 0,
          relay_chunks BIGINT NOT NULL DEFAULT 0,
          relay_estimated_bytes BIGINT NOT NULL DEFAULT 0,
          pro_required_events BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      console.info('[AirDows] Persistent metrics connected.');
      return true;
    } catch (error) {
      console.error('[AirDows] Persistent metrics unavailable:', error.message);
      this.enabled = false;
      await this.pool.end().catch(() => {});
      this.pool = null;
      return false;
    }
  }

  record(delta = {}) {
    if (!this.enabled) return;
    for (const field of METRIC_FIELDS) {
      const value = Number(delta[field]);
      if (Number.isFinite(value) && value > 0) this.pending[field] += Math.floor(value);
    }

    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 5000);
    this.flushTimer.unref?.();
  }

  hasPendingMetrics() {
    return METRIC_FIELDS.some((field) => this.pending[field] > 0);
  }

  async flush() {
    if (!this.enabled || !this.hasPendingMetrics()) return;
    if (this.flushPromise) return this.flushPromise;

    const pending = this.pending;
    this.pending = createEmptyMetrics();
    this.flushPromise = this.writeDailyMetrics(pending);

    try {
      await this.flushPromise;
    } catch (error) {
      for (const field of METRIC_FIELDS) this.pending[field] += pending[field];
      console.error('[AirDows] Could not persist metrics:', error.message);
    } finally {
      this.flushPromise = null;
      if (this.hasPendingMetrics() && !this.flushTimer) {
        this.record({});
      }
    }
  }

  async writeDailyMetrics(metrics) {
    const columns = [
      'samples', 'completed', 'failed', 'cancelled', 'host', 'srflx', 'relay',
      'unknown_route', 'relay_chunks', 'relay_estimated_bytes', 'pro_required_events'
    ];
    const values = METRIC_FIELDS.map((field) => metrics[field]);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const updates = columns.map((column) => `${column} = airdows_daily_metrics.${column} + EXCLUDED.${column}`).join(', ');

    await this.pool.query(
      `INSERT INTO airdows_daily_metrics (metric_date, ${columns.join(', ')})
       VALUES (CURRENT_DATE, ${placeholders})
       ON CONFLICT (metric_date) DO UPDATE SET ${updates}, updated_at = NOW()`,
      values
    );
  }

  async getTotals() {
    if (!this.enabled) return null;
    await this.flush();

    try {
      const { rows } = await this.pool.query(`
        SELECT
          COALESCE(SUM(samples), 0) AS samples,
          COALESCE(SUM(completed), 0) AS completed,
          COALESCE(SUM(failed), 0) AS failed,
          COALESCE(SUM(cancelled), 0) AS cancelled,
          COALESCE(SUM(host), 0) AS host,
          COALESCE(SUM(srflx), 0) AS srflx,
          COALESCE(SUM(relay), 0) AS relay,
          COALESCE(SUM(unknown_route), 0) AS unknown_route,
          COALESCE(SUM(relay_chunks), 0) AS relay_chunks,
          COALESCE(SUM(relay_estimated_bytes), 0) AS relay_estimated_bytes,
          COALESCE(SUM(pro_required_events), 0) AS pro_required_events,
          MIN(metric_date) AS started_at
        FROM airdows_daily_metrics
      `);
      const row = rows[0] || {};
      return {
        samples: Number(row.samples || 0),
        completed: Number(row.completed || 0),
        failed: Number(row.failed || 0),
        cancelled: Number(row.cancelled || 0),
        host: Number(row.host || 0),
        srflx: Number(row.srflx || 0),
        relay: Number(row.relay || 0),
        unknownRoute: Number(row.unknown_route || 0),
        relayChunks: Number(row.relay_chunks || 0),
        relayEstimatedBytes: Number(row.relay_estimated_bytes || 0),
        proRequiredEvents: Number(row.pro_required_events || 0),
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null
      };
    } catch (error) {
      console.error('[AirDows] Could not read persisted metrics:', error.message);
      return null;
    }
  }

  async close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
    await this.pool?.end();
  }
}

module.exports = { MetricsStore };
