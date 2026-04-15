#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline/promises');
const { execFile } = require('child_process');
const { stdin, stdout } = require('process');
const { promisify } = require('util');
const { Command } = require('commander');
const { readRecentLogs } = require('../server/logger');
const {
  DEFAULT_LOCAL_CONFIG_RELATIVE_PATH,
  ensureLocalConfigFile,
  formatRuleLabel,
  getDefaultConfig,
  getSettings,
  initializeActiveConfig,
  loadEnv,
  normalizeRuleValue,
  readActiveConfig,
  readConfigCache,
  resolveConfigSource,
  resolveRuleType,
  SUPPORTED_RULE_TYPES,
  updateActiveConfig,
  writeConfigCache,
} = require('../server/config');
const { readPersistedStats } = require('../server/stats');
const {
  disableSystemProxy,
  enableSystemProxy,
  formatSystemProxySummary,
  getSystemProxyStatus,
  restoreSystemProxy,
} = require('../server/system-proxy');
const { runHealthcheck, printHealthcheck } = require('../scripts/healthcheck');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const ROOT_DIR = path.resolve(__dirname, '..');
const ECOSYSTEM_CONFIG_PATH = path.join(ROOT_DIR, 'server', 'ecosystem.config.js');
const execFileAsync = promisify(execFile);
const program = new Command();

loadEnv();

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`请求失败，HTTP ${response.status}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function printRuntimeSummary(status) {
  const config = status.config || {};
  const upstreams = Array.isArray(config.upstreams) ? config.upstreams.length : 0;
  const rules = Array.isArray(config.rules) ? config.rules.length : 0;
  const defaultRoute = config.default_route && config.default_route.action === 'proxy'
    ? `默认出口: ${config.default_route.upstreams.join(', ')}`
    : '默认出口: 直连 / 系统路由';

  console.log(`Roo 运行中`);
  console.log(`代理: 127.0.0.1:${status.localProxy.port}`);
  console.log(`面板: 127.0.0.1:${status.dashboard.port}`);
  console.log(`${defaultRoute}`);
  console.log(`规则数: ${rules}`);
  console.log(`出口节点数: ${upstreams}`);
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

async function commandExists(command, versionArgs = ['--version']) {
  try {
    await execFileAsync(command, versionArgs);
    return true;
  } catch (error) {
    return false;
  }
}

async function requireCommand(command, installHint) {
  const exists = await commandExists(command, command === 'pm2' ? ['-v'] : ['--version']);
  if (!exists) {
    throw new Error(`${command} 未安装。${installHint}`);
  }
}

async function runExec(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd || ROOT_DIR,
    timeout: options.timeout,
    env: options.env || process.env,
    maxBuffer: options.maxBuffer || 1024 * 1024,
  });
}

async function waitForServiceState(expectedRunning, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await tryDashboard('/status');
    if (expectedRunning) {
      if (status && status.running) {
        return status;
      }
    } else if (!status) {
      return true;
    }

    await sleep(400);
  }

  return expectedRunning ? null : false;
}

function isRooCommandLine(commandLine = '', settings = getRuntimeSettings()) {
  return commandLine.includes(settings.rootDir) || commandLine.includes('server/index.js');
}

async function getListeningPids(port) {
  try {
    const { stdout } = await runExec('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    return [];
  }
}

async function getProcessCommand(pid) {
  try {
    const { stdout } = await runExec('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.trim();
  } catch (error) {
    return '';
  }
}

async function findForegroundRooPids(settings = getRuntimeSettings()) {
  const ports = [settings.localPort, settings.dashboardPort];
  const pidSet = new Set();

  for (const port of ports) {
    const pids = await getListeningPids(port);
    pids.forEach((pid) => {
      if (pid !== process.pid) {
        pidSet.add(pid);
      }
    });
  }

  const matched = [];
  for (const pid of pidSet) {
    const commandLine = await getProcessCommand(pid);
    if (isRooCommandLine(commandLine, settings)) {
      matched.push(pid);
    }
  }

  return matched;
}

async function stopForegroundRoo(settings = getRuntimeSettings()) {
  const pids = await findForegroundRooPids(settings);
  pids.forEach((pid) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      // Ignore races where the process exits between detection and signal.
    }
  });

  return pids;
}

async function pm2StartOrRestart() {
  await requireCommand('pm2', '请先执行 npm install -g pm2。');
  return runExec('pm2', ['startOrRestart', ECOSYSTEM_CONFIG_PATH]);
}

async function pm2DeleteRoo() {
  await requireCommand('pm2', '请先执行 npm install -g pm2。');
  try {
    await runExec('pm2', ['delete', 'roo']);
    return true;
  } catch (error) {
    return false;
  }
}

async function proxyCurl(url, timeoutSeconds = 20) {
  const settings = getRuntimeSettings();
  await requireCommand('curl', '请先安装 curl 再使用 roo ip / roo check。');
  return runExec('curl', [
    '-sS',
    '--max-time', String(timeoutSeconds),
    '-x', `http://127.0.0.1:${settings.localPort}`,
    url,
  ], { maxBuffer: 4 * 1024 * 1024 });
}

