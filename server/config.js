const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const dotenv = require('dotenv');
const ipaddr = require('ipaddr.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_CACHE_PATH = path.join(DATA_DIR, 'config-cache.json');
const DEFAULT_CONFIG_FILE_NAME = 'roo-config.json';
const DEFAULT_LOCAL_CONFIG_RELATIVE_PATH = path.join('data', 'roo-config.json');
const SUPPORTED_CONFIG_SOURCES = new Set(['gist', 'local']);
const SUPPORTED_STRATEGIES = new Set(['round-robin', 'random', 'weighted']);
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const SUPPORTED_RULE_TYPES = new Set([
  'domain-suffix',
  'domain-exact',
  'domain-keyword',
  'ipv4-cidr',
  'ipv6-cidr',
  'geo-country',
  'geo-region',
]);
const RULE_TYPE_ALIASES = new Map([
  ['domain', 'domain-suffix'],
  ['suffix', 'domain-suffix'],
  ['domain-suffix', 'domain-suffix'],
  ['exact', 'domain-exact'],
  ['domain-exact', 'domain-exact'],
  ['keyword', 'domain-keyword'],
  ['domain-keyword', 'domain-keyword'],
  ['ipv4', 'ipv4-cidr'],
  ['ipv4-cidr', 'ipv4-cidr'],
  ['ipv6', 'ipv6-cidr'],
  ['ipv6-cidr', 'ipv6-cidr'],
  ['country', 'geo-country'],
  ['geo-country', 'geo-country'],
  ['region', 'geo-region'],
  ['geo-region', 'geo-region'],
]);

let envLoaded = false;

function loadEnv() {
  if (envLoaded) {
    return;
  }

  dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: true });
  envLoaded = true;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveConfigSource(value, fallbackSettings = process.env) {
  const normalized = String(value || '').trim().toLowerCase();
  if (SUPPORTED_CONFIG_SOURCES.has(normalized)) {
    return normalized;
  }

  if ((fallbackSettings.GIST_ID || '').trim() && (fallbackSettings.GITHUB_TOKEN || '').trim()) {
    return 'gist';
  }

  return 'local';
}

function resolveLocalConfigPath(value) {
  const configuredPath = String(value || DEFAULT_LOCAL_CONFIG_RELATIVE_PATH).trim() || DEFAULT_LOCAL_CONFIG_RELATIVE_PATH;
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.join(ROOT_DIR, configuredPath);
}

function getSettings() {
  loadEnv();

  const configSource = resolveConfigSource(process.env.CONFIG_SOURCE, process.env);

  return {
    rootDir: ROOT_DIR,
    dataDir: DATA_DIR,
    logsDir: path.join(ROOT_DIR, 'logs'),
    statsFilePath: path.join(ROOT_DIR, 'stats.json'),
    configCachePath: CONFIG_CACHE_PATH,
    localPort: parseInteger(process.env.LOCAL_PORT, 7890),
    logLevel: process.env.LOG_LEVEL || 'info',
    logRetainDays: parseInteger(process.env.LOG_RETAIN_DAYS, 7),
    gistId: (process.env.GIST_ID || '').trim(),
    githubToken: (process.env.GITHUB_TOKEN || '').trim(),
    configRefreshIntervalMinutes: parseInteger(process.env.CONFIG_REFRESH_INTERVAL, 5),
    dashboardPort: parseInteger(process.env.DASHBOARD_PORT, 7891),
    configSource,
    localConfigPath: resolveLocalConfigPath(process.env.LOCAL_CONFIG_PATH),
  };
}

function getConfigMeta(settings = getSettings()) {
  return {
    source: settings.configSource,
    localConfigPath: settings.localConfigPath,
    gistId: settings.gistId || null,
  };
}

function getDefaultConfig() {
  return {
    balance_strategy: 'round-robin',
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    upstreams: [],
    rules: [],
  };
}

function normalizeDomain(rule) {
  return String(rule || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
}

function normalizeKeyword(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeCountryCode(value, label) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`${label} 必须是 2 位国家代码，例如 US、SG、JP`);
  }

  return normalized;
}

function normalizeRegionCode(value, label) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/_/g, '-');

  if (!/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(normalized)) {
    throw new Error(`${label} 必须使用国家-地区代码，例如 US-CA、CN-11`);
  }

  return normalized;
}

function normalizeCidr(value, expectedKind, label) {
  const rawValue = String(value || '').trim();
  let parsed;
  try {
    parsed = ipaddr.parseCIDR(rawValue);
  } catch (error) {
    throw new Error(`${label} 不是合法的 CIDR 网段`);
  }

  const [address, prefixLength] = parsed;
  const kind = address.kind();
  if (kind !== expectedKind) {
    throw new Error(`${label} 必须是 ${expectedKind === 'ipv4' ? 'IPv4' : 'IPv6'} 网段`);
  }

  return `${address.toNormalizedString()}/${prefixLength}`;
}

