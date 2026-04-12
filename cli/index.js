#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { Command } = require('commander');
const { readRecentLogs } = require('../server/logger');
const {
  DEFAULT_LOCAL_CONFIG_RELATIVE_PATH,
  ensureLocalConfigFile,
  getDefaultConfig,
  getSettings,
  initializeActiveConfig,
  loadEnv,
  readActiveConfig,
  readConfigCache,
  resolveConfigSource,
  updateActiveConfig,
  writeConfigCache,
} = require('../server/config');
const { readPersistedStats } = require('../server/stats');
const { runHealthcheck, printHealthcheck } = require('../scripts/healthcheck');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const program = new Command();

loadEnv();

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`请求失败，HTTP ${response.status}`);
  }
  return response.json();
}

function getRuntimeSettings() {
  return getSettings();
}

function getConfigTargetLabel(settings) {
  if (settings.configSource === 'local') {
    return `本地配置文件：${settings.localConfigPath}`;
  }

  return `GitHub Gist：${settings.gistId || '未配置'}`;
}

async function tryDashboard(pathname, options) {
  const settings = getRuntimeSettings();
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
    return await readActiveConfig(getRuntimeSettings());
  } catch (error) {
    return readConfigCache(getRuntimeSettings());
  }
}

async function mutateConfig(message, mutator) {
  const settings = getRuntimeSettings();
  const nextConfig = await updateActiveConfig(mutator, settings);
  await writeConfigCache(nextConfig, settings);
  console.log(message);
  console.log(`当前配置后端：${getConfigTargetLabel(settings)}`);
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

async function readEnvFile() {
  try {
    return await fs.readFile(ENV_PATH, 'utf8');
  } catch (error) {
    return '';
  }
}

function setEnvValue(content, key, value) {
  const lines = content ? content.split('\n') : [];
  let updated = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!updated) {
    nextLines.push(`${key}=${value}`);
  }

  return `${nextLines.filter((line, index, array) => !(index === array.length - 1 && line === '')).join('\n')}\n`;
}

async function writeEnvValues(pairs) {
  let content = await readEnvFile();
  for (const [key, value] of Object.entries(pairs)) {
    content = setEnvValue(content, key, value);
    process.env[key] = value;
  }
  await fs.writeFile(ENV_PATH, content, 'utf8');
}

