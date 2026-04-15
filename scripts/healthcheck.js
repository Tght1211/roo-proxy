#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getSettings, loadEnv, readActiveConfig, readConfigCache } = require('../server/config');
const { ChainProxyManager } = require('../server/chain');

const execFileAsync = promisify(execFile);

async function fetchIpByCurl(args) {
  const { stdout } = await execFileAsync('curl', args, { timeout: 10_000, maxBuffer: 1024 * 64 });
  return stdout.trim() || null;
}

function getEnvProxyUrl() {
  return process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
}

async function resolveProbeProxyUrl(upstream, envProxy, chainManager) {
  if (upstream.via) {
    if (!chainManager) {
      throw new Error('via 链路初始化失败');
    }
    return {
      probeMode: 'via-chain',
      probeProxyUrl: await chainManager.getChainUrl(upstream.via, upstream.url),
    };
  }

  if (envProxy) {
    if (!chainManager) {
      throw new Error('环境代理链路初始化失败');
    }
    return {
      probeMode: 'env-proxy',
      probeProxyUrl: await chainManager.getChainUrl(envProxy, upstream.url),
    };
  }

  return {
    probeMode: 'direct',
    probeProxyUrl: upstream.url,
  };
}

function ok(name, detail, suggestion = '') {
  return { name, status: 'ok', detail, suggestion };
}

function warn(name, detail, suggestion = '') {
  return { name, status: 'warn', detail, suggestion };
}

function fail(name, detail, suggestion = '') {
  return { name, status: 'fail', detail, suggestion };
}

function compareNodeVersion(current, minimum) {
  const currentParts = current.replace(/^v/, '').split('.').map((item) => Number.parseInt(item, 10) || 0);
  const minimumParts = minimum.split('.').map((item) => Number.parseInt(item, 10) || 0);
  const maxLength = Math.max(currentParts.length, minimumParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = currentParts[index] || 0;
    const right = minimumParts[index] || 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }

  return 0;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkNodeVersion() {
  const current = process.version;
  const minimum = '18.0.0';
  if (compareNodeVersion(current, minimum) >= 0) {
    return ok('Node.js 版本', `当前版本 ${current}，满足要求`);
  }
  return fail('Node.js 版本', `当前版本 ${current}，低于最低要求 v${minimum}`, '请先升级 Node.js 到 18 或更高版本。');
}

async function checkPm2() {
  try {
    const { stdout } = await execFileAsync('pm2', ['-v']);
    return ok('pm2', `已安装 pm2，版本 ${stdout.trim()}`);
  } catch (error) {
    return fail('pm2', '未检测到 pm2', '请执行 npm install -g pm2 安装后重试。');
  }
}

async function checkEnv(settings) {
  const envPath = path.join(settings.rootDir, '.env');
  const envExists = await exists(envPath);
  if (!envExists) {
    return fail('.env 配置', '未找到 .env 文件', '请先执行 roo init 或复制 .env.example 为 .env。');
  }

  if (settings.configSource === 'gist') {
    const missingKeys = [];
    if (!settings.gistId) {
      missingKeys.push('GIST_ID');
    }
    if (!settings.githubToken) {
      missingKeys.push('GITHUB_TOKEN');
    }

    if (missingKeys.length) {
      return fail('.env 配置', `当前为 gist 模式，但以下字段为空：${missingKeys.join(', ')}`, '请补全这些字段，或改用 CONFIG_SOURCE=local。');
    }

    return ok('.env 配置', '.env 存在，当前为 gist 模式且关键字段已填写');
  }

  return ok('.env 配置', `.env 存在，当前为 ${settings.configSource} 模式`);
}

async function checkConfigBackend(settings) {
  if (settings.configSource === 'gist') {
    try {
      const config = await readActiveConfig(settings);
      return ok('配置后端', `gist 模式可用，当前共 ${config.rules.length} 条规则、${config.upstreams.length} 个 upstream`);
    } catch (error) {
      return fail('配置后端', error.message, '请检查 GIST_ID、GITHUB_TOKEN、网络连通性和 Gist 权限。');
    }
  }

  const localExists = await exists(settings.localConfigPath);
  if (!localExists) {
    return fail('配置后端', `local 模式下未找到配置文件：${settings.localConfigPath}`, '请先执行 roo init，或手动创建本地配置文件。');
  }

  try {
    const config = await readActiveConfig(settings);
    return ok('配置后端', `local 模式可用，配置文件 ${settings.localConfigPath}，当前共 ${config.rules.length} 条规则、${config.upstreams.length} 个 upstream`);
  } catch (error) {
    return fail('配置后端', `本地配置文件读取失败：${error.message}`, '请检查本地 JSON 配置格式是否正确。');
  }
}

async function checkRoutingProfile(settings) {
  let config;
  try {
    config = await readActiveConfig(settings);
  } catch (error) {
    config = await readConfigCache(settings);
  }

  const defaultRoute = config.default_route && typeof config.default_route === 'object'
    ? config.default_route
    : { action: 'direct', upstreams: [] };

  if (defaultRoute.action === 'proxy' && Array.isArray(defaultRoute.upstreams) && defaultRoute.upstreams.length) {
    return ok('默认出口', `未命中规则时将走 upstream：${defaultRoute.upstreams.join(', ')}`);
  }

  return ok('默认出口', '未命中规则时直连 / 走系统路由');
}

async function probeTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (success, error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ success, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, new Error('连接超时')));
    socket.once('error', (error) => finish(false, error));
  });
}