async function syncRunningService() {
  const result = await tryDashboard('/reload', { method: 'POST' });
  return Boolean(result && result.ok);
}

async function mutateConfig(message, mutator) {
  const settings = getRuntimeSettings();
  const nextConfig = await updateActiveConfig(mutator, settings);
  await writeConfigCache(nextConfig, settings);
  const reloaded = await syncRunningService();
  console.log(message);
  console.log(`当前配置后端：${getConfigTargetLabel(settings)}`);
  if (reloaded) {
    console.log('运行中的 Roo 服务已自动重新加载配置。');
  }
  printJson(nextConfig);
}

function ensureValidUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error('出口节点 URL 格式无效，请使用 http://、https:// 或 socks5:// 开头的完整地址。');
  }

  const supported = ['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];
  if (!supported.includes(parsed.protocol)) {
    throw new Error(`不支持的出口节点协议：${parsed.protocol}`);
  }

  return parsed.toString();
}

function normalizeUpstreamName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) {
    throw new Error('出口节点名称不能为空。');
  }
  return normalized;
}

function parseUpstreamList(value) {
  const names = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const seen = new Set();
  return names.filter((name) => {
    if (seen.has(name)) {
      return false;
    }

    seen.add(name);
    return true;
  });
}

function ensureRuleUpstreamsExist(config, upstreamNames) {
  const knownUpstreams = new Set((config.upstreams || []).map((item) => item.name));
  upstreamNames.forEach((name) => {
    if (!knownUpstreams.has(name)) {
      throw new Error(`引用的出口节点不存在：${name}`);
    }
  });
}

function resolveRuleTypeOption(options = {}) {
  const explicitTypes = [
    options.type ? resolveRuleType(options.type, '--type') : null,
    options.suffix ? 'domain-suffix' : null,
    options.exact ? 'domain-exact' : null,
    options.keyword ? 'domain-keyword' : null,
    options.ipv4Cidr ? 'ipv4-cidr' : null,
    options.ipv6Cidr ? 'ipv6-cidr' : null,
    options.country ? 'geo-country' : null,
    options.region ? 'geo-region' : null,
  ].filter(Boolean);

  const uniqueTypes = [...new Set(explicitTypes)];
  if (uniqueTypes.length > 1) {
    throw new Error(`规则类型冲突，请只保留一种类型选项。可选值：${[...SUPPORTED_RULE_TYPES].join(', ')}`);
  }

  return uniqueTypes[0] || 'domain-suffix';
}

function createRuleDefinition(value, options = {}) {
  const type = resolveRuleTypeOption(options);
  const normalizedValue = normalizeRuleValue(type, value, `规则 ${value}`);
  return {
    type,
    value: normalizedValue,
  };
}

function getRuleIdentity(rule) {
  if (!rule) {
    return '';
  }

  if (typeof rule === 'string') {
    return formatRuleLabel({
      type: 'domain-suffix',
      value: normalizeRuleValue('domain-suffix', rule, '规则'),
    }) || '';
  }

  if (rule.domain != null) {
    return formatRuleLabel({
      type: 'domain-suffix',
      value: normalizeRuleValue('domain-suffix', rule.domain, '规则'),
    }) || '';
  }

  return formatRuleLabel(rule) || '';
}