function resolveRuleType(type, label) {
  const normalized = String(type || '').trim().toLowerCase();
  const ruleType = RULE_TYPE_ALIASES.get(normalized);
  if (!ruleType || !SUPPORTED_RULE_TYPES.has(ruleType)) {
    throw new Error(`${label} 使用了不支持的规则类型：${type}`);
  }

  return ruleType;
}

function normalizeRuleValue(type, value, label) {
  if (type === 'domain-suffix' || type === 'domain-exact') {
    const normalized = normalizeDomain(value);
    if (!normalized || !normalized.includes('.')) {
      throw new Error(`${label} 的域名格式无效`);
    }
    return normalized;
  }

  if (type === 'domain-keyword') {
    const normalized = normalizeKeyword(value);
    if (!normalized) {
      throw new Error(`${label} 的关键词不能为空`);
    }
    return normalized;
  }

  if (type === 'ipv4-cidr') {
    return normalizeCidr(value, 'ipv4', label);
  }

  if (type === 'ipv6-cidr') {
    return normalizeCidr(value, 'ipv6', label);
  }

  if (type === 'geo-country') {
    return normalizeCountryCode(value, label);
  }

  if (type === 'geo-region') {
    return normalizeRegionCode(value, label);
  }

  throw new Error(`${label} 使用了不支持的规则类型：${type}`);
}

function formatRuleLabel(rule) {
  if (!rule || !rule.type || !rule.value) {
    return null;
  }

  return `${rule.type}:${rule.value}`;
}

function normalizeUpstreamNames(names, upstreamNameSet, label) {
  if (names == null) {
    return [];
  }

  if (!Array.isArray(names)) {
    throw new Error(`${label} 的 upstreams 必须是数组`);
  }

  const seenNames = new Set();
  return names
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((name) => {
      if (!upstreamNameSet.has(name)) {
        throw new Error(`${label} 引用了不存在的 upstream：${name}`);
      }

      if (seenNames.has(name)) {
        return false;
      }

      seenNames.add(name);
      return true;
    });
}

function normalizeRoute(route, upstreamNameSet, label) {
  if (route == null) {
    return {
      action: 'direct',
      upstreams: [],
    };
  }

  if (typeof route === 'string') {
    const normalizedRoute = route.trim().toLowerCase();
    if (normalizedRoute === 'direct') {
      return {
        action: 'direct',
        upstreams: [],
      };
    }

    throw new Error(`${label} 配置无效，仅支持字符串值 direct`);
  }

  if (typeof route !== 'object') {
    throw new Error(`${label} 配置无效`);
  }

  const action = String(route.action || (Array.isArray(route.upstreams) && route.upstreams.length ? 'proxy' : 'direct'))
    .trim()
    .toLowerCase();

  if (!['direct', 'proxy'].includes(action)) {
    throw new Error(`${label} 的 action 仅支持 direct 或 proxy`);
  }

  const upstreams = normalizeUpstreamNames(route.upstreams, upstreamNameSet, label);

  if (action === 'direct' && upstreams.length) {
    throw new Error(`${label} 使用 direct 时不能再配置 upstreams`);
  }

  return {
    action,
    upstreams,
  };
}

function normalizeRule(rule, index, upstreamNameSet) {
  if (typeof rule === 'string') {
    const value = normalizeRuleValue('domain-suffix', rule, `第 ${index + 1} 条规则`);
    if (!value) {
      return null;
    }

    return {
      type: 'domain-suffix',
      value,
      action: 'proxy',
      upstreams: [],
    };
  }

  if (!rule || typeof rule !== 'object') {
    throw new Error(`第 ${index + 1} 条规则配置无效`);
  }

  const label = `第 ${index + 1} 条规则`;
  const type = rule.domain != null
    ? 'domain-suffix'
    : resolveRuleType(rule.type || 'domain-suffix', label);
  const rawValue = rule.domain != null ? rule.domain : rule.value;

  if (rawValue == null || String(rawValue).trim() === '') {
    throw new Error(`${label} 缺少 value`);
  }

  const value = normalizeRuleValue(type, rawValue, label);
  const normalizedRoute = normalizeRoute(rule, upstreamNameSet, `规则 ${formatRuleLabel({ type, value })}`);
  return {
    type,
    value,
    action: normalizedRoute.action,
    upstreams: normalizedRoute.upstreams,
  };
}

