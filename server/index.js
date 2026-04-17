const net = require('net');
const { ConfigManager, getSettings, loadEnv, isRemoteConfigEnabled } = require('./config');
const { Logger } = require('./logger');
const { StatsManager } = require('./stats');
const { UpstreamBalancer } = require('./balancer');
const { createProxyServer, getRelayLoopConflict } = require('./proxy');
const { ChainProxyManager } = require('./chain');
const { handleSocks5Connection } = require('./socks5');
const { createDashboard } = require('../dashboard');
const { getSystemProxyStatus } = require('./system-proxy');

function maskSensitiveUrl(rawUrl) {
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) {
      parsed.username = '****';
    }
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch (error) {
    return rawUrl;
  }
}


function sanitizeConfigForStatus(config) {
  const nextConfig = config && typeof config === 'object'
    ? JSON.parse(JSON.stringify(config))
    : { upstreams: [], rules: [] };

  nextConfig.upstreams = Array.isArray(nextConfig.upstreams)
    ? nextConfig.upstreams.map((upstream) => ({
        ...upstream,
        url: maskSensitiveUrl(upstream.url),
        via: upstream.via ? maskSensitiveUrl(upstream.via) : upstream.via,
      }))
    : [];

  return nextConfig;
}

function ensureNoRelayLoop(settings) {
  const conflict = getRelayLoopConflict(settings.localPort);
  if (!conflict) {
    return;
  }

  const port = conflict.localPort || settings.localPort;
  const proxyUrl = conflict.proxyUrl;
  throw new Error(`检测到前置代理端口冲突：LOCAL_PORT=${port} 与环境代理 ${proxyUrl} 指向同一监听端口。请修改 LOCAL_PORT 或 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，避免自循环代理。`);
}

async function detectRunningRoo(settings) {
  try {
    const response = await fetch(`http://127.0.0.1:${settings.dashboardPort}/status`);
    if (!response.ok) {
      return null;
    }

    const status = await response.json();
    if (status && status.service === 'roo' && status.localProxy && status.localProxy.port === settings.localPort) {
      return status;
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function bootstrap() {
  loadEnv();
  const settings = getSettings();
  ensureNoRelayLoop(settings);

  const logger = new Logger({
    logsDir: settings.logsDir,
    level: settings.logLevel,
    retainDays: settings.logRetainDays,
  });

  const configManager = new ConfigManager({ settings });
  const stats = new StatsManager({ filePath: settings.statsFilePath });
  const balancer = new UpstreamBalancer({ logger });
  const chainManager = new ChainProxyManager();

  await stats.load();
  stats.startAutoFlush();

  const config = await configManager.loadInitialConfig();
  balancer.updateConfig(config);
  await chainManager.syncUpstreams(config.upstreams);
  balancer.startHealthCheck();

  configManager.on('updated', async (nextConfig, trigger) => {
    balancer.updateConfig(nextConfig);
    await chainManager.syncUpstreams(nextConfig.upstreams);
    await logger.info('配置已更新', {
      trigger,
      strategy: nextConfig.balance_strategy,
      upstreamCount: nextConfig.upstreams.length,
      ruleCount: nextConfig.rules.length,
    });
  });

  configManager.on('warning', async (error) => {
    await logger.error('配置刷新失败，已继续使用当前配置', { error: error.message });
  });

  configManager.startAutoRefresh(async (error) => {
    await logger.error('定时刷新配置失败', { error: error.message });
  });

  // ProxyChain handles HTTP/HTTPS CONNECT on a random internal port.
  const proxyServer = createProxyServer({
    port: 0,
    host: '127.0.0.1',
    configManager,
    balancer,
    logger,
    stats,
    chainManager,
  });

  const dashboard = createDashboard({
    host: '127.0.0.1',
    port: settings.dashboardPort,
    configManager,
    balancer,
    chainManager,
    logger,
    stats,
    logsDir: settings.logsDir,
    getStatus: () => ({
      service: 'roo',
      running: true,
      startedAtSeconds: process.uptime(),
      configSource: settings.configSource,
      configTarget: configManager.getMeta(),
      localProxy: {
        host: '127.0.0.1',
        port: settings.localPort,
      },
      dashboard: {
        host: '127.0.0.1',
        port: settings.dashboardPort,
      },
      config: sanitizeConfigForStatus(configManager.getConfig()),
      upstreamHealth: balancer.getSnapshot(),
      statsSummary: stats.getStats(),
      systemProxy: {
        supported: process.platform === 'darwin',
      },
      env: {
        logLevel: settings.logLevel,
        logRetainDays: settings.logRetainDays,
        configRefreshIntervalMinutes: settings.configRefreshIntervalMinutes,
        remoteConfigEnabled: isRemoteConfigEnabled(settings),
      },
    }),
  });

  await proxyServer.listen();

  // The multiplexer listens on LOCAL_PORT and routes:
  //   first byte 0x05 → SOCKS5 handler
  //   otherwise       → ProxyChain's internal HTTP server (HTTP + HTTPS CONNECT)
  const internalHttpServer = proxyServer.getServer().server;
  const muxSockets = new Set();
  const multiplexer = net.createServer((socket) => {
    muxSockets.add(socket);
    socket.once('close', () => muxSockets.delete(socket));
    socket.once('data', (firstChunk) => {
      if (firstChunk[0] === 0x05) {
        socket.pause();
        socket.unshift(firstChunk);
        handleSocks5Connection(socket, { balancer, configManager, logger, stats, chainManager })
          .catch(() => socket.destroy());
      } else {
        socket.unshift(firstChunk);
        internalHttpServer.emit('connection', socket);
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    multiplexer.once('error', reject);
    multiplexer.listen(settings.localPort, '127.0.0.1', () => {
      multiplexer.removeListener('error', reject);
      resolve();
    });
  });

  await logger.info(`Roo 代理服务已启动，监听 127.0.0.1:${settings.localPort}（HTTP / HTTPS / SOCKS5 同端口）`);

  await dashboard.listen();

  const shutdown = async (signal) => {
    await logger.info(`收到 ${signal}，正在关闭 Roo 服务`);
    configManager.stopAutoRefresh();
    balancer.stopHealthCheck();
    stats.stopAutoFlush();
    await stats.persist().catch(() => {});
    await dashboard.close().catch(() => {});
    for (const s of muxSockets) s.destroy();
    muxSockets.clear();
    await new Promise((resolve) => multiplexer.close(resolve)).catch(() => {});
    await proxyServer.close().catch(() => {});
    await chainManager.stopAll().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch(async (error) => {
  const message = error && error.message ? error.message : '未知错误';

  if (message.includes('EADDRINUSE')) {
    loadEnv();
    const settings = getSettings();
    const runningStatus = await detectRunningRoo(settings);
    if (runningStatus) {
      console.log(`Roo 已经在运行：127.0.0.1:${settings.localPort}（Dashboard: 127.0.0.1:${settings.dashboardPort}）`);
      process.exit(0);
    }
  }

  console.error(`Roo 启动失败：${message}`);
  process.exit(1);
});