function formatRuleSummary(rule) {
  const identity = getRuleIdentity(rule);
  const label = identity || '未知规则';
  const normalizedRule = typeof rule === 'string'
    ? { type: 'domain-suffix', value: rule }
    : rule.domain != null
      ? { type: 'domain-suffix', value: rule.domain, action: rule.action, upstreams: rule.upstreams }
      : rule;

  const action = normalizedRule.action === 'direct' ? '直连 / 走系统路由' : (normalizedRule.upstreams || []).length
    ? `指定出口节点: ${(normalizedRule.upstreams || []).join(', ')}`
    : '所有可用出口节点';

  return `${label} -> ${action}`;
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
      draftConfig.rules.push({
        ...createRuleDefinition(firstRuleAnswer),
        action: 'proxy',
        upstreams: [],
      });
    }

    const addUpstreamAnswer = (await rl.question('现在是否添加第一个出口节点？（y/N）： ')).trim().toLowerCase();
    if (addUpstreamAnswer === 'y') {
      const upstreamName = normalizeUpstreamName((await rl.question('出口节点名称： ')).trim());
      const upstreamUrl = ensureValidUrl((await rl.question('出口节点 URL： ')).trim());
      const upstreamWeight = Number.parseInt((await rl.question('权重（默认 1）： ')).trim() || '1', 10);
      draftConfig.upstreams.push({
        name: upstreamName,
        url: upstreamUrl,
        weight: Number.isFinite(upstreamWeight) && upstreamWeight > 0 ? upstreamWeight : 1,
        enabled: true,
      });

      const defaultRouteAnswer = (await rl.question('未命中规则的流量是否默认也走这个出口节点？（y/N）： ')).trim().toLowerCase();
      if (defaultRouteAnswer === 'y') {
        draftConfig.default_route = {
          action: 'proxy',
          upstreams: [upstreamName],
        };
      }
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
    console.log('- 添加规则：roo add openai.com --via residential-01');
    console.log('- 添加出口节点：roo upstream add residential-01 socks5://user:pass@host:1080');
    console.log('- 设置默认出口：roo default via vpn-default');
    console.log(`- 打开面板：http://127.0.0.1:${settings.dashboardPort}`);
    console.log(`- 浏览器代理地址：127.0.0.1:${settings.localPort}`);
  } finally {
    rl.close();
  }
}

program
  .name('roo')
  .description('Roo 链式代理编排 CLI')
  .version('1.0.0');

program
  .command('init')
  .description('引导式初始化 Roo 配置')
  .action(async () => {
    await runInitWizard();
  });

program
  .command('up')
  .description('启动 Roo 并托管到 pm2')
  .action(async () => {
    const existing = await tryDashboard('/status');
    if (existing && existing.running) {
      printRuntimeSummary(existing);
      return;
    }

    await pm2StartOrRestart();
    const status = await waitForServiceState(true, 15_000);
    if (!status) {
      throw new Error('Roo 未能在预期时间内启动，请执行 roo logs 或 pm2 logs roo 排查。');
    }

    console.log('Roo 已启动。');
    printRuntimeSummary(status);
  });

program
  .command('down')
  .description('停止 Roo')
  .action(async () => {
    const settings = getRuntimeSettings();
    const stoppedPids = await stopForegroundRoo(settings);
    let deletedByPm2 = false;

    if (await commandExists('pm2', ['-v'])) {
      deletedByPm2 = await pm2DeleteRoo();
    }

    const stopped = await waitForServiceState(false, 10_000);
    if (!stopped) {
      throw new Error('Roo 停止超时，请检查是否有残留进程仍占用端口。');
    }

    if (!stoppedPids.length && !deletedByPm2) {
      console.log('Roo 当前没有运行中的实例。');
      return;
    }

    console.log('Roo 已停止。');
  });

program
  .command('restart')
  .description('重启 Roo')
  .action(async () => {
    const settings = getRuntimeSettings();
    await stopForegroundRoo(settings);
    if (await commandExists('pm2', ['-v'])) {
      await pm2DeleteRoo();
    }

    const stopped = await waitForServiceState(false, 10_000);
    if (!stopped) {
      throw new Error('Roo 重启前未能完全停止，请先执行 roo down。');
    }

    await pm2StartOrRestart();
    const status = await waitForServiceState(true, 15_000);
    if (!status) {
      throw new Error('Roo 重启后未能恢复，请执行 roo logs 或 pm2 logs roo 排查。');
    }

    console.log('Roo 已重启。');
    printRuntimeSummary(status);
  });

