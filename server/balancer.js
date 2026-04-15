const net = require('net');

function redactUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.password) {
      parsed.password = '******';
    }
    return parsed.toString();
  } catch (error) {
    return urlString;
  }
}

class UpstreamBalancer {
  constructor(options = {}) {
    this.logger = options.logger;
    this.probeIntervalMs = options.probeIntervalMs || 30_000;
    this.probeTimeoutMs = options.probeTimeoutMs || 5_000;
    this.strategy = 'round-robin';
    this.roundRobinIndex = 0;
    this.state = new Map();
    this.timer = null;
  }

  updateConfig(config) {
    this.strategy = config.balance_strategy || 'round-robin';
    const nextState = new Map();

    for (const upstream of config.upstreams || []) {
      const previous = this.state.get(upstream.name) || {};
      nextState.set(upstream.name, {
        ...upstream,
        healthy: previous.healthy !== false,
        failCount: previous.failCount || 0,
        lastFailureAt: previous.lastFailureAt || null,
        lastRecoveryAt: previous.lastRecoveryAt || null,
        lastCheckedAt: previous.lastCheckedAt || null,
        lastError: previous.lastError || null,
      });
    }

    this.state = nextState;
  }

  filterUpstreams(items, options = {}) {
    const names = Array.isArray(options.names) && options.names.length
      ? new Set(options.names)
      : null;
    const excludeNames = Array.isArray(options.excludeNames) && options.excludeNames.length
      ? new Set(options.excludeNames)
      : null;

    return items.filter((item) => {
      if (names && !names.has(item.name)) {
        return false;
      }

      if (excludeNames && excludeNames.has(item.name)) {
        return false;
      }

      return true;
    });
  }

  getEnabledUpstreams(options = {}) {
    const enabled = Array.from(this.state.values()).filter((item) => item.enabled);
    return this.filterUpstreams(enabled, options);
  }

  getHealthyUpstreams(options = {}) {
    return this.getEnabledUpstreams(options).filter((item) => item.healthy !== false);
  }

  pickUpstream(options = {}) {
    const candidates = this.getHealthyUpstreams(options);
    if (!candidates.length) {
      return null;
    }

    if (this.strategy === 'random') {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    if (this.strategy === 'weighted') {
      const totalWeight = candidates.reduce((sum, item) => sum + Math.max(item.weight || 1, 1), 0);
      let cursor = Math.random() * totalWeight;
      for (const candidate of candidates) {
        cursor -= Math.max(candidate.weight || 1, 1);
        if (cursor <= 0) {
          return candidate;
        }
      }
      return candidates[candidates.length - 1];
    }

    const selected = candidates[this.roundRobinIndex % candidates.length];
    this.roundRobinIndex += 1;
    return selected;
  }

  markSuccess(name) {
    const upstream = this.state.get(name);
    if (!upstream) {
      return;
    }

    const wasUnhealthy = upstream.healthy === false;
    upstream.healthy = true;
    if (wasUnhealthy) {
      upstream.lastRecoveryAt = new Date().toISOString();
    }
    upstream.lastError = null;
  }

  markFailure(name, error) {
    const upstream = this.state.get(name);
    if (!upstream) {
      return;
    }

    upstream.healthy = false;
    upstream.failCount += 1;
    upstream.lastFailureAt = new Date().toISOString();
    upstream.lastError = error ? String(error.message || error) : '未知错误';
  }

  async probeUpstream(upstream) {
    upstream.lastCheckedAt = new Date().toISOString();

    return new Promise((resolve) => {
      let settled = false;
      const parsed = new URL(upstream.url);
      const port = Number(parsed.port)
        || (parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : 1080);
      const socket = net.createConnection({
        host: parsed.hostname,
        port,
      });

      const finish = (healthy, error) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();

        if (healthy) {
          const wasUnhealthy = upstream.healthy === false;
          upstream.healthy = true;
          upstream.lastError = null;
          if (wasUnhealthy) {
            upstream.lastRecoveryAt = new Date().toISOString();
          }
        } else {
          upstream.healthy = false;
          upstream.lastError = error ? String(error.message || error) : '探活失败';
        }

        resolve(healthy);
      };

      socket.setTimeout(this.probeTimeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false, new Error('连接超时')));
      socket.once('error', (error) => finish(false, error));
    });
  }

  async probeEnabledUpstreams() {
    const targets = this.getEnabledUpstreams();
    for (const upstream of targets) {
      const wasHealthy = upstream.healthy !== false;
      const healthyNow = await this.probeUpstream(upstream);

      if (!healthyNow && wasHealthy && this.logger) {
        this.logger.warn
          ? this.logger.warn(`upstream ${upstream.name} 连通性异常：${upstream.lastError || '探活失败'}`)
          : this.logger.info(`upstream ${upstream.name} 连通性异常：${upstream.lastError || '探活失败'}`);
      }

      if (healthyNow && !wasHealthy && this.logger) {
        this.logger.info(`upstream ${upstream.name} 已恢复健康状态`);
      }
    }
  }

  async probeUnhealthyUpstreams() {
    const targets = this.getEnabledUpstreams().filter((item) => item.healthy === false);
    for (const upstream of targets) {
      const recovered = await this.probeUpstream(upstream);
      if (recovered && this.logger) {
        this.logger.info(`upstream ${upstream.name} 已恢复健康状态`);
      }
    }
  }

  startHealthCheck() {
    this.stopHealthCheck();

    const runProbe = () => {
      this.probeEnabledUpstreams().catch((error) => {
        if (this.logger) {
          this.logger.error(`upstream 探活失败：${error.message}`);
        }
      });
    };

    runProbe();
    this.timer = setInterval(runProbe, this.probeIntervalMs);
  }


  stopHealthCheck() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot() {
    return Array.from(this.state.values()).map((item) => ({
      name: item.name,
      url: redactUrl(item.url),
      weight: item.weight,
      enabled: item.enabled,
      healthy: item.healthy !== false,
      failCount: item.failCount,
      lastFailureAt: item.lastFailureAt,
      lastRecoveryAt: item.lastRecoveryAt,
      lastCheckedAt: item.lastCheckedAt,
      lastError: item.lastError,
    }));
  }
}

module.exports = {
  UpstreamBalancer,
  redactUrl,
};
