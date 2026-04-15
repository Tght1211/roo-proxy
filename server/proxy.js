const ProxyChain = require('proxy-chain');
const { formatRuleLabel, resolveRoute } = require('./router');

function toErrorMessage(error) {
  if (!error) {
    return null;
  }

  if (typeof error === 'string') {
    return error;
  }

  return String(error.message || error);
}

function getRelayProxyFromEnv() {
  return process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
}

function getRelayLoopConflict(localPort) {
  const relayProxy = getRelayProxyFromEnv();
  if (!relayProxy) {
    return null;
  }

  if (!isRelayToSelf(relayProxy, localPort)) {
    return null;
  }

  return {
    proxyUrl: relayProxy,
    localPort: Number(localPort),
  };
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function getUrlPort(parsed) {
  if (parsed.port) {
    return Number(parsed.port);
  }

  if (parsed.protocol === 'https:') {
    return 443;
  }

  if (parsed.protocol === 'http:') {
    return 80;
  }

  return 1080;
}

function isRelayToSelf(viaUrl, localPort) {
  if (!viaUrl) {
    return false;
  }

  try {
    const parsed = new URL(viaUrl);
    return isLoopbackHost(parsed.hostname) && getUrlPort(parsed) === Number(localPort);
  } catch (error) {
    return false;
  }
}

function createProxyServer(options = {}) {
  const {
    port,
    host = '127.0.0.1',
    configManager,
    balancer,
    logger,
    stats,
    chainManager,
  } = options;

  const requestMap = new Map();
  const relayProbeCache = new Map();
  const RELAY_PROBE_TTL_MS = 5_000;

  const finalizeRequest = async (connectionId, status, extra = {}) => {
    const requestInfo = requestMap.get(connectionId);
    if (!requestInfo || requestInfo.completed) {
      return;
    }

    requestInfo.completed = true;
    const durationMs = Date.now() - requestInfo.startedAt;
    const payload = {
      hostname: requestInfo.hostname,
      rule: requestInfo.rule,
      upstream: requestInfo.upstreamName,
      status,
      durationMs,
      isDirect: requestInfo.isDirect,
      error: toErrorMessage(extra.error),
    };

    if (status === 'success' && requestInfo.upstreamName) {
      balancer.markSuccess(requestInfo.upstreamName);
    }

    if (status === 'failed' && requestInfo.upstreamName) {
      balancer.markFailure(requestInfo.upstreamName, extra.error);
    }

    stats.recordRequest(payload);
    await logger.access(payload);
    requestMap.delete(connectionId);
  };

  const recordImmediateFailure = async ({ hostname, rule, error, upstreamName = null }) => {
    const payload = {
      hostname,
      rule,
      upstream: upstreamName,
      status: 'failed',
      durationMs: 0,
      isDirect: false,
      error: toErrorMessage(error),
    };

    stats.recordRequest(payload);
    await logger.access(payload);
  };

  const resolveUpstreamProxyUrl = async ({ upstream, localPort }) => {
    if (!upstream) {
      return { proxyUrl: null, relayVia: null };
    }

    const explicitVia = upstream.via ? String(upstream.via).trim() : null;
    const envRelayProxy = getRelayProxyFromEnv();
    const relayVia = explicitVia || envRelayProxy;

    if (!relayVia) {
      return { proxyUrl: upstream.url, relayVia: null };
    }

    if (isRelayToSelf(relayVia, localPort)) {
      throw new Error('前置代理指向 Roo 自身监听端口，已阻止循环链路');
    }

    const proxyUrl = await chainManager.getChainUrl(relayVia, upstream.url);
    return { proxyUrl, relayVia };
  };

  const ensureRelayHealthy = async ({ upstream, relayVia }) => {
    if (!relayVia || !chainManager || typeof chainManager.probeUpstream !== 'function') {
      return;
    }

    const cacheKey = `${relayVia}||${upstream.url}`;
    const now = Date.now();
    const cached = relayProbeCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      if (cached.error) {
        throw cached.error;
      }
      return;
    }

    try {
      await chainManager.probeUpstream(relayVia, upstream.url);
      relayProbeCache.set(cacheKey, {
        expiresAt: now + RELAY_PROBE_TTL_MS,
        error: null,
      });
    } catch (error) {
      const wrappedError = error instanceof Error
        ? error
        : new Error(String(error || '前置代理探测失败'));
      relayProbeCache.set(cacheKey, {
        expiresAt: now + RELAY_PROBE_TTL_MS,
        error: wrappedError,
      });
      throw wrappedError;
    }
  };

  const server = new ProxyChain.Server({
    port,
    host,
    verbose: false,
    prepareRequestFunction: async ({ hostname, connectionId }) => {
      const config = configManager.getConfig();
      const route = await resolveRoute(hostname, config);
      const rule = route.rule ? formatRuleLabel(route.rule) : null;
      const attemptedUpstreams = new Set();
      const localPort = configManager.settings && configManager.settings.localPort
        ? configManager.settings.localPort
        : port;

      if (route.action !== 'proxy') {
        requestMap.set(connectionId, {
          connectionId,
          hostname,
          rule,
          upstreamName: null,
          startedAt: Date.now(),
          isDirect: true,
          completed: false,
        });

        return {
          upstreamProxyUrl: null,
          customTag: {
            connectionId,
            hostname,
            rule,
            upstreamName: null,
          },
        };
      }

      while (true) {
        const upstream = balancer.pickUpstream({
          names: route.upstreams,
          excludeNames: [...attemptedUpstreams],
        });

        if (!upstream) {
          const scopedMessage = route.upstreams.length
            ? `当前没有可用的上游代理，请检查这些 upstream：${route.upstreams.join(', ')}`
            : '当前没有可用的上游代理，请检查 upstream 健康状态。';
          await recordImmediateFailure({
            hostname,
            rule,
            error: scopedMessage,
          });
          throw new ProxyChain.RequestError(scopedMessage, 502);
        }

        attemptedUpstreams.add(upstream.name);

        try {
          const { proxyUrl, relayVia } = await resolveUpstreamProxyUrl({ upstream, localPort });
          await ensureRelayHealthy({ upstream, relayVia });

          requestMap.set(connectionId, {
            connectionId,
            hostname,
            rule,
            upstreamName: upstream.name,
            startedAt: Date.now(),
            isDirect: false,
            completed: false,
          });

          return {
            upstreamProxyUrl: proxyUrl,
            customTag: {
              connectionId,
              hostname,
              rule,
              upstreamName: upstream.name,
            },
          };
        } catch (error) {
          balancer.markFailure(upstream.name, error);
          await logger.error('上游链路初始化失败，已尝试切流', {
            hostname,
            rule,
            upstream: upstream.name,
            error: toErrorMessage(error),
          });
        }
      }
    },
  });

  server.on('requestFailed', ({ request, error }) => {
    const connectionId = request && request.socket ? request.socket.proxyChainId : null;
    if (connectionId == null) {
      return;
    }

    finalizeRequest(connectionId, 'failed', { error }).catch(() => {});
  });

  server.on('tunnelConnectFailed', ({ customTag, response }) => {
    const connectionId = customTag && customTag.connectionId;
    if (connectionId == null) {
      return;
    }

    const statusCode = response ? response.statusCode : 'unknown';
    finalizeRequest(connectionId, 'failed', { error: new Error(`上游 CONNECT 失败，状态码：${statusCode}`) }).catch(() => {});
  });

  server.on('connectionClosed', ({ connectionId }) => {
    finalizeRequest(connectionId, 'success').catch(() => {});
  });

  return {
    async listen() {
      await server.listen();
      await logger.info(`Roo 代理服务已启动，监听 ${host}:${server.port}`);
    },
    async close() {
      await server.close(true);
    },
    getServer() {
      return server;
    },
  };
}

module.exports = {
  createProxyServer,
  getRelayProxyFromEnv,
  getRelayLoopConflict,
  isLoopbackHost,
  getUrlPort,
  isRelayToSelf,
};