function normalizeUpstream(upstream, index = 0) {
  if (!upstream || typeof upstream !== 'object') {
    throw new Error(`第 ${index + 1} 个 upstream 配置无效`);
  }

  const name = String(upstream.name || '').trim();
  const url = String(upstream.url || '').trim();
  const weight = Number.parseInt(upstream.weight, 10);
  const enabled = upstream.enabled !== false;

  if (!name) {
    throw new Error(`第 ${index + 1} 个 upstream 缺少名称 name`);
  }

  if (!url) {
    throw new Error(`upstream ${name} 缺少 url`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw new Error(`upstream ${name} 的 url 格式不正确`);
  }

  if (!SUPPORTED_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error(`upstream ${name} 使用了不支持的协议：${parsedUrl.protocol}`);
  }

  return {
    name,
    url,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
    enabled,
  };
}

function normalizeConfig(rawConfig) {
  const input = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const balanceStrategy = SUPPORTED_STRATEGIES.has(input.balance_strategy)
    ? input.balance_strategy
    : 'round-robin';

  const upstreamNames = new Set();
  const upstreams = Array.isArray(input.upstreams)
    ? input.upstreams
        .map((item, index) => normalizeUpstream(item, index))
        .filter((item) => {
          if (upstreamNames.has(item.name)) {
            throw new Error(`存在重复的 upstream 名称：${item.name}`);
          }

          upstreamNames.add(item.name);
          return true;
        })
    : [];

  const defaultRoute = normalizeRoute(input.default_route, upstreamNames, 'default_route');
  const seenRules = new Set();
  const rules = Array.isArray(input.rules)
    ? input.rules
        .map((item, index) => normalizeRule(item, index, upstreamNames))
        .filter(Boolean)
        .filter((rule) => {
          const key = formatRuleLabel(rule);
          if (seenRules.has(key)) {
            return false;
          }

          seenRules.add(key);
          return true;
        })
    : [];

  return {
    balance_strategy: balanceStrategy,
    default_route: defaultRoute,
    upstreams,
    rules,
  };
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function getHeaders(settings) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'roo-proxy',
  };

  if (settings.githubToken) {
    headers.Authorization = `Bearer ${settings.githubToken}`;
  }

  return headers;
}

function ensureRemoteConfigEnabled(settings) {
  if (!settings.gistId) {
    throw new Error('未配置 GIST_ID，请先在 .env 中填写 GitHub Private Gist ID');
  }

  if (!settings.githubToken) {
    throw new Error('未配置 GITHUB_TOKEN，请先在 .env 中填写 GitHub Token');
  }
}

function isRemoteConfigEnabled(settings = getSettings()) {
  return settings.configSource === 'gist' && Boolean(settings.gistId && settings.githubToken);
}

async function fetchGistPayload(settings = getSettings()) {
  ensureRemoteConfigEnabled(settings);

  const response = await fetch(`https://api.github.com/gists/${settings.gistId}`, {
    headers: getHeaders(settings),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('无法找到指定的 Gist，请检查 GIST_ID 是否正确且 Token 是否有权限');
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('访问 Gist 失败，GitHub Token 可能无效、过期或权限不足');
    }

    throw new Error(`访问 Gist 失败，HTTP 状态码：${response.status}`);
  }

  return response.json();
}

function extractConfigFile(gistPayload) {
  const files = gistPayload && gistPayload.files ? Object.values(gistPayload.files) : [];
  const preferredFile = files.find((file) => file.filename === DEFAULT_CONFIG_FILE_NAME);

  if (preferredFile && preferredFile.content) {
    return preferredFile;
  }

  const jsonFile = files.find((file) => file.filename && file.filename.endsWith('.json') && file.content);
  if (jsonFile) {
    return jsonFile;
  }

  const parseableFile = files.find((file) => {
    if (!file.content) {
      return false;
    }

    try {
      JSON.parse(file.content);
      return true;
    } catch (error) {
      return false;
    }
  });

  return parseableFile || null;
}