async function runInitWizard() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log('Roo 初始化向导');
    console.log('====================');
    console.log('你可以选择两种配置模式：');
    console.log('1) local：规则保存在本地 JSON 文件，最适合第一次使用');
    console.log('2) gist：规则保存在 GitHub Private Gist，支持在线更新');

    const sourceAnswer = await rl.question('请选择配置模式（local/gist，默认 local）： ');
    const configSource = resolveConfigSource(sourceAnswer || 'local', { GIST_ID: '', GITHUB_TOKEN: '' });

    const localPort = (await rl.question('本地代理端口（默认 7890）： ')).trim() || '7890';
    const dashboardPort = (await rl.question('Dashboard 端口（默认 7891）： ')).trim() || '7891';
    const logLevel = (await rl.question('日志级别（debug/info/error，默认 info）： ')).trim() || 'info';

    const envValues = {
      CONFIG_SOURCE: configSource,
      LOCAL_PORT: localPort,
      DASHBOARD_PORT: dashboardPort,
      LOG_LEVEL: logLevel,
      LOG_RETAIN_DAYS: '7',
      CONFIG_REFRESH_INTERVAL: '5',
      LOCAL_CONFIG_PATH: DEFAULT_LOCAL_CONFIG_RELATIVE_PATH,
    };

    const draftConfig = getDefaultConfig();

    if (configSource === 'gist') {
      const gistId = (await rl.question('GitHub Private Gist ID： ')).trim();
      const githubToken = (await rl.question('GitHub Token： ')).trim();
      if (!gistId || !githubToken) {
        throw new Error('gist 模式必须填写 GIST_ID 和 GITHUB_TOKEN。');
      }
      envValues.GIST_ID = gistId;
      envValues.GITHUB_TOKEN = githubToken;
    } else {
      envValues.GIST_ID = '';
      envValues.GITHUB_TOKEN = '';
    }

    const firstRuleAnswer = (await rl.question('可选：输入第一条规则域名（留空跳过）： ')).trim();
    if (firstRuleAnswer) {
      draftConfig.rules.push(ensureValidDomain(firstRuleAnswer));
    }

    const addUpstreamAnswer = (await rl.question('现在是否添加第一个 upstream？（y/N）： ')).trim().toLowerCase();
    if (addUpstreamAnswer === 'y') {
      const upstreamName = (await rl.question('upstream 名称： ')).trim();
      const upstreamUrl = ensureValidUrl((await rl.question('upstream URL： ')).trim());
      const upstreamWeight = Number.parseInt((await rl.question('权重（默认 1）： ')).trim() || '1', 10);
      draftConfig.upstreams.push({
        name: upstreamName,
        url: upstreamUrl,
        weight: Number.isFinite(upstreamWeight) && upstreamWeight > 0 ? upstreamWeight : 1,
        enabled: true,
      });
    }

    await writeEnvValues(envValues);
    loadEnv();
    const settings = getRuntimeSettings();

    if (configSource === 'local') {
      await ensureLocalConfigFile(settings, draftConfig);
      await initializeActiveConfig(draftConfig, settings);
    } else {
      await initializeActiveConfig(draftConfig, settings);
    }

    await writeConfigCache(draftConfig, settings);

    console.log('');
    console.log('初始化完成。');
    console.log(`当前配置模式：${settings.configSource}`);
    console.log(`配置位置：${getConfigTargetLabel(settings)}`);
    console.log('下一步建议：');
    console.log('- 启动服务：npm run serve');
    console.log('- 查看当前配置：roo show');
    console.log('- 添加规则：roo add openai.com');
    console.log('- 添加 upstream：roo upstream add residential-01 socks5://user:pass@host:1080');
    console.log(`- 打开面板：http://127.0.0.1:${settings.dashboardPort}`);
    console.log(`- 浏览器代理地址：127.0.0.1:${settings.localPort}`);
  } finally {
    rl.close();
  }
}

program
  .name('roo')
  .description('Roo 个人代理管理系统 CLI')
  .version('1.0.0');

program
  .command('init')
  .description('引导式初始化 Roo 配置')
  .action(async () => {
    await runInitWizard();
  });

program
  .command('status')
  .description('查看服务运行状态')
  .action(async () => {
    const settings = getRuntimeSettings();
    const status = await tryDashboard('/status');
    if (status) {
      printJson(status);
      return;
    }

    const config = await loadCurrentConfig();
    const stats = await readPersistedStats(settings.statsFilePath);
    printJson({
      running: false,
      message: '当前无法连接本地 dashboard，服务可能未启动。若你是第一次使用，请先执行 roo init。',
      configSource: settings.configSource,
      configTarget: getConfigTargetLabel(settings),
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
    printList(config.rules || [], '当前没有任何规则域名。你可以先执行 roo add openai.com 添加一条。');
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
    const settings = getRuntimeSettings();
    const config = await loadCurrentConfig();
    printJson({
      configSource: settings.configSource,
      configTarget: getConfigTargetLabel(settings),
      config,
    });
  });

program
  .command('reload')
  .description('手动触发配置重新拉取 / 重新加载')
  .action(async () => {
    const settings = getRuntimeSettings();
    const dashboardResult = await tryDashboard('/reload', { method: 'POST' });
    if (dashboardResult) {
      console.log('服务已重新加载配置。');
      printJson(dashboardResult);
      return;
    }

    const config = await loadCurrentConfig();
    await writeConfigCache(config, settings);
    console.log(`服务未运行，已从 ${getConfigTargetLabel(settings)} 重新加载配置并刷新本地缓存。`);
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

    const localStats = await readPersistedStats(getRuntimeSettings().statsFilePath);
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
    const logs = await readRecentLogs(getRuntimeSettings().logsDir, limit);
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
