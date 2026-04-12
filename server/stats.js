const fs = require('fs/promises');

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createEmptyStats() {
  return {
    totalRequests: 0,
    todayRequests: 0,
    todayKey: getTodayKey(),
    upstreams: {},
    domains: {},
    updatedAt: null,
  };
}

class StatsManager {
  constructor(options = {}) {
    this.filePath = options.filePath;
    this.flushIntervalMs = options.flushIntervalMs || 30_000;
    this.data = createEmptyStats();
    this.timer = null;
  }

  rolloverTodayIfNeeded() {
    const todayKey = getTodayKey();
    if (this.data.todayKey !== todayKey) {
      this.data.todayKey = todayKey;
      this.data.todayRequests = 0;
    }
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      this.data = {
        ...createEmptyStats(),
        ...parsed,
        upstreams: parsed.upstreams || {},
        domains: parsed.domains || {},
      };
      this.rolloverTodayIfNeeded();
    } catch (error) {
      this.data = createEmptyStats();
    }

    return this.getStats();
  }

  async persist() {
    this.data.updatedAt = new Date().toISOString();
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  startAutoFlush() {
    this.stopAutoFlush();
    this.timer = setInterval(() => {
      this.persist().catch(() => {});
    }, this.flushIntervalMs);
  }

  stopAutoFlush() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordRequest(entry = {}) {
    this.rolloverTodayIfNeeded();
    this.data.totalRequests += 1;
    this.data.todayRequests += 1;

    const ruleKey = entry.rule || entry.hostname || 'unknown';
    this.data.domains[ruleKey] = (this.data.domains[ruleKey] || 0) + 1;

    if (entry.upstream) {
      const current = this.data.upstreams[entry.upstream] || {
        requests: 0,
        success: 0,
        failure: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
      };

      current.requests += 1;
      if (entry.status === 'success') {
        current.success += 1;
      } else if (entry.status === 'failed') {
        current.failure += 1;
      }
      current.totalDurationMs += Number(entry.durationMs || 0);
      current.averageDurationMs = current.requests ? Number((current.totalDurationMs / current.requests).toFixed(2)) : 0;
      this.data.upstreams[entry.upstream] = current;
    }
  }

  getStats() {
    this.rolloverTodayIfNeeded();
    return JSON.parse(JSON.stringify(this.data));
  }
}

async function readPersistedStats(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return createEmptyStats();
  }
}

module.exports = {
  StatsManager,
  createEmptyStats,
  readPersistedStats,
};