async function checkLocalProxyPort(settings) {
  const result = await probeTcp('127.0.0.1', settings.localPort, 2000);
  if (result.success) {
    return ok('本地代理端口', `127.0.0.1:${settings.localPort} 端口可连接，服务可能正在运行`);
  }
  return warn('本地代理端口', `127.0.0.1:${settings.localPort} 当前不可连接`, '如果你还没有启动 Roo，可先执行 npm run start、npm run serve 或 roo init。');
}

async function checkRandomUpstream(settings) {
  let config;
  try {
    config = await readActiveConfig(settings);
  } catch (error) {
    config = await readConfigCache(settings);
  }

  const enabled = (config.upstreams || []).filter((item) => item.enabled !== false);
  if (!enabled.length) {
    return warn('upstream 连通性', '当前没有可用的 enabled upstream', '请先通过 roo upstream add 添加上游代理。');
  }

  const selected = enabled[Math.floor(Math.random() * enabled.length)];
  let chainManager = null;

  try {
    chainManager = new ChainProxyManager();
    const envProxy = getEnvProxyUrl();
    const { probeMode, probeProxyUrl } = await resolveProbeProxyUrl(selected, envProxy, chainManager);
    const ip = await fetchIpByCurl(['-sS', '--max-time', '8', '--proxy', probeProxyUrl, 'https://api.ip.sb/ip']);

    if (!ip) {
      throw new Error('返回为空');
    }

    if (probeMode === 'via-chain') {
      return ok('upstream 连通性', `随机检测 ${selected.name} 成功（via 链路），出口 IP：${ip}`);
    }

    if (probeMode === 'env-proxy') {
      return ok('upstream 连通性', `随机检测 ${selected.name} 成功（环境代理链路），出口 IP：${ip}`);
    }

    return ok('upstream 连通性', `随机检测 ${selected.name} 成功（直连），出口 IP：${ip}`);
  } catch (error) {
    return warn('upstream 连通性', `随机检测 ${selected.name} 失败：${error.message}`, '请检查 upstream 地址、端口、用户名密码，以及 via/环境代理链路是否可用。');
  } finally {
    if (chainManager) {
      await chainManager.stopAll().catch(() => {});
    }
  }
}

async function runHealthcheck() {
  loadEnv();
  const settings = getSettings();
  const results = [];

  results.push(await checkNodeVersion());
  results.push(await checkPm2());
  results.push(await checkEnv(settings));
  results.push(await checkConfigBackend(settings));
  results.push(await checkRoutingProfile(settings));
  results.push(await checkLocalProxyPort(settings));
  results.push(await checkRandomUpstream(settings));

  return results;
}

async function printHealthcheck(results) {
  console.log('Roo 环境自检结果');
  console.log('====================');
  for (const item of results) {
    const icon = item.status === 'ok' ? '✅' : item.status === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${item.name}`);
    console.log(`   说明：${item.detail}`);
    if (item.suggestion) {
      console.log(`   建议：${item.suggestion}`);
    }
  }

  const failCount = results.filter((item) => item.status === 'fail').length;
  const warnCount = results.filter((item) => item.status === 'warn').length;
  console.log('--------------------');
  console.log(`总结：${failCount} 个失败，${warnCount} 个警告，${results.length} 个检查项。`);
}

if (require.main === module) {
  runHealthcheck()
    .then(printHealthcheck)
    .catch((error) => {
      console.error(`Roo 自检失败：${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  runHealthcheck,
  printHealthcheck,
};
