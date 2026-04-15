const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SUPPORTED_PROXY_KEYS = ['web', 'secureweb', 'socksfirewall'];
const PROXY_LABELS = {
  web: 'HTTP',
  secureweb: 'HTTPS',
  socksfirewall: 'SOCKS',
};

function getSnapshotPath(settings) {
  return path.join(settings.dataDir, 'system-proxy-state.json');
}

async function runNetworksetup(args) {
  return execFileAsync('networksetup', args, { timeout: 10_000, maxBuffer: 1024 * 256 });
}

async function listNetworkServices() {
  const { stdout } = await runNetworksetup(['-listallnetworkservices']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('An asterisk'))
    .map((line) => line.replace(/^\*\s*/, ''));
}

function parseNetworkServiceOrder(rawOutput) {
  const lines = String(rawOutput || '').split('\n');
  const ordered = [];

  for (let index = 0; index < lines.length; index += 1) {
    const titleLine = lines[index].trim();
    const titleMatch = titleLine.match(/^\((\d+)\)\s+(.+)$/);
    if (!titleMatch) {
      continue;
    }

    const rawName = titleMatch[2].trim();
    const disabled = rawName.startsWith('*');
    const service = rawName.replace(/^\*\s*/, '').trim();

    let device = '';
    for (let next = index + 1; next < lines.length; next += 1) {
      const detailLine = lines[next].trim();
      if (!detailLine) {
        break;
      }
      const deviceMatch = detailLine.match(/Device:\s*([^\)]+)/);
      if (deviceMatch) {
        device = deviceMatch[1].trim();
      }
    }

    ordered.push({ service, device, disabled });
  }

  return ordered;
}

async function listNetworkServiceOrder() {
  const { stdout } = await runNetworksetup(['-listnetworkserviceorder']);
  return parseNetworkServiceOrder(stdout);
}

async function getDefaultRouteInterface() {
  try {
    const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'], { timeout: 10_000, maxBuffer: 1024 * 64 });
    const line = stdout
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.startsWith('interface:'));
    if (!line) {
      return '';
    }
    return line.split(':')[1].trim();
  } catch (error) {
    return '';
  }
}

async function getProxyInfo(service, key) {
  const { stdout } = await runNetworksetup([`-get${key}proxy`, service]);
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const info = { host: '', port: '', enabled: false, authenticated: false, raw: stdout.trim() };
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const normalizedKey = String(rawKey || '').trim().toLowerCase();
    if (normalizedKey === 'server') info.host = value;
    if (normalizedKey === 'port') info.port = value;
    if (normalizedKey === 'enabled') info.enabled = /^yes$/i.test(value);
    if (normalizedKey === 'authenticated proxy enabled') info.authenticated = /^yes$/i.test(value);
  }
  return info;
}

async function readServiceState(service) {
  const entries = await Promise.all(SUPPORTED_PROXY_KEYS.map(async (key) => [key, await getProxyInfo(service, key)]));
  return Object.fromEntries(entries);
}

async function detectPrimaryService(preferred) {
  const services = await listNetworkServices();
  if (!services.length) {
    throw new Error('未找到可用的 macOS 网络服务');
  }

  const defaultInterface = await getDefaultRouteInterface();
  const ordered = await listNetworkServiceOrder();
  const findServiceMeta = (serviceName) => ordered.find((item) => item.service === serviceName) || null;

  if (preferred && services.includes(preferred)) {
    const matched = findServiceMeta(preferred);
    return {
      service: preferred,
      device: matched?.device || '',
      defaultInterface,
      source: 'preferred',
      services: ordered.filter((item) => services.includes(item.service)),
    };
  }

  if (defaultInterface) {
    const active = ordered.find((item) => !item.disabled && item.device === defaultInterface && services.includes(item.service));
    if (active) {
      return {
        service: active.service,
        device: active.device,
        defaultInterface,
        source: 'default-route',
        services: ordered.filter((item) => services.includes(item.service)),
      };
    }
  }

  const fallbackService = services.find((name) => /wi-?fi/i.test(name))
    || services.find((name) => /thunderbolt/i.test(name))
    || services[0];
  const fallbackMeta = findServiceMeta(fallbackService);

  return {
    service: fallbackService,
    device: fallbackMeta?.device || '',
    defaultInterface,
    source: 'fallback',
    services: ordered.filter((item) => services.includes(item.service)),
  };
}