program
  .command('ps')
  .description('用简洁方式查看 Roo 运行状态')
  .action(async () => {
    const status = await tryDashboard('/status');
    if (!status) {
      const settings = getRuntimeSettings();
      console.log('Roo 未运行');
      console.log(`代理: 127.0.0.1:${settings.localPort}`);
      console.log(`面板: 127.0.0.1:${settings.dashboardPort}`);
      return;
    }

    printRuntimeSummary(status);
  });

program
  .command('ip')
  .description('通过 Roo 代理查看当前出口 IP')
  .action(async () => {
    const { stdout } = await proxyCurl('https://checkip.amazonaws.com');
    console.log(stdout.trim());
  });

program
  .command('check [url]')
  .description('通过 Roo 代理请求一个 URL，便于快速验证链路')
  .action(async (url = 'https://checkip.amazonaws.com') => {
    const { stdout } = await proxyCurl(url);
    process.stdout.write(stdout);
    if (!stdout.endsWith('\n')) {
      process.stdout.write('\n');
    }
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
  .description('列出所有规则')
  .action(async () => {
    const config = await loadCurrentConfig();
    printList(
      (config.rules || []).map(formatRuleSummary),
      '当前没有任何规则。你可以先执行 roo add openai.com --via residential-01 添加一条。',
    );
  });

program
  .command('add <value>')
  .option('--type <type>', `规则类型，可选：${[...SUPPORTED_RULE_TYPES].join(', ')}`)
  .option('--suffix', '按域名后缀匹配')
  .option('--exact', '按精确域名匹配')
  .option('--keyword', '按域名关键词匹配')
  .option('--ipv4-cidr', '按 IPv4 网段匹配')
  .option('--ipv6-cidr', '按 IPv6 网段匹配')
  .option('--country', '按国家代码匹配，例如 US')
  .option('--region', '按国家-地区代码匹配，例如 US-CA')
  .option('--via <upstreams>', '指定命中这条规则时使用哪些出口节点，多个名称用逗号分隔')
  .option('--direct', '命中这条规则时直连 / 走系统路由')
  .description('添加规则')
  .action(async (value, options) => {
    const ruleDefinition = createRuleDefinition(value, options);
    const ruleIdentity = formatRuleLabel(ruleDefinition);

    await mutateConfig(`已添加规则：${ruleIdentity}`, (config) => {
      const existingRules = new Set((config.rules || []).map(getRuleIdentity));
      if (existingRules.has(ruleIdentity)) {
        throw new Error(`规则 ${ruleIdentity} 已存在，无需重复添加。`);
      }

      if (options.direct && options.via) {
        throw new Error('--direct 和 --via 不能同时使用。');
      }

      const upstreams = options.via ? parseUpstreamList(options.via) : [];
      ensureRuleUpstreamsExist(config, upstreams);

      config.rules = [
        ...(config.rules || []),
        {
          ...ruleDefinition,
          action: options.direct ? 'direct' : 'proxy',
          upstreams,
        },
      ];
      return config;
    });
  });

program
  .command('remove <value>')
  .option('--type <type>', `规则类型，可选：${[...SUPPORTED_RULE_TYPES].join(', ')}`)
  .option('--suffix', '按域名后缀删除')
  .option('--exact', '按精确域名删除')
  .option('--keyword', '按域名关键词删除')
  .option('--ipv4-cidr', '按 IPv4 网段删除')
  .option('--ipv6-cidr', '按 IPv6 网段删除')
  .option('--country', '按国家代码删除')
  .option('--region', '按国家-地区代码删除')
  .description('删除规则')
  .action(async (value, options) => {
    const ruleIdentity = formatRuleLabel(createRuleDefinition(value, options));
    await mutateConfig(`已删除规则：${ruleIdentity}`, (config) => {
      if (!(config.rules || []).some((item) => getRuleIdentity(item) === ruleIdentity)) {
        throw new Error(`规则 ${ruleIdentity} 不存在。`);
      }
      config.rules = (config.rules || []).filter((item) => getRuleIdentity(item) !== ruleIdentity);
      return config;
    });
  });

const defaultRoute = program.command('default').description('管理未命中规则时的默认出口');

defaultRoute
  .command('show')
  .description('查看默认出口设置')
  .action(async () => {
    const config = await loadCurrentConfig();
    printJson(config.default_route || { action: 'direct', upstreams: [] });
  });

defaultRoute
  .command('direct')
  .description('将未命中规则的流量设置为直连 / 走系统路由')
  .action(async () => {
    await mutateConfig('已将默认出口设置为直连 / 走系统路由', (config) => {
      config.default_route = {
        action: 'direct',
        upstreams: [],
      };
      return config;
    });
  });

defaultRoute
  .command('via <upstreams...>')
  .description('将未命中规则的流量设置为走指定出口节点')
  .action(async (upstreams) => {
    const normalizedUpstreams = parseUpstreamList(upstreams.join(','));
    if (!normalizedUpstreams.length) {
      throw new Error('请至少提供一个出口节点名称。');
    }

    await mutateConfig(`已更新默认出口：${normalizedUpstreams.join(', ')}`, (config) => {
      ensureRuleUpstreamsExist(config, normalizedUpstreams);
      config.default_route = {
        action: 'proxy',
        upstreams: normalizedUpstreams,
      };
      return config;
    });
  });

const upstream = program.command('upstream').description('管理出口节点');

upstream
  .command('list')
  .description('列出所有出口节点及健康状态')
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
  .description('添加出口节点')
  .action(async (name, url, options) => {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw new Error('出口节点名称不能为空。');
    }

    const normalizedUrl = ensureValidUrl(url);
    const weight = Number.parseInt(options.weight, 10);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('权重必须是大于 0 的整数。');
    }

    await mutateConfig(`已添加出口节点：${normalizedName}`, (config) => {
      if ((config.upstreams || []).some((item) => item.name === normalizedName)) {
        throw new Error(`出口节点 ${normalizedName} 已存在。`);
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
  .description('删除出口节点')
  .action(async (name) => {
    await mutateConfig(`已删除出口节点：${name}`, (config) => {
      const exists = (config.upstreams || []).some((item) => item.name === name);
      if (!exists) {
        throw new Error(`出口节点 ${name} 不存在。`);
      }
      config.upstreams = (config.upstreams || []).filter((item) => item.name !== name);
      return config;
    });
  });

upstream
  .command('enable <name>')
  .description('启用出口节点')
  .action(async (name) => {
    await mutateConfig(`已启用出口节点：${name}`, (config) => {
      const item = (config.upstreams || []).find((entry) => entry.name === name);
      if (!item) {
        throw new Error(`出口节点 ${name} 不存在。`);
      }
      item.enabled = true;
      return config;
    });
  });

upstream
  .command('disable <name>')
  .description('禁用出口节点')
  .action(async (name) => {
    await mutateConfig(`已禁用出口节点：${name}`, (config) => {
      const item = (config.upstreams || []).find((entry) => entry.name === name);
      if (!item) {
        throw new Error(`出口节点 ${name} 不存在。`);
      }
      item.enabled = false;
      return config;
    });
  });

upstream
  .command('set-weight <name> <n>')
  .description('设置出口节点权重')
  .action(async (name, n) => {
    const weight = Number.parseInt(n, 10);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('权重必须是大于 0 的整数。');
    }

    await mutateConfig(`已更新出口节点权重：${name} -> ${weight}`, (config) => {
      const item = (config.upstreams || []).find((entry) => entry.name === name);
      if (!item) {
        throw new Error(`出口节点 ${name} 不存在。`);
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

const systemProxy = program.command('system-proxy').description('管理 macOS 系统代理接管');

systemProxy
  .command('status')
  .description('查看系统代理接管状态')
  .action(async () => {
    const status = await getSystemProxyStatus(getRuntimeSettings());
    console.log(formatSystemProxySummary(status));
    console.log('');
    printJson(status);
  });

systemProxy
  .command('enable')
  .description('让 macOS 系统代理指向 Roo 本地入口')
  .action(async () => {
    const status = await enableSystemProxy(getRuntimeSettings());
    console.log('系统代理已切换到 Roo 本地入口。');
    console.log(formatSystemProxySummary(status));
  });

systemProxy
  .command('disable')
  .description('关闭 Roo 对系统代理的接管')
  .action(async () => {
    const status = await disableSystemProxy(getRuntimeSettings());
    console.log('系统代理接管已关闭。');
    console.log(formatSystemProxySummary(status));
  });

systemProxy
  .command('restore')
  .description('恢复接管前保存的系统代理快照')
  .action(async () => {
    const status = await restoreSystemProxy(getRuntimeSettings());
    console.log('系统代理已恢复到接管前状态。');
    console.log(formatSystemProxySummary(status));
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
