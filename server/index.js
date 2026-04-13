const { ConfigManager, getSettings, loadEnv, isRemoteConfigEnabled } = require('./config');
const { Logger } = require('./logger');
const { StatsManager } = require('./stats');
const { UpstreamBalancer } = require('./balancer');
const { createProxyServer } = require('./proxy');
const { createDashboard } = require('../dashboard');

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

  const logger = new Logger({
    logsDir: settings.logsDir,
    level: settings.logLevel,
    retainDays: settings.logRetainDays,
  });

  const configManager = new ConfigManager({ settings });
  const stats = new StatsManager({ filePath: settings.statsFilePath });
  const balancer = new UpstreamBalancer({ logger });

  await stats.load();
  stats.startAutoFlush();

  const config = await configManager.loadInitialConfig();
  balancer.updateConfig(config);
  balancer.startHealthCheck();

  configManager.on('updated', async (nextConfig, trigger) => {
    balancer.updateConfig(nextConfig);
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

  if (!configManager.startAutoRefresh(async (error) => {
    await logger.error('定时刷新配置失败', { error: error.message });
  }) && !isRemoteConfigEnabled(settings)) {
    await logger.info('未配置 Gist 自动刷新，当前使用本地配置或静态配置源');
  }

  const proxyServer = createProxyServer({
    port: settings.localPort,
    host: '127.0.0.1',
    configManager,
    balancer,
    logger,
    stats,
  });

  const dashboard = createDashboard({
    host: '127.0.0.1',
    port: settings.dashboardPort,
    configManager,
    balancer,
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
      config: configManager.getConfig(),
      upstreamHealth: balancer.getSnapshot(),
      statsSummary: stats.getStats(),
      env: {
        logLevel: settings.logLevel,
        logRetainDays: settings.logRetainDays,
        configRefreshIntervalMinutes: settings.configRefreshIntervalMinutes,
        remoteConfigEnabled: isRemoteConfigEnabled(settings),
      },
    }),
  });

  await proxyServer.listen();
  await dashboard.listen();

  const shutdown = async (signal) => {
    await logger.info(`收到 ${signal}，正在关闭 Roo 服务`);
    configManager.stopAutoRefresh();
    balancer.stopHealthCheck();
    stats.stopAutoFlush();
    await stats.persist().catch(() => {});
    await dashboard.close().catch(() => {});
    await proxyServer.close().catch(() => {});
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