async function readSnapshot(settings) {
  const filePath = getSnapshotPath(settings);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

async function writeSnapshot(settings, payload) {
  const filePath = getSnapshotPath(settings);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return filePath;
}

async function clearSnapshot(settings) {
  const filePath = getSnapshotPath(settings);
  await fs.rm(filePath, { force: true });
}

async function applyProxyState(service, key, state) {
  const host = String(state.host || '').trim();
  const port = String(state.port || '').trim();
  if (state.enabled && host && port) {
    await runNetworksetup([`-set${key}proxy`, service, host, port]);
    await runNetworksetup([`-set${key}proxystate`, service, 'on']);
  } else {
    await runNetworksetup([`-set${key}proxystate`, service, 'off']);
  }
}

async function getSystemProxyStatus(settings, preferredService) {
  const selected = await detectPrimaryService(preferredService || settings.networkServiceName);
  const service = selected.service;
  const current = await readServiceState(service);
  const snapshot = await readSnapshot(settings);
  const localPort = String(settings.localPort);
  const managed = SUPPORTED_PROXY_KEYS.every((key) => {
    const item = current[key];
    return item && item.enabled && item.host === '127.0.0.1' && item.port === localPort;
  });

  return {
    platform: process.platform,
    supported: process.platform === 'darwin',
    service,
    device: selected.device,
    selectSource: selected.source,
    defaultInterface: selected.defaultInterface,
    serviceOrder: selected.services,
    managed,
    current,
    snapshot,
    localEndpoint: `127.0.0.1:${settings.localPort}`,
  };
}

function ensureDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('系统代理接管当前仅支持 macOS');
  }
}

async function enableSystemProxy(settings, options = {}) {
  ensureDarwin();
  const selected = await detectPrimaryService(options.service || settings.networkServiceName);
  const service = selected.service;
  const status = await getSystemProxyStatus(settings, service);
  if (!status.managed) {
    await writeSnapshot(settings, {
      service,
      savedAt: new Date().toISOString(),
      current: status.current,
    });
  }

  for (const key of SUPPORTED_PROXY_KEYS) {
    await runNetworksetup([`-set${key}proxy`, service, '127.0.0.1', String(settings.localPort)]);
    await runNetworksetup([`-set${key}proxystate`, service, 'on']);
  }

  return getSystemProxyStatus(settings, service);
}

async function restoreSystemProxy(settings, options = {}) {
  ensureDarwin();
  const snapshot = await readSnapshot(settings);
  const service = options.service || snapshot?.service || settings.networkServiceName;
  if (!service) {
    throw new Error('没有可恢复的系统代理快照');
  }

  const targetState = snapshot?.current || Object.fromEntries(SUPPORTED_PROXY_KEYS.map((key) => [key, { enabled: false, host: '', port: '' }]));
  for (const key of SUPPORTED_PROXY_KEYS) {
    await applyProxyState(service, key, targetState[key] || { enabled: false, host: '', port: '' });
  }

  if (snapshot) {
    await clearSnapshot(settings);
  }

  return getSystemProxyStatus(settings, service);
}

async function disableSystemProxy(settings, options = {}) {
  ensureDarwin();
  const snapshot = await readSnapshot(settings);
  if (snapshot) {
    return restoreSystemProxy(settings, options);
  }

  const selected = await detectPrimaryService(options.service || settings.networkServiceName);
  const service = selected.service;
  for (const key of SUPPORTED_PROXY_KEYS) {
    await runNetworksetup([`-set${key}proxystate`, service, 'off']);
  }
  return getSystemProxyStatus(settings, service);
}

function formatSystemProxySummary(status) {
  const lines = [];
  lines.push(`网络服务: ${status.service}`);
  lines.push(`Roo 本地入口: ${status.localEndpoint}`);
  lines.push(`系统代理接管: ${status.managed ? '已启用' : '未启用'}`);
  for (const key of SUPPORTED_PROXY_KEYS) {
    const item = status.current[key];
    const label = PROXY_LABELS[key] || key;
    const value = item && item.enabled ? `${item.host}:${item.port}` : '关闭';
    lines.push(`${label}: ${value}`);
  }
  if (status.snapshot) {
    lines.push(`已保存恢复快照: ${status.snapshot.savedAt}`);
  }
  return lines.join('\n');
}

module.exports = {
  PROXY_LABELS,
  SUPPORTED_PROXY_KEYS,
  disableSystemProxy,
  enableSystemProxy,
  formatSystemProxySummary,
  getSnapshotPath,
  getSystemProxyStatus,
  readSnapshot,
  restoreSystemProxy,
};
