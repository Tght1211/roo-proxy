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

function createProxyServer(options = {}) {
  const {
    port,
    host = '127.0.0.1',
    configManager,
    balancer,
    logger,
    stats,
  } = options;

  const requestMap = new Map();

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

  const recordImmediateFailure = async ({ hostname, rule, error }) => {
    const payload = {
      hostname,
      rule,
      upstream: null,
      status: 'failed',
      durationMs: 0,
      isDirect: false,
      error: toErrorMessage(error),
    };

    stats.recordRequest(payload);
    await logger.access(payload);
  };

  const server = new ProxyChain.Server({
    port,
    host,
    verbose: false,
    prepareRequestFunction: async ({ hostname, connectionId }) => {
      const config = configManager.getConfig();
      const route = await resolveRoute(hostname, config);
      const rule = route.rule ? formatRuleLabel(route.rule) : null;
      const upstream = route.action === 'proxy'
        ? balancer.pickUpstream({ names: route.upstreams })
        : null;

      if (route.action === 'proxy' && !upstream) {
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

      requestMap.set(connectionId, {
        connectionId,
        hostname,
        rule,
        upstreamName: upstream ? upstream.name : null,
        startedAt: Date.now(),
        isDirect: route.action === 'direct',
        completed: false,
      });

      return {
        upstreamProxyUrl: upstream ? upstream.url : null,
        customTag: {
          connectionId,
          hostname,
          rule,
          upstreamName: upstream ? upstream.name : null,
        },
      };
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
};
