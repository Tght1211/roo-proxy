#!/usr/bin/env node

const { Command } = require('commander');
const { readRecentLogs } = require('../server/logger');
const {
  fetchRemoteConfig,
  getSettings,
  loadEnv,
  readConfigCache,
  updateRemoteConfig,
  writeConfigCache,
} = require('../server/config');
const { readPersistedStats } = require('../server/stats');
const { runHealthcheck, printHealthcheck } = require('../scripts/healthcheck');

loadEnv();
const settings = getSettings();
const program = new Command();

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`请求失败，HTTP ${response.status}`);
  }
  return response.json();
}

async function tryDashboard(pathname, options) {
  try {
    return await fetchJson(`http://127.0.0.1:${settings.dashboardPort}${pathname}`, options);
  } catch (error) {
    return null;
  }
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printList(items, emptyMessage) {
  if (!items.length) {
    console.log(emptyMessage);
    return;
  }

  items.forEach((item, index) => {
    console.log(`${index + 1}. ${item}`);
  });
}

async function loadCurrentConfig() {
  try {
    const { config } = await fetchRemoteConfig(settings);
    return config;
  } catch (error) {
    return readConfigCache(settings);
  }
}

async function mutateConfig(message, mutator) {
  const nextConfig = await updateRemoteConfig(mutator, settings);
  await writeConfigCache(nextConfig, settings);
  console.log(message);
  printJson(nextConfig);
}

function ensureValidDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!normalized || !normalized.includes('.')) {
    throw new Error('域名格式无效，请输入类似 openai.com 的域名。');
  }
  return normalized;
}

function ensureValidUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error('upstream URL 格式无效，请使用 http:// 或 socks5:// 开头的完整地址。');
  }

  const supported = ['http:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];
  if (!supported.includes(parsed.protocol)) {
    throw new Error(`不支持的 upstream 协议：${parsed.protocol}`);
  }

  return parsed.toString();
}

program
  .name('roo')
  .description('Roo 个人代理管理系统 CLI')
  .version('1.0.0');

program
  .command('status')
  .description('查看服务运行状态')
  .action(async () => {
    const status = await tryDashboard('/status');
    if (status) {
      printJson(status);
      return;
    }

    const config = await loadCurrentConfig();
    const stats = await readPersistedStats(settings.statsFilePath);
    printJson({
      running: false,
      message: '当前无法连接本地 dashboard，服务可能未启动。',
      localProxy: { host: '127.0.0.1', port: settings.localPort },
      dashboard: { host: '127.0.0.1', port: settings.dashboardPort },
      config,
      stats,
    });
  });

program
  .command('list')
  .description('列出所有规则域名')
  .action(async () => {
    const config = await loadCurrentConfig();
    printList(config.rules || [], '当前没有任何规则域名。');
  });

program
  .command('add <domain>')
  .description('添加域名规则')
  .action(async (domain) => {
    const normalizedDomain = ensureValidDomain(domain);
    await mutateConfig(`已添加规则：${normalizedDomain}`, (config) => {
      const rules = new Set(config.rules || []);
      if (rules.has(normalizedDomain)) {
        throw new Error(`规则 ${normalizedDomain} 已存在，无需重复添加。`);
      }
      config.rules = [...rules, normalizedDomain];
      return config;
    });
  });

program
  .command('remove <domain>')
  .description('删除域名规则')
  .action(async (domain) => {
    const normalizedDomain = ensureValidDomain(domain);
    await mutateConfig(`已删除规则：${normalizedDomain}`, (config) => {
      if (!(config.rules || []).includes(normalizedDomain)) {
        throw new Error(`规则 ${normalizedDomain} 不存在。`);
      }
      config.rules = (config.rules || []).filter((item) => item !== normalizedDomain);
      return config;
    });
  });

const upstream = program.command('upstream').description('管理 upstream');

upstream
  .command('list')
  .description('列出所有 upstream 及健康状态')
  .action(async () => {
    const status = await tryDashboard('/status');
    if (status && Array.isArray(status.upstreamHealth)) {
      printJson(status.upstreamHealth);
      return;
    }

    const config = await loadCurrentConfig();
    printJson((config.upstreams || []).map((item) => ({ ...item, healthy: null, note: '服务未运行，无法获取实时健康状态' })));
  });