async function fetchRemoteConfig(settings = getSettings()) {
  const gistPayload = await fetchGistPayload(settings);
  const configFile = extractConfigFile(gistPayload);

  if (!configFile || !configFile.content) {
    return {
      fileName: DEFAULT_CONFIG_FILE_NAME,
      config: getDefaultConfig(),
      gistPayload,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(configFile.content);
  } catch (error) {
    throw new Error(`Gist 中的配置文件 ${configFile.filename} 不是合法 JSON`);
  }

  return {
    fileName: configFile.filename,
    config: normalizeConfig(parsed),
    gistPayload,
  };
}

async function setRemoteConfig(config, settings = getSettings()) {
  const { gistPayload, fileName } = await fetchRemoteConfig(settings);
  const nextConfig = normalizeConfig(config);

  const response = await fetch(`https://api.github.com/gists/${settings.gistId}`, {
    method: 'PATCH',
    headers: {
      ...getHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [fileName || DEFAULT_CONFIG_FILE_NAME]: {
          content: JSON.stringify(nextConfig, null, 2),
        },
      },
      description: gistPayload.description || 'Roo proxy config',
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('更新 Gist 失败，GitHub Token 权限不足或已失效');
    }

    throw new Error(`更新 Gist 失败，HTTP 状态码：${response.status}`);
  }

  return nextConfig;
}

async function updateRemoteConfig(mutator, settings = getSettings()) {
  const { config } = await fetchRemoteConfig(settings);
  const draft = JSON.parse(JSON.stringify(config));
  const nextConfig = normalizeConfig(await mutator(draft));
  return setRemoteConfig(nextConfig, settings);
}

async function ensureLocalConfigFile(settings = getSettings(), seedConfig = getDefaultConfig()) {
  try {
    await fs.access(settings.localConfigPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }

    await writeJsonFile(settings.localConfigPath, normalizeConfig(seedConfig));
  }

  return settings.localConfigPath;
}

async function readLocalConfig(settings = getSettings()) {
  await ensureLocalConfigFile(settings);
  const parsed = await readJsonFile(settings.localConfigPath);
  return normalizeConfig(parsed);
}

async function writeLocalConfig(config, settings = getSettings()) {
  const nextConfig = normalizeConfig(config);
  await writeJsonFile(settings.localConfigPath, nextConfig);
  return nextConfig;
}

async function updateLocalConfig(mutator, settings = getSettings()) {
  const current = await readLocalConfig(settings);
  const draft = JSON.parse(JSON.stringify(current));
  const nextConfig = normalizeConfig(await mutator(draft));
  await writeLocalConfig(nextConfig, settings);
  return nextConfig;
}

async function readActiveConfig(settings = getSettings()) {
  if (settings.configSource === 'local') {
    return readLocalConfig(settings);
  }

  const { config } = await fetchRemoteConfig(settings);
  return config;
}

async function updateActiveConfig(mutator, settings = getSettings()) {
  if (settings.configSource === 'local') {
    return updateLocalConfig(mutator, settings);
  }

  return updateRemoteConfig(mutator, settings);
}

async function initializeActiveConfig(config, settings = getSettings()) {
  if (settings.configSource === 'local') {
    return writeLocalConfig(config, settings);
  }

  return setRemoteConfig(config, settings);
}

async function writeConfigCache(config, settings = getSettings()) {
  await writeJsonFile(settings.configCachePath, normalizeConfig(config));
}

async function readConfigCache(settings = getSettings()) {
  try {
    return normalizeConfig(await readJsonFile(settings.configCachePath));
  } catch (error) {
    return getDefaultConfig();
  }
}

class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.settings = options.settings || getSettings();
    this.currentConfig = getDefaultConfig();
    this.timer = null;
  }

  async loadInitialConfig() {
    try {
      const config = await readActiveConfig(this.settings);
      this.currentConfig = config;
      await writeConfigCache(config, this.settings);
      this.emit('updated', config, 'startup');
      return config;
    } catch (error) {
      const fallbackConfig = await readConfigCache(this.settings);
      this.currentConfig = fallbackConfig;
      this.emit('warning', error);
      return fallbackConfig;
    }
  }

  getConfig() {
    return this.currentConfig;
  }

  getMeta() {
    return getConfigMeta(this.settings);
  }

  async reloadConfig(trigger = 'manual') {
    const config = await readActiveConfig(this.settings);
    this.currentConfig = config;
    await writeConfigCache(config, this.settings);
    this.emit('updated', config, trigger);
    return config;
  }

  startAutoRefresh(onError) {
    if (!isRemoteConfigEnabled(this.settings)) {
      return false;
    }

    const intervalMs = Math.max(this.settings.configRefreshIntervalMinutes, 1) * 60 * 1000;
    this.stopAutoRefresh();
    this.timer = setInterval(async () => {
      try {
        await this.reloadConfig('timer');
      } catch (error) {
        this.emit('warning', error);
        if (typeof onError === 'function') {
          onError(error);
        }
      }
    }, intervalMs);
    return true;
  }

  stopAutoRefresh() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  ConfigManager,
  DEFAULT_CONFIG_FILE_NAME,
  DEFAULT_LOCAL_CONFIG_RELATIVE_PATH,
  ensureLocalConfigFile,
  fetchRemoteConfig,
  fetchGistPayload,
  getConfigMeta,
  getDefaultConfig,
  getSettings,
  initializeActiveConfig,
  isRemoteConfigEnabled,
  loadEnv,
  normalizeConfig,
  normalizeDomain,
  normalizeRuleValue,
  normalizeRule,
  resolveRuleType,
  SUPPORTED_RULE_TYPES,
  formatRuleLabel,
  readActiveConfig,
  readConfigCache,
  readLocalConfig,
  resolveConfigSource,
  resolveLocalConfigPath,
  setRemoteConfig,
  updateActiveConfig,
  updateRemoteConfig,
  writeConfigCache,
  writeLocalConfig,
};
