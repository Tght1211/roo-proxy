#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getSettings, loadEnv, fetchRemoteConfig, readConfigCache } = require('../server/config');

const execFileAsync = promisify(execFile);

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
    return fail('.env 配置', '未找到 .env 文件', '请先复制 .env.example 为 .env，并填写 GIST_ID 与 GITHUB_TOKEN。');
  }

  const missingKeys = [];
  if (!settings.gistId) {
    missingKeys.push('GIST_ID');
  }
  if (!settings.githubToken) {
    missingKeys.push('GITHUB_TOKEN');
  }

  if (missingKeys.length) {
    return fail('.env 配置', `以下字段为空：${missingKeys.join(', ')}`, '请补全这些字段后再运行服务。');
  }

  return ok('.env 配置', '.env 存在且关键字段已填写');
}

async function checkGist(settings) {
  try {
    const { fileName, config } = await fetchRemoteConfig(settings);
    return ok('Gist 可达性', `Gist 访问正常，配置文件 ${fileName}，共 ${config.rules.length} 条规则、${config.upstreams.length} 个 upstream`);
  } catch (error) {
    return fail('Gist 可达性', error.message, '请检查 GIST_ID、GITHUB_TOKEN、网络连接与仓库权限。');
  }
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
  return warn('本地代理端口', `127.0.0.1:${settings.localPort} 当前不可连接`, '如果你还没有启动 Roo，可先执行 npm run start 或 node server/index.js。');
}

async function checkRandomUpstream(settings) {
  let config;
  try {
    ({ config } = await fetchRemoteConfig(settings));
  } catch (error) {
    config = await readConfigCache(settings);
  }

  const enabled = (config.upstreams || []).filter((item) => item.enabled !== false);
  if (!enabled.length) {
    return warn('upstream 连通性', '当前没有可用的 enabled upstream', '请先通过 roo upstream add 添加上游代理。');
  }

  const selected = enabled[Math.floor(Math.random() * enabled.length)];
  try {
    const parsed = new URL(selected.url);
    const port = Number(parsed.port) || (parsed.protocol.startsWith('http') ? 80 : 1080);
    const result = await probeTcp(parsed.hostname, port, 4000);
    if (result.success) {
      return ok('upstream 连通性', `随机检测 ${selected.name} 成功，可连接到 ${parsed.hostname}:${port}`);
    }
    return warn('upstream 连通性', `随机检测 ${selected.name} 失败：${result.error.message}`, '请检查 upstream 地址、端口、用户名密码和网络连通性。');
  } catch (error) {
    return fail('upstream 连通性', `upstream ${selected.name} 配置无效：${error.message}`, '请使用 roo upstream list / roo show 检查配置格式。');
  }
}

async function runHealthcheck() {
  loadEnv();
  const settings = getSettings();
  const results = [];

  results.push(await checkNodeVersion());
  results.push(await checkPm2());
  results.push(await checkEnv(settings));

  if (settings.gistId && settings.githubToken) {
    results.push(await checkGist(settings));
  } else {
    results.push(warn('Gist 可达性', '因 GIST_ID 或 GITHUB_TOKEN 为空，已跳过 Gist 检查', '补全 .env 后可再次执行 roo doctor。'));
  }

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