upstream
  .command('add <name> <url>')
  .option('--weight <weight>', '设置权重', '1')
  .description('添加 upstream')
  .action(async (name, url, options) => {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw new Error('upstream 名称不能为空。');
    }

    const normalizedUrl = ensureValidUrl(url);
    const weight = Number.parseInt(options.weight, 10);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('权重必须是大于 0 的整数。');
    }

    await mutateConfig(`已添加 upstream：${normalizedName}`, (config) => {
      if ((config.upstreams || []).some((item) => item.name === normalizedName)) {
        throw new Error(`upstream ${normalizedName} 已存在。`);
      }
      config.upstreams = [
        ...(config.upstreams || []),
        {
          name: normalizedName,
          url: normalizedUrl,
          weight,
          enabled: true,
        },
      ];
      return config;
    });
  });

upstream
  .command('remove <name>')
  .description('删除 upstream')
  .action(async (name) => {
    await mutateConfig(`已删除 upstream：${name}`, (config) => {
      const exists = (config.upstreams || []).some((item) => item.name === name);
      if (!exists) {
        throw new Error(`upstream ${name} 不存在。`);
      }
      config.upstreams = (config.upstreams || []).filter((item) => item.name !== name);
      return config;
    });
  });

upstream
  .command('enable <name>')
  .description('启用 upstream')
  .action(async (name) => {
    await mutateConfig(`已启用 upstream：${name}`, (config) => {
      const item = (config.upstreams || []).find((entry) => entry.name === name);
      if (!item) {
        throw new Error(`upstream ${name} 不存在。`);
      }
      item.enabled = true;
      return config;
    });
  });

upstream
  .command('disable <name>')
  .description('禁用 upstream')
  .action(async (name) => {
    await mutateConfig(`已禁用 upstream：${name}`, (config) => {
      const item = (config.upstreams || []).find((entry) => entry.name === name);
      if (!item) {
        throw new Error(`upstream ${name} 不存在。`);
      }
      item.enabled = false;
      return config;
    });
  });

upstream
  .command('set-weight <name> <n>')
  .description('设置 upstream 权重')
  .action(async (name, n) => {
    const weight = Number.parseInt(n, 10);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('权重必须是大于 0 的整数。');
    }

    await mutateConfig(`已更新 upstream 权重：${name} -> ${weight}`, (config) => {
      const item = (config.upstreams || []).find((entry) => entry.name === name);
      if (!item) {
        throw new Error(`upstream ${name} 不存在。`);
      }
      item.weight = weight;
      return config;
    });
  });

program
  .command('strategy <strategy>')
  .description('切换负载均衡策略')
  .action(async (strategy) => {
    const allowed = ['round-robin', 'random', 'weighted'];
    if (!allowed.includes(strategy)) {
      throw new Error(`不支持的策略：${strategy}。可选值：${allowed.join(', ')}`);
    }

    await mutateConfig(`已切换负载均衡策略：${strategy}`, (config) => {
      config.balance_strategy = strategy;
      return config;
    });
  });

program
  .command('show')
  .description('展示完整当前配置')
  .action(async () => {
    const config = await loadCurrentConfig();
    printJson(config);
  });

program
  .command('reload')
  .description('手动触发远端规则重新拉取')
  .action(async () => {
    const dashboardResult = await tryDashboard('/reload', { method: 'POST' });
    if (dashboardResult) {
      console.log('服务已重新拉取远端规则。');
      printJson(dashboardResult);
      return;
    }

    const { config } = await fetchRemoteConfig(settings);
    await writeConfigCache(config, settings);
    console.log('服务未运行，已将远端配置拉取并刷新本地缓存。');
    printJson(config);
  });

program
  .command('stats')
  .description('查看流量统计摘要')
  .action(async () => {
    const stats = await tryDashboard('/stats');
    if (stats) {
      printJson(stats);
      return;
    }

    const localStats = await readPersistedStats(settings.statsFilePath);
    printJson({
      running: false,
      message: '当前无法连接 dashboard，以下为本地持久化统计数据。',
      ...localStats,
    });
  });

program
  .command('logs')
  .option('--n <n>', '查看最近 N 条日志', '50')
  .description('查看最近访问日志')
  .action(async (options) => {
    const limit = Math.max(Number.parseInt(options.n, 10) || 50, 1);
    const logs = await readRecentLogs(settings.logsDir, limit);
    printJson(logs);
  });

program
  .command('doctor')
  .description('环境自检')
  .action(async () => {
    const results = await runHealthcheck();
    await printHealthcheck(results);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(`Roo 命令执行失败：${error.message}`);
  process.exit(1);
});
