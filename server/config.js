const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_CACHE_PATH = path.join(DATA_DIR, 'config-cache.json');
const DEFAULT_CONFIG_FILE_NAME = 'roo-config.json';
const SUPPORTED_STRATEGIES = new Set(['round-robin', 'random', 'weighted']);
const SUPPORTED_PROTOCOLS = new Set(['http:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

let envLoaded = false;

function loadEnv() {
  if (envLoaded) {
    return;
  }

  dotenv.config({ path: path.join(ROOT_DIR, '.env') });
  envLoaded = true;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSettings() {
  loadEnv();

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
  };
}

function getDefaultConfig() {
  return {
    balance_strategy: 'round-robin',
    upstreams: [],
    rules: [],
  };
}

function normalizeRule(rule) {
  return String(rule || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
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

  const seenRules = new Set();
  const rules = Array.isArray(input.rules)
    ? input.rules
        .map(normalizeRule)
        .filter(Boolean)
        .filter((rule) => {
          if (seenRules.has(rule)) {
            return false;
          }

          seenRules.add(rule);
          return true;
        })
    : [];

  return {
    balance_strategy: balanceStrategy,
    upstreams,
    rules,
  };
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
  return Boolean(settings.gistId && settings.githubToken);
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

async function writeConfigCache(config, settings = getSettings()) {
  await fs.mkdir(settings.dataDir, { recursive: true });
  await fs.writeFile(settings.configCachePath, JSON.stringify(config, null, 2), 'utf8');
}

async function readConfigCache(settings = getSettings()) {
  try {
    const content = await fs.readFile(settings.configCachePath, 'utf8');
    return normalizeConfig(JSON.parse(content));
  } catch (error) {
    return getDefaultConfig();
  }
}

async function updateRemoteConfig(mutator, settings = getSettings()) {
  const { gistPayload, fileName, config } = await fetchRemoteConfig(settings);
  const draft = JSON.parse(JSON.stringify(config));
  const nextConfig = normalizeConfig(await mutator(draft));

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

class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.settings = options.settings || getSettings();
    this.currentConfig = getDefaultConfig();
    this.timer = null;
  }

  async loadInitialConfig() {
    try {
      const { config } = await fetchRemoteConfig(this.settings);
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

  async reloadConfig(trigger = 'manual') {
    const { config } = await fetchRemoteConfig(this.settings);
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
  fetchRemoteConfig,
  fetchGistPayload,
  getDefaultConfig,
  getSettings,
  loadEnv,
  normalizeConfig,
  normalizeRule,
  isRemoteConfigEnabled,
  readConfigCache,
  updateRemoteConfig,
  writeConfigCache,
};
