const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readRecentLogs } = require('../server/logger');
const { updateActiveConfig } = require('../server/config');
const {
  disableSystemProxy,
  enableSystemProxy,
  getSystemProxyStatus,
  restoreSystemProxy,
} = require('../server/system-proxy');

const execFileAsync = promisify(execFile);

async function fetchIpByCurl(args) {
  const { stdout } = await execFileAsync('curl', args, { timeout: 10_000, maxBuffer: 1024 * 64 });
  return stdout.trim() || null;
}


function getEnvFilePath() {
  return path.join(__dirname, '..', '.env');
}

function parseEnvContent(content) {
  const entries = {};
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    entries[key] = value;
  }
  return entries;
}

async function readEnvSettings() {
  const envPath = getEnvFilePath();
  const content = await fs.readFile(envPath, 'utf8').catch(() => '');
  const parsed = parseEnvContent(content);
  return {
    envPath,
    content,
    values: {
      HTTP_PROXY: parsed.HTTP_PROXY || '',
      HTTPS_PROXY: parsed.HTTPS_PROXY || '',
      ALL_PROXY: parsed.ALL_PROXY || '',
      NO_PROXY: parsed.NO_PROXY || '',
    },
  };
}

function upsertEnvValue(content, key, value) {
  const lines = String(content || '').split('\n');
  const nextLine = value ? `${key}=${value}` : null;
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      replaced = true;
      return nextLine;
    }
    return line;
  }).filter((line) => line != null);

  if (!replaced && nextLine) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== '') {
      nextLines.push('');
    }
    nextLines.push(nextLine);
  }

  return nextLines.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function writeEnvSettings(nextValues) {
  const { envPath, content } = await readEnvSettings();
  let nextContent = content;
  for (const [key, value] of Object.entries(nextValues)) {
    nextContent = upsertEnvValue(nextContent, key, String(value || '').trim());
  }
  if (nextContent && !nextContent.endsWith('\n')) {
    nextContent += '\n';
  }
  await fs.writeFile(envPath, nextContent, 'utf8');
  return readEnvSettings();
}

async function lookupIpMeta(ip) {
  if (!ip) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('curl', ['-s', `https://ipwho.is/${ip}`], {
      timeout: 10_000,
      maxBuffer: 1024 * 256,
    });
    const data = JSON.parse(stdout);
    if (!data || data.success === false) {
      return null;
    }
    return {
      ip: data.ip || ip,
      country: data.country || null,
      region: data.region || null,
      city: data.city || null,
      isp: data.connection && (data.connection.isp || data.connection.org) || null,
      org: data.connection && data.connection.org || null,
    };
  } catch (error) {
    return null;
  }
}

function formatIpMeta(meta) {
  if (!meta || !meta.ip) {
    return '获取失败';
  }
  const parts = [meta.ip];
  const location = [meta.country, meta.region, meta.city].filter(Boolean).join(' / ');
  if (location) {
    parts.push(location);
  }
  if (meta.isp) {
    parts.push(`ISP: ${meta.isp}`);
  }
  return parts.join(' · ');
}

function applyEnvToProcess(values = {}) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = String(values[key] || '').trim();
    if (value) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

async function readEffectiveEnvSettings() {
  const envFile = await readEnvSettings();
  return {
    file: envFile.values,
    effective: {
      HTTP_PROXY: process.env.HTTP_PROXY || '',
      HTTPS_PROXY: process.env.HTTPS_PROXY || '',
      ALL_PROXY: process.env.ALL_PROXY || '',
      NO_PROXY: process.env.NO_PROXY || '',
    },
  };
}

function formatProbeError(error) {
  if (!error) {
    return '探测失败';
  }

  const stderr = String(error.stderr || '').trim();
  if (stderr) {
    const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines[lines.length - 1] || stderr;
  }

  if (error.killed) {
    return '探测超时';
  }

  return String(error.message || error);
}

function formatUpstreamFailureHint(check) {
  const detail = check?.error || '连接失败';
  if (!check) {
    return `请检查出口节点地址、账号密码、协议和链式代理配置。详情：${detail}`;
  }

  if (check.probeMode === 'via-chain') {
    return `${check.name} 依赖前置跳板链路，请检查前置跳板与出口节点的联合链路。详情：${detail}`;
  }

  if (check.probeMode === 'env-proxy') {
    return `${check.name} 当前需依赖 Roo 前置链路访问，请检查环境代理与出口节点联合链路。详情：${detail}`;
  }

  return `${check.name} 当前直连探测失败；如果该出口节点需要前置链路，请检查环境代理设置。详情：${detail}`;
}

async function probeUpstreamConnectivity(upstream, chainManager, envProxy) {
  let probeProxyUrl = upstream.url;
  let probeMode = 'direct';

  if (upstream.via && chainManager && typeof chainManager.getChainUrl === 'function') {
    try {
      probeProxyUrl = await chainManager.getChainUrl(upstream.via, upstream.url);
      probeMode = 'via-chain';
    } catch (error) {
      return {
        name: upstream.name,
        healthy: upstream.healthy !== false,
        viaEnabled: true,
        probeMode: 'via-chain',
        ok: false,
        ip: null,
        meta: null,
        error: `via 链路不可用：${formatProbeError(error)}`,
      };
    }
  } else if (envProxy && chainManager && typeof chainManager.getChainUrl === 'function') {
    try {
      probeProxyUrl = await chainManager.getChainUrl(envProxy, upstream.url);
      probeMode = 'env-proxy';
    } catch (error) {
      return {
        name: upstream.name,
        healthy: upstream.healthy !== false,
        viaEnabled: false,
        probeMode: 'env-proxy',
        ok: false,
        ip: null,
        meta: null,
        error: `环境代理链路探测失败：${formatProbeError(error)}`,
      };
    }
  }

  try {
    const ip = await fetchIpByCurl(['-sS', '--max-time', '8', '--proxy', probeProxyUrl, 'https://api.ip.sb/ip']);
    if (!ip) {
      throw new Error('返回为空');
    }

    const meta = await lookupIpMeta(ip);
    return {
      name: upstream.name,
      healthy: upstream.healthy !== false,
      viaEnabled: Boolean(upstream.via),
      probeMode,
      ok: true,
      ip,
      meta,
      error: null,
    };
  } catch (error) {
    const prefix = probeMode === 'via-chain'
      ? 'via 链路探测失败：'
      : probeMode === 'env-proxy'
        ? '环境代理链路探测失败：'
        : '出口节点直连探测失败：';
    return {
      name: upstream.name,
      healthy: upstream.healthy !== false,
      viaEnabled: Boolean(upstream.via),
      probeMode,
      ok: false,
      ip: null,
      meta: null,
      error: prefix + formatProbeError(error),
    };
  }
}

async function probeRelayProxy(envProxy) {
  if (!envProxy) {
    return { configured: false, ok: null, ip: null, error: null, latencyMs: null };
  }
  const t0 = Date.now();
  try {
    const ip = await fetchIpByCurl(['-sS', '--max-time', '8', '--proxy', envProxy, 'https://api.ip.sb/ip']);
    if (!ip) throw new Error('返回为空');
    return { configured: true, ok: true, ip, error: null, latencyMs: Date.now() - t0 };
  } catch (error) {
    return { configured: true, ok: false, ip: null, error: formatProbeError(error), latencyMs: Date.now() - t0 };
  }
}

async function getNetworkDiagnostics(localProxyPort, balancer, chainManager) {
  const envProxy = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;

  const [directIpResult, envProxyIpResult, rooRouteIpResult, relayProbe] = await Promise.all([
    Promise.allSettled([fetchIpByCurl(['-s', '--noproxy', '*', 'https://api.ip.sb/ip'])]).then(([r]) => r),
    Promise.allSettled([envProxy ? fetchIpByCurl(['-s', 'https://api.ip.sb/ip']) : Promise.resolve(null)]).then(([r]) => r),
    Promise.allSettled([fetchIpByCurl(['-s', '--proxy', `http://127.0.0.1:${localProxyPort}`, 'https://api.ip.sb/ip'])]).then(([r]) => r),
    probeRelayProxy(envProxy),
  ]);

  const directIp = directIpResult.status === 'fulfilled' ? directIpResult.value : null;
  const envProxyIp = envProxyIpResult.status === 'fulfilled' ? envProxyIpResult.value : null;
  const rooRouteIp = rooRouteIpResult.status === 'fulfilled' ? rooRouteIpResult.value : null;

  const enabledUpstreams = balancer && typeof balancer.getEnabledUpstreams === 'function'
    ? balancer.getEnabledUpstreams()
    : [];
  const checkTargets = enabledUpstreams.slice(0, 6);
  const upstreamChecks = await Promise.all(checkTargets.map((upstream) => probeUpstreamConnectivity(upstream, chainManager, envProxy)));
  const upstreamCheckMap = new Map(upstreamChecks.map((item) => [item.name, item]));
  const upstreamCheckSummary = {
    totalEnabled: enabledUpstreams.length,
    checked: upstreamChecks.length,
    ok: upstreamChecks.filter((item) => item.ok).length,
    failed: upstreamChecks.filter((item) => !item.ok).length,
    skipped: Math.max(enabledUpstreams.length - upstreamChecks.length, 0),
  };

  let rooProxyIp = rooRouteIp;
  let rooProbeMode = 'roo-route';
  let rooProbeUpstream = null;

  const healthyUpstreams = balancer && typeof balancer.getHealthyUpstreams === 'function'
    ? balancer.getHealthyUpstreams()
    : [];

  if (healthyUpstreams.length) {
    const selected = healthyUpstreams[0];
    const selectedCheck = upstreamCheckMap.get(selected.name);
    if (selectedCheck && selectedCheck.ok && selectedCheck.ip) {
      rooProxyIp = selectedCheck.ip;
      rooProbeMode = 'upstream-probe';
      rooProbeUpstream = selected.name;
    } else if (selectedCheck && !selectedCheck.ok) {
      rooProbeMode = 'upstream-probe-failed';
      rooProbeUpstream = selected.name;
    }
  }

  const [directMeta, envProxyMeta] = await Promise.all([
    lookupIpMeta(directIp),
    lookupIpMeta(envProxyIp),
  ]);

  let rooProxyMeta = null;
  if (rooProbeMode === 'upstream-probe' && rooProbeUpstream && upstreamCheckMap.get(rooProbeUpstream)?.meta) {
    rooProxyMeta = upstreamCheckMap.get(rooProbeUpstream).meta;
  } else {
    rooProxyMeta = await lookupIpMeta(rooProxyIp);
  }

  // 探测结果元数据
  const relayMeta = relayProbe.ok && relayProbe.ip ? await lookupIpMeta(relayProbe.ip) : null;

  let routeHint;
  // 优先级最高：如果前置代理自己挂了，出口失败很可能是被它拖累的，提示归因到前置
  if (relayProbe.configured && relayProbe.ok === false && upstreamCheckSummary.failed > 0) {
    routeHint = `前置代理 ${envProxy} 自身探测失败（${relayProbe.error}），${upstreamCheckSummary.failed} 个出口节点异常很可能是被前置代理拖累——请先恢复前置代理，再回来重新检查节点。`;
  } else if (relayProbe.configured && relayProbe.ok === false) {
    routeHint = `前置代理 ${envProxy} 自身探测失败：${relayProbe.error}。这会导致所有需要走前置的出口节点都无法访问。`;
  } else if (upstreamCheckSummary.failed > 0) {
    const firstFailed = upstreamChecks.find((item) => !item.ok);
    routeHint = `检测到 ${upstreamCheckSummary.failed} 个出口节点探测失败。${formatUpstreamFailureHint(firstFailed)}`;
  } else if (rooProbeMode === 'upstream-probe') {
    routeHint = `经 Roo 出口优先展示出口节点探测结果（节点: ${rooProbeUpstream}）。若与按规则结果不一致，请检查该测试域名是否命中代理规则。`;
  } else if (envProxy) {
    routeHint = '当前 Roo 进程存在环境代理；如果系统还有 TUN/VPN，则“本机直连出口”反映的是系统默认路由出口。';
  } else {
    routeHint = '当前未设置环境代理；“本机直连出口”反映的是系统默认路由出口（含可能存在的 TUN/VPN）。';
  }

  return {
    envProxy,
    httpProxy: process.env.HTTP_PROXY || null,
    httpsProxy: process.env.HTTPS_PROXY || null,
    allProxy: process.env.ALL_PROXY || null,
    noProxy: process.env.NO_PROXY || null,
    directIp,
    envProxyIp,
    rooRouteIp,
    rooProxyIp,
    directMeta,
    envProxyMeta,
    rooProxyMeta,
    rooProbeMode,
    rooProbeUpstream,
    routeHint,
    upstreamCheckSummary,
    upstreamChecks,
    relayProbe: { ...relayProbe, meta: relayMeta },
  };
}

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Roo Dashboard</title>
  <style>
    :root{
      /* Cyberpunk palette */
      --bg:#07090f;
      --bg-grid:#0b0f1a;
      --panel:#0f1420;
      --panel-2:#141a28;
      --panel-raised:#1a2132;
      --border:#1f2a3d;
      --border-soft:#172033;
      --text:#e2e8f0;
      --text-2:#94a3b8;
      --text-3:#64748b;
      --cyan:#22d3ee;
      --cyan-dim:#0891b2;
      --cyan-glow:rgba(34,211,238,.55);
      --cyan-soft:rgba(34,211,238,.1);
      --magenta:#f472b6;
      --magenta-dim:#db2777;
      --magenta-glow:rgba(244,114,182,.45);
      --magenta-soft:rgba(244,114,182,.1);
      --yellow:#fde047;
      --yellow-dim:#eab308;
      --yellow-glow:rgba(253,224,71,.4);
      --yellow-soft:rgba(253,224,71,.08);
      --green:#34d399;
      --green-dim:#10b981;
      --green-glow:rgba(52,211,153,.4);
      --green-soft:rgba(52,211,153,.1);
      --red:#f87171;
      --red-dim:#ef4444;
      --red-glow:rgba(248,113,113,.45);
      --red-soft:rgba(248,113,113,.1);
      --purple:#c084fc;
      --purple-soft:rgba(192,132,252,.1);
      --blue:#60a5fa;
      --primary:var(--cyan);
      --amber:var(--yellow);
      --amber-soft:var(--yellow-soft);
      --radius:2px;
      --radius-lg:4px;
      --mono:'JetBrains Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;
      --shadow:0 0 0 1px rgba(34,211,238,.06),0 8px 24px rgba(0,0,0,.35);
      --shadow-lg:0 0 0 1px rgba(34,211,238,.1),0 20px 50px rgba(0,0,0,.5);
    }

    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
      background:var(--bg);color:var(--text);font-size:13.5px;line-height:1.55;
      display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased;
      background-image:
        linear-gradient(rgba(34,211,238,.022) 1px,transparent 1px),
        linear-gradient(90deg,rgba(34,211,238,.022) 1px,transparent 1px),
        radial-gradient(ellipse 80% 60% at 50% -10%,rgba(34,211,238,.08),transparent 70%),
        radial-gradient(ellipse 60% 50% at 100% 100%,rgba(244,114,182,.06),transparent 70%);
      background-size:32px 32px,32px 32px,100% 100%,100% 100%;
      position:relative;
    }
    body::before{
      content:'';position:fixed;inset:0;pointer-events:none;z-index:300;
      background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(0,0,0,.06) 3px 4px);
      mix-blend-mode:multiply;opacity:.35;
    }

    /* ---- Scrollbar ---- */
    ::-webkit-scrollbar{width:8px;height:8px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
    ::-webkit-scrollbar-thumb:hover{background:var(--cyan-dim)}

    /* ---- Topbar ---- */
    .topbar{
      background:linear-gradient(180deg,var(--panel) 0%,var(--panel-2) 100%);
      padding:10px 24px;border-bottom:1px solid var(--border);
      display:flex;align-items:center;gap:20px;flex-shrink:0;
      position:relative;z-index:10;
    }
    .topbar::after{
      content:'';position:absolute;left:0;right:0;bottom:-1px;height:1px;
      background:linear-gradient(90deg,transparent 0%,var(--cyan) 30%,var(--magenta) 70%,transparent 100%);
      opacity:.5;
    }
    .brand{display:flex;align-items:center;gap:12px;padding-right:20px;border-right:1px solid var(--border)}
    .brand-logo{
      width:34px;height:34px;position:relative;
      background:linear-gradient(135deg,var(--cyan) 0%,var(--magenta) 100%);
      clip-path:polygon(20% 0,100% 0,100% 80%,80% 100%,0 100%,0 20%);
      display:flex;align-items:center;justify-content:center;
      color:#07090f;font-weight:900;font-size:16px;font-family:var(--mono);
      box-shadow:0 0 18px var(--cyan-glow);
    }
    .brand-text{font-size:14px;font-weight:800;color:var(--text);letter-spacing:.02em;font-family:var(--mono)}
    .brand-text::before{content:'> ';color:var(--cyan)}
    .brand-sub{font-size:10px;color:var(--cyan);margin-top:1px;letter-spacing:.24em;text-transform:uppercase;font-family:var(--mono)}

    /* ---- Top nav tabs ---- */
    .nav-tabs{display:flex;align-items:stretch;gap:2px;flex:1}
    .nav-tab{
      padding:10px 18px;font-size:12.5px;font-weight:600;color:var(--text-2);
      cursor:pointer;transition:all .15s;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;
      position:relative;border:1px solid transparent;border-bottom:none;background:transparent;
      clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);
      padding:10px 22px;
    }
    .nav-tab:hover{color:var(--cyan);background:var(--cyan-soft)}
    .nav-tab.active{
      color:var(--cyan);background:linear-gradient(180deg,var(--cyan-soft) 0%,transparent 100%);
    }
    .nav-tab.active::after{
      content:'';position:absolute;left:8px;right:8px;bottom:-2px;height:2px;
      background:var(--cyan);box-shadow:0 0 10px var(--cyan-glow);
    }
    .nav-tab .tab-num{color:var(--text-3);font-size:10px;margin-right:6px}
    .nav-tab.active .tab-num{color:var(--magenta)}

    .topbar-right{display:flex;align-items:center;gap:10px;margin-left:auto}
    .topbar-status{
      display:flex;align-items:center;gap:8px;padding:6px 12px;
      background:var(--green-soft);color:var(--green);font-size:11px;font-weight:700;
      font-family:var(--mono);letter-spacing:.1em;text-transform:uppercase;
      border:1px solid var(--green-dim);
      clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);
      padding:6px 16px;
    }
    .topbar-status.danger{background:var(--red-soft);color:var(--red);border-color:var(--red-dim)}
    .topbar-status.warn{background:var(--yellow-soft);color:var(--yellow);border-color:var(--yellow-dim)}
    .pulse{
      width:6px;height:6px;background:currentColor;
      box-shadow:0 0 6px currentColor;animation:pulse 1.6s infinite;
    }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

    /* ---- Main ---- */
    .main{flex:1;display:flex;flex-direction:column;overflow:hidden}
    .content{flex:1;overflow-y:auto;padding:22px 28px 32px;max-width:1360px;width:100%;margin:0 auto}

    /* ---- Pages (tabs) ---- */
    .page{display:none;animation:fadeIn .2s ease}
    .page.active{display:block}
    @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

    /* ---- Sub-nav (CONFIG page anchors) ---- */
    .subnav{
      position:sticky;top:0;z-index:5;
      display:flex;gap:6px;flex-wrap:wrap;align-items:center;
      padding:10px 14px;margin:-22px -14px 18px;
      background:rgba(7,9,15,.92);border-bottom:1px solid var(--border);
      backdrop-filter:blur(8px);
    }
    .subnav-item{
      padding:5px 16px;font-size:11.5px;font-weight:700;color:var(--text-2);
      letter-spacing:.08em;font-family:var(--mono);cursor:pointer;
      border:1px solid var(--border);background:var(--panel-2);
      transition:all .15s;text-decoration:none;
      clip-path:polygon(5px 0,100% 0,calc(100% - 5px) 100%,0 100%);
    }
    .subnav-item:hover{color:var(--cyan);border-color:var(--cyan-dim);background:var(--cyan-soft)}
    .subnav-item.active{color:var(--magenta);border-color:var(--magenta-dim);background:var(--magenta-soft)}
    html{scroll-behavior:smooth}
    #page-config > div[id^="anchor-"]{scroll-margin-top:80px;height:1px}

    /* ---- Section head ---- */
    .section-head{
      display:flex;align-items:center;gap:10px;margin:22px 0 12px;
      color:var(--text-2);font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;font-family:var(--mono);
    }
    .section-head::before{content:'//';color:var(--cyan);opacity:.7}
    .section-head::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--border) 0%,transparent 100%)}
    .section-head:first-child{margin-top:0}

    /* ---- Card ---- */
    .card{
      background:var(--panel);border-radius:var(--radius-lg);padding:18px 20px;
      border:1px solid var(--border);margin-bottom:14px;
      position:relative;
    }
    .card::before{
      content:'';position:absolute;left:-1px;top:-1px;width:20px;height:2px;
      background:var(--cyan);box-shadow:0 0 8px var(--cyan-glow);
    }
    .card::after{
      content:'';position:absolute;right:-1px;bottom:-1px;width:20px;height:2px;
      background:var(--magenta);box-shadow:0 0 8px var(--magenta-glow);
    }
    .card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px;flex-wrap:wrap}
    .card-title{font-size:12.5px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:10px;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono)}
    .card-title .dot{width:3px;height:14px;background:var(--cyan);box-shadow:0 0 6px var(--cyan-glow)}
    .card-subtitle{font-size:12px;color:var(--text-3);margin:-4px 0 14px;line-height:1.6}

    /* ---- Stat cards ---- */
    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
    .stat{
      background:var(--panel);border-radius:var(--radius-lg);padding:16px 18px;
      border:1px solid var(--border);position:relative;overflow:hidden;
    }
    .stat::before{
      content:'';position:absolute;left:0;top:0;bottom:0;width:2px;
      background:linear-gradient(180deg,var(--cyan),transparent);
    }
    .stat-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .stat-label{font-size:10.5px;color:var(--text-3);font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-family:var(--mono)}
    .stat-ico{
      width:28px;height:28px;display:flex;align-items:center;justify-content:center;
      background:var(--cyan-soft);color:var(--cyan);border:1px solid var(--cyan-dim);
    }
    .stat-ico svg{width:14px;height:14px}
    .ico-blue{background:rgba(96,165,250,.1);color:var(--blue);border-color:var(--blue)}
    .ico-green{background:var(--green-soft);color:var(--green);border-color:var(--green-dim)}
    .ico-purple{background:var(--purple-soft);color:var(--purple);border-color:var(--purple)}
    .ico-amber{background:var(--yellow-soft);color:var(--yellow);border-color:var(--yellow-dim)}
    .ico-red{background:var(--red-soft);color:var(--red);border-color:var(--red-dim)}
    .stat-v{
      font-size:26px;font-weight:800;color:var(--text);line-height:1.1;letter-spacing:-.01em;
      font-family:var(--mono);
      text-shadow:0 0 18px rgba(34,211,238,.25);
    }
    .stat-v small{font-size:12px;font-weight:600;color:var(--text-3);margin-left:4px}
    .stat-tip{font-size:11px;color:var(--text-3);margin-top:6px;font-family:var(--mono);letter-spacing:.02em}

    /* ---- Status strip (replaces summary-shell) ---- */
    .status-strip{
      display:flex;align-items:center;gap:14px;flex-wrap:wrap;
      padding:10px 16px;margin-bottom:14px;
      background:linear-gradient(90deg,var(--panel) 0%,var(--panel-2) 100%);
      border:1px solid var(--border);border-radius:var(--radius-lg);
      font-size:12px;font-family:var(--mono);color:var(--text-2);
      position:relative;overflow:hidden;
    }
    .status-strip::before{
      content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
      background:var(--cyan);box-shadow:0 0 10px var(--cyan-glow);
    }
    .status-strip.warn::before{background:var(--yellow);box-shadow:0 0 10px var(--yellow-glow)}
    .status-strip.danger::before{background:var(--red);box-shadow:0 0 10px var(--red-glow)}
    .status-strip.success::before{background:var(--green);box-shadow:0 0 10px var(--green-glow)}
    .status-strip-badge{
      display:inline-flex;align-items:center;gap:6px;padding:3px 10px;
      background:var(--cyan-soft);color:var(--cyan);border:1px solid var(--cyan-dim);
      font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
    }
    .status-strip.warn .status-strip-badge{background:var(--yellow-soft);color:var(--yellow);border-color:var(--yellow-dim)}
    .status-strip.danger .status-strip-badge{background:var(--red-soft);color:var(--red);border-color:var(--red-dim)}
    .status-strip.success .status-strip-badge{background:var(--green-soft);color:var(--green);border-color:var(--green-dim)}
    .status-strip-item{display:flex;align-items:center;gap:6px;font-size:11.5px}
    .status-strip-item strong{color:var(--text);font-weight:600}
    .status-strip-divider{width:1px;height:14px;background:var(--border)}
    .status-strip-actions{margin-left:auto;display:flex;gap:6px}

    /* ---- Table ---- */
    table{width:100%;border-collapse:collapse;font-size:12.5px}
    th{
      text-align:left;padding:9px 12px;color:var(--text-3);font-weight:700;font-size:10.5px;
      border-bottom:1px solid var(--border);background:var(--panel-2);
      letter-spacing:.12em;text-transform:uppercase;font-family:var(--mono);
    }
    td{padding:11px 12px;border-bottom:1px solid var(--border-soft);color:var(--text)}
    tr:last-child td{border-bottom:none}
    tbody tr{transition:background .12s}
    tbody tr:hover td{background:var(--cyan-soft)}

    /* ---- Badges ---- */
    .badge{
      display:inline-flex;align-items:center;gap:4px;padding:2px 8px;
      font-size:10.5px;font-weight:700;white-space:nowrap;font-family:var(--mono);
      letter-spacing:.06em;text-transform:uppercase;
      border:1px solid;background:transparent;
    }
    .badge-green{background:var(--green-soft);color:var(--green);border-color:var(--green-dim)}
    .badge-red{background:var(--red-soft);color:var(--red);border-color:var(--red-dim)}
    .badge-blue{background:rgba(96,165,250,.1);color:var(--blue);border-color:var(--blue)}
    .badge-gray{background:var(--panel-2);color:var(--text-3);border-color:var(--border)}
    .badge-amber{background:var(--yellow-soft);color:var(--yellow);border-color:var(--yellow-dim)}
    .badge-purple{background:var(--purple-soft);color:var(--purple);border-color:var(--purple)}
    .badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 4px currentColor}

    /* ---- Buttons ---- */
    .btn{
      display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid;
      font-size:11.5px;cursor:pointer;transition:all .15s;font-weight:700;font-family:var(--mono);
      letter-spacing:.08em;text-transform:uppercase;background:transparent;
      clip-path:polygon(5px 0,100% 0,calc(100% - 5px) 100%,0 100%);
      padding:7px 16px;
    }
    .btn:disabled{opacity:.35;cursor:not-allowed}
    .btn-primary{background:var(--cyan);color:#07090f;border-color:var(--cyan);box-shadow:0 0 0 transparent}
    .btn-primary:hover:not(:disabled){background:#67e8f9;box-shadow:0 0 16px var(--cyan-glow)}
    .btn-danger{background:transparent;color:var(--red);border-color:var(--red-dim)}
    .btn-danger:hover:not(:disabled){background:var(--red-soft);box-shadow:0 0 12px var(--red-glow)}
    .btn-ghost{background:transparent;color:var(--text-2);border-color:var(--border)}
    .btn-ghost:hover:not(:disabled){color:var(--cyan);border-color:var(--cyan-dim);background:var(--cyan-soft)}
    .btn-sm{padding:4px 12px;font-size:10.5px}
    .btn svg{width:12px;height:12px}

    /* ---- Form ---- */
    .form-group{margin-bottom:12px}
    .form-label{display:block;font-size:10.5px;font-weight:700;color:var(--text-2);margin-bottom:6px;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono)}
    .form-control{
      width:100%;padding:8px 12px;border:1px solid var(--border);
      font-size:12.5px;outline:none;transition:all .15s;
      background:var(--panel-2);color:var(--text);font-family:inherit;
      border-radius:2px;
    }
    .form-control:focus{border-color:var(--cyan);box-shadow:0 0 0 2px var(--cyan-soft)}
    select.form-control{cursor:pointer}

    /* ---- Toggle ---- */
    .toggle{position:relative;width:40px;height:20px;flex-shrink:0}
    .toggle input{opacity:0;width:0;height:0}
    .toggle-slider{
      position:absolute;inset:0;background:var(--panel-2);
      border:1px solid var(--border);cursor:pointer;transition:.2s;
    }
    .toggle-slider::before{
      content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;
      background:var(--text-3);transition:.2s;
    }
    .toggle input:checked+.toggle-slider{background:var(--cyan-soft);border-color:var(--cyan)}
    .toggle input:checked+.toggle-slider::before{background:var(--cyan);box-shadow:0 0 6px var(--cyan-glow);transform:translateX(20px)}

    /* ---- Modal ---- */
    .modal-overlay{
      display:none;position:fixed;inset:0;background:rgba(7,9,15,.8);z-index:100;
      align-items:center;justify-content:center;backdrop-filter:blur(6px);
    }
    .modal-overlay.open{display:flex}
    .modal{
      background:var(--panel);padding:22px;width:520px;max-width:92vw;
      max-height:90vh;overflow-y:auto;
      border:1px solid var(--border);border-radius:var(--radius-lg);
      box-shadow:var(--shadow-lg);position:relative;
    }
    .modal::before{
      content:'';position:absolute;left:-1px;top:-1px;width:24px;height:2px;
      background:var(--cyan);box-shadow:0 0 10px var(--cyan-glow);
    }
    .modal::after{
      content:'';position:absolute;right:-1px;bottom:-1px;width:24px;height:2px;
      background:var(--magenta);box-shadow:0 0 10px var(--magenta-glow);
    }
    .modal-title{
      font-size:13px;font-weight:800;margin-bottom:18px;color:var(--text);
      font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;
      padding-bottom:10px;border-bottom:1px solid var(--border);
    }
    .modal-title::before{content:'// ';color:var(--cyan)}
    .modal-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}

    /* ---- Section ---- */
    .sec-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap}
    .sec-t{font-size:12.5px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:10px;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono)}
    .sec-t .dot{width:3px;height:14px;background:var(--cyan);box-shadow:0 0 6px var(--cyan-glow)}

    /* ---- Settings row ---- */
    .srow{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--border-soft);gap:12px;flex-wrap:wrap}
    .srow:last-child{border-bottom:none}
    .srow:first-child{padding-top:0}
    .skey{font-size:12.5px;font-weight:600;color:var(--text)}
    .sdesc{font-size:11.5px;color:var(--text-3);margin-top:3px}

    /* ---- Toast ---- */
    .toast-container{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:8px;z-index:400}
    .toast{
      padding:10px 16px;font-size:12px;font-weight:600;animation:slideIn .25s ease;
      max-width:360px;display:flex;align-items:center;gap:10px;font-family:var(--mono);
      background:var(--panel);border:1px solid;
      clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);
      padding:10px 22px;
    }
    .toast-success{color:var(--green);border-color:var(--green-dim);box-shadow:0 0 16px var(--green-glow)}
    .toast-error{color:var(--red);border-color:var(--red-dim);box-shadow:0 0 16px var(--red-glow)}
    @keyframes slideIn{from{transform:translateX(80px);opacity:0}to{transform:translateX(0);opacity:1}}

    /* ---- Apply bar ---- */
    .apply-bar{
      background:linear-gradient(180deg,var(--panel-2) 0%,var(--panel) 100%);
      border-top:1px solid var(--border);padding:10px 28px;
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      flex-shrink:0;flex-wrap:wrap;position:relative;transition:all .3s;
    }
    .apply-bar::before{
      content:'';position:absolute;left:0;right:0;top:-1px;height:1px;
      background:linear-gradient(90deg,transparent 0%,var(--cyan) 50%,transparent 100%);opacity:.4;
    }
    .apply-bar.dirty{
      background:linear-gradient(180deg,rgba(253,224,71,.08) 0%,var(--panel) 100%);
      border-top-color:var(--yellow-dim);
    }
    .apply-bar.dirty::before{
      background:linear-gradient(90deg,transparent 0%,var(--yellow) 50%,transparent 100%);
      opacity:.85;
    }
    .apply-bar-text{font-size:11.5px;color:var(--text-3);font-family:var(--mono);flex:1}
    .apply-bar-text strong{color:var(--yellow);font-weight:700}
    .apply-bar-text .unsaved-badge{
      display:inline-flex;align-items:center;gap:5px;padding:2px 8px;margin-right:8px;
      background:var(--yellow-soft);color:var(--yellow);border:1px solid var(--yellow-dim);
      font-weight:700;font-size:10.5px;letter-spacing:.12em;
    }
    .apply-bar-text .unsaved-badge::before{
      content:'';width:6px;height:6px;background:var(--yellow);box-shadow:0 0 6px var(--yellow-glow);
      animation:pulse 1.2s infinite;
    }

    /* APPLY 按钮未保存时：扫光 + 呼吸 halo */
    .btn-primary.has-changes{
      position:relative;overflow:hidden;
      animation:applyBreathe 1.8s ease-in-out infinite;
    }
    @keyframes applyBreathe{
      0%,100%{box-shadow:0 0 0 transparent,0 0 0 transparent}
      50%{box-shadow:0 0 18px var(--cyan-glow),0 0 4px var(--cyan)}
    }
    .btn-primary.has-changes::after{
      content:'';position:absolute;top:0;left:-120%;width:60%;height:100%;
      background:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.85) 50%,transparent 80%);
      animation:applySweep 2.2s linear infinite;
      pointer-events:none;
    }
    @keyframes applySweep{
      0%{left:-120%}
      60%{left:220%}
      100%{left:220%}
    }

    /* ---- KV box ---- */
    .kv{display:grid;grid-template-columns:auto 1fr;gap:8px 20px;font-size:12px}
    .kv dt{color:var(--text-3);font-weight:500;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
    .kv dd{color:var(--text);text-align:right;font-family:var(--mono);font-size:12px}

    /* ---- Diagnostic panels ---- */
    .section-stack{display:grid;gap:14px}
    .diag-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
    .diag-panel{border:1px solid var(--border);background:var(--panel-2);padding:14px 16px;border-radius:var(--radius-lg)}
    .diag-title{font-size:10.5px;color:var(--cyan);margin-bottom:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-family:var(--mono)}
    .diag-title::before{content:'// ';opacity:.7}
    .diag-list{display:grid;gap:8px}
    .diag-block{border:1px solid var(--border);padding:10px 12px;background:var(--panel);border-radius:var(--radius-lg)}
    .diag-block.bad{border-color:var(--red-dim);background:var(--red-soft)}
    .diag-caption{font-size:10.5px;color:var(--text-3);margin-bottom:4px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase}
    .diag-text{font-size:12.5px;color:var(--text);line-height:1.6;word-break:break-all;font-family:var(--mono)}
    .diag-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
    .diag-stat{border:1px solid var(--border);padding:9px 11px;background:var(--panel);border-radius:var(--radius-lg)}
    .diag-stat-label{font-size:9.5px;color:var(--text-3);margin-bottom:4px;font-family:var(--mono);letter-spacing:.1em;text-transform:uppercase}
    .diag-stat-value{font-size:20px;font-weight:800;color:var(--text);font-family:var(--mono);text-shadow:0 0 10px rgba(34,211,238,.2)}
    .diag-note{border:1px solid var(--border);padding:10px 12px;background:var(--panel);font-size:12px;color:var(--text-2);line-height:1.6;border-radius:var(--radius-lg)}
    .diag-note-success{border-color:var(--green-dim);background:var(--green-soft);color:var(--green)}
    .diag-note-warning{border-color:var(--yellow-dim);background:var(--yellow-soft);color:var(--yellow)}
    .diag-note-danger{border-color:var(--red-dim);background:var(--red-soft);color:var(--red)}

    /* ---- Expiry reminder ---- */
    .expiry-list{display:grid;gap:8px}
    .expiry-row{
      display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:10px 12px;border:1px solid var(--border);background:var(--panel-2);border-radius:var(--radius-lg);
    }
    .expiry-row strong{color:var(--text)}

    /* ---- Relay (env proxy) card ---- */
    .relay-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
    .relay-cell{
      display:flex;align-items:stretch;gap:0;
      border:1px solid var(--border);border-radius:var(--radius-lg);
      background:var(--panel-2);transition:border-color .15s;overflow:hidden;
    }
    .relay-cell:focus-within{border-color:var(--cyan);box-shadow:0 0 0 2px var(--cyan-soft)}
    .relay-label{
      display:flex;align-items:center;padding:0 12px;min-width:58px;justify-content:center;
      background:var(--panel);border-right:1px solid var(--border);
      font-size:10px;font-weight:700;color:var(--cyan);letter-spacing:.14em;font-family:var(--mono);
    }
    .relay-input{
      flex:1;border:none;background:transparent;padding:8px 10px;
      font-size:12px;font-family:var(--mono);min-width:0;
    }
    .relay-input:focus{box-shadow:none;border:none}
    @media (max-width:780px){.relay-grid{grid-template-columns:1fr}}

    /* ---- System proxy card ---- */
    .sys-endpoints{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0 14px}
    .sys-row{
      display:flex;align-items:center;gap:10px;padding:10px 12px;
      border:1px solid var(--border);background:var(--panel-2);border-radius:var(--radius-lg);
      position:relative;overflow:hidden;
    }
    .sys-row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--cyan);opacity:.6}
    .sys-row-label{font-size:10px;font-weight:700;color:var(--cyan);letter-spacing:.14em;min-width:44px;font-family:var(--mono)}
    .sys-row code{flex:1;background:transparent;padding:0;color:var(--text);font-size:12px;font-family:var(--mono)}
    .sys-meta{font-size:11.5px;color:var(--text-3);margin-bottom:14px;line-height:1.7;font-family:var(--mono)}
    .sys-meta strong{color:var(--text);font-weight:600}
    .sys-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    @media (max-width:720px){.sys-endpoints{grid-template-columns:1fr}}

    /* ---- Mode switch (traffic_mode) ---- */
    .mode-switch{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
    .mode-btn{
      text-align:left;padding:14px 16px;background:var(--panel-2);
      border:1px solid var(--border);color:var(--text-2);cursor:pointer;transition:all .18s;
      font-family:inherit;position:relative;overflow:hidden;border-radius:var(--radius-lg);
      display:flex;flex-direction:column;gap:4px;
    }
    .mode-btn::before{
      content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
      background:var(--border);transition:all .18s;
    }
    .mode-btn:hover{color:var(--text);border-color:var(--cyan-dim)}
    .mode-btn:hover::before{background:var(--cyan-dim)}
    .mode-btn.active{color:var(--text);border-color:var(--cyan);background:var(--cyan-soft)}
    .mode-btn.active::before{background:var(--cyan);box-shadow:0 0 10px var(--cyan-glow)}
    .mode-btn[data-mode=global].active{border-color:var(--magenta);background:var(--magenta-soft)}
    .mode-btn[data-mode=global].active::before{background:var(--magenta);box-shadow:0 0 10px var(--magenta-glow)}
    .mode-btn[data-mode=direct].active{border-color:var(--yellow-dim);background:var(--yellow-soft)}
    .mode-btn[data-mode=direct].active::before{background:var(--yellow);box-shadow:0 0 10px var(--yellow-glow)}
    .mode-btn-title{font-weight:700;font-size:13px;color:var(--text);letter-spacing:.04em;font-family:var(--mono)}
    .mode-btn-desc{font-size:11.5px;color:var(--text-3);line-height:1.5}
    .mode-btn.active .mode-btn-title{color:var(--cyan)}
    .mode-btn[data-mode=global].active .mode-btn-title{color:var(--magenta)}
    .mode-btn[data-mode=direct].active .mode-btn-title{color:var(--yellow)}
    .mode-hint{font-size:11.5px;color:var(--text-3);margin-top:2px;font-family:var(--mono);letter-spacing:.04em}
    .mode-hint::before{content:'// ';color:var(--cyan);opacity:.7}
    #rulesCard.dimmed{opacity:.55;pointer-events:none;filter:saturate(.3)}
    @media (max-width:780px){.mode-switch{grid-template-columns:1fr}}

    /* ---- Filter bar ---- */
    .filter-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
    .filter-bar .form-control{height:32px;padding:5px 10px;font-size:12px}
    .filter-bar .filter-search{flex:1 1 220px;min-width:200px}
    .filter-bar .filter-select{width:auto;min-width:130px}
    .pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:10px 2px 0;font-size:11.5px;color:var(--text-3);font-family:var(--mono)}
    .pager .btn-sm{padding:3px 10px}
    .pager-meta{margin-right:6px;color:var(--text-3)}

    /* ---- Misc ---- */
    .url-text{font-size:11.5px;font-family:var(--mono);color:var(--text-2);
      max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}
    .empty-tip{text-align:center;padding:40px 20px;color:var(--text-3);font-size:12px;font-family:var(--mono);letter-spacing:.04em}
    .empty-tip::before{content:'⌀ ';color:var(--cyan);opacity:.5}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    code{font-family:var(--mono);font-size:11.5px;background:var(--panel-2);padding:1px 6px;border-radius:2px;color:var(--cyan);border:1px solid var(--border)}

    /* Hide old summary-shell (kept in DOM for JS compat, visually collapsed) */
    .summary-shell{display:none}

    @media (max-width:1100px){
      .stat-grid{grid-template-columns:repeat(2,1fr)}
      .grid-2{grid-template-columns:1fr}
      .diag-grid{grid-template-columns:1fr}
      .diag-stats{grid-template-columns:repeat(2,1fr)}
      .nav-tab{padding:8px 14px;font-size:11.5px}
      .brand{padding-right:12px}
    }
    @media (max-width:780px){
      .brand{display:none}
      .nav-tab{padding:8px 10px}
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand">
      <div class="brand-logo">R</div>
      <div>
        <div class="brand-text">ROO_PROXY</div>
        <div class="brand-sub">v1.4 · neon edition</div>
      </div>
    </div>
    <div class="nav-tabs">
      <div class="nav-tab active" data-page="overview"><span class="tab-num">01</span>CONSOLE</div>
      <div class="nav-tab" data-page="config"><span class="tab-num">02</span>CONFIG</div>
      <div class="nav-tab" data-page="logs"><span class="tab-num">03</span>LOGS</div>
    </div>
    <div class="topbar-right">
      <span class="topbar-status" id="sidebarStatus"><span class="pulse"></span>ONLINE</span>
      <button class="btn btn-ghost btn-sm" id="reloadRulesBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        SYNC
      </button>
    </div>
  </div>

  <div class="main">
    <div class="content">
      <!-- ========== PAGE: CONSOLE (概览) ========== -->
      <div class="page active" id="page-overview">
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-h">
            <div class="stat-label">服务状态</div>
            <div class="stat-ico ico-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
          </div>
          <div class="stat-v" id="ovStatus">-</div>
          <div class="stat-tip" id="ovUptime">-</div>
        </div>
        <div class="stat">
          <div class="stat-h">
            <div class="stat-label">出口节点健康</div>
            <div class="stat-ico ico-purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
          </div>
          <div class="stat-v" id="ovUpstream">-</div>
          <div class="stat-tip" id="ovUpstreamHint">-</div>
        </div>
        <div class="stat">
          <div class="stat-h">
            <div class="stat-label">今日请求</div>
            <div class="stat-ico ico-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div>
          </div>
          <div class="stat-v" id="ovToday">-</div>
          <div class="stat-tip" id="ovTotal">-</div>
        </div>
        <div class="stat">
          <div class="stat-h">
            <div class="stat-label">平均延迟</div>
            <div class="stat-ico ico-amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
          </div>
          <div class="stat-v" id="ovLatency">-<small>ms</small></div>
          <div class="stat-tip" id="ovLatencyHint">-</div>
        </div>
      </div>

      <div class="status-strip" id="ovStatusStrip">
        <span class="status-strip-badge" id="ovStatusBadge">
          <span class="pulse"></span><span id="ovStatusBadgeText">SCAN</span>
        </span>
        <span class="status-strip-item" id="ovStatusTitle"><strong>Scanning pipeline…</strong></span>
        <span class="status-strip-divider"></span>
        <span class="status-strip-item" id="ovStatusDesc">waiting for diagnostics</span>
        <span class="status-strip-actions"><span class="status-strip-item" id="ovStatusMeta"></span></span>
      </div>

      <!-- Legacy summary-shell kept for JS compatibility (hidden via CSS) -->
      <div class="summary-shell neutral" id="ovRunSummary">
        <div class="summary-head"><div>
          <div class="summary-eyebrow">
            <span class="summary-badge neutral" id="ovSummaryBadge"><span class="summary-badge-dot"></span>待检查</span>
            <span class="summary-meta" id="ovSummaryMeta">加载中</span>
          </div>
          <div class="summary-title" id="ovSummaryTitle">正在刷新概览状态</div>
          <div class="summary-desc" id="ovSummaryDesc">仅展示关键状态与异常提示。</div>
          <div class="summary-actions" id="ovSummaryActions"></div>
        </div></div>
      </div>

      <div class="card" id="ovExpiryReminder" style="display:none"></div>

      <div class="card">
        <div class="card-h"><div class="card-title"><span class="dot"></span>NET DIAGNOSTICS</div></div>
        <div id="ovNetDiag"></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>NODE HEALTH</div></div>
          <div id="ovHealthWrap"><div class="empty-tip">加载中...</div></div>
        </div>
        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>SERVICE INFO</div></div>
          <dl class="kv" id="ovInfo"></dl>
        </div>
      </div>
      </div><!-- /page-overview -->

      <!-- ========== PAGE: CONFIG (链式编排 + 分流规则) ========== -->
      <div class="page" id="page-config">

      <div class="subnav">
        <a class="subnav-item" data-anchor="anchor-mode">流量模式</a>
        <a class="subnav-item" data-anchor="anchor-strategy">路由策略</a>
        <a class="subnav-item" data-anchor="anchor-sysproxy">系统代理</a>
        <a class="subnav-item" data-anchor="anchor-relay">前置跳板</a>
        <a class="subnav-item" data-anchor="anchor-nodes">出口节点池</a>
        <a class="subnav-item" data-anchor="anchor-rules">分流规则</a>
      </div>

      <div id="anchor-strategy"></div>
      <div class="card">
        <div class="card-h">
          <div class="card-title"><span class="dot"></span>路由策略</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <input type="file" id="configImportInput" accept="application/json,.json" style="display:none" />
            <button class="btn btn-ghost btn-sm" id="importConfigBtn">导入</button>
            <button class="btn btn-ghost btn-sm" id="exportConfigBtn">导出</button>
          </div>
        </div>
        <div class="srow">
          <div>
            <div class="skey">负载均衡策略</div>
            <div class="sdesc">命中规则时多出口如何分配流量</div>
          </div>
          <select class="form-control" id="cfgStrategy" style="width:200px">
            <option value="round-robin">轮询 (round-robin)</option>
            <option value="random">随机 (random)</option>
            <option value="weighted">加权 (weighted)</option>
          </select>
        </div>
        <div class="srow">
          <div>
            <div class="skey">默认路由</div>
            <div class="sdesc">未匹配任何规则时的处理方式</div>
          </div>
          <select class="form-control" id="cfgDefaultRoute" style="width:200px">
            <option value="direct">直连 (direct)</option>
            <option value="proxy">代理 (proxy)</option>
          </select>
        </div>
      </div>

        <div id="anchor-sysproxy"></div>
        <div class="card">
          <div class="card-h">
            <div class="card-title"><span class="dot"></span>系统代理接管（macOS）</div>
            <span class="badge badge-gray" id="sysProxyBadge"><span class="badge-dot"></span>读取中</span>
          </div>
          <div class="card-subtitle" id="sysProxySummary">把 macOS 系统代理指向 Roo 本地入口（HTTP / HTTPS / SOCKS 同端口）。</div>
          <div class="sys-endpoints">
            <div class="sys-row"><span class="sys-row-label">HTTP</span><code id="sysEndpointHttp">-</code></div>
            <div class="sys-row"><span class="sys-row-label">HTTPS</span><code id="sysEndpointHttps">-</code></div>
            <div class="sys-row"><span class="sys-row-label">SOCKS</span><code id="sysEndpointSocks">-</code></div>
          </div>
          <div class="sys-meta" id="sysProxyDetail"></div>
          <div class="sys-actions">
            <button class="btn btn-ghost" id="refreshSystemProxyBtn">刷新状态</button>
            <button class="btn btn-ghost" id="restoreSystemProxyBtn">恢复快照</button>
            <button class="btn btn-danger" id="disableSystemProxyBtn">关闭接管</button>
            <button class="btn btn-primary" id="enableSystemProxyBtn">开启接管</button>
          </div>
        </div>

        <div id="anchor-relay"></div>
        <div class="card">
          <div class="card-h">
            <div class="card-title"><span class="dot"></span>Roo 前置跳板（环境代理）</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-ghost btn-sm" id="envQuickSameBtn" title="把 HTTP_PROXY 复制到其它三个字段">⇔ 一键同步</button>
              <button class="btn btn-ghost btn-sm" id="envClearAllBtn">清空全部</button>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:12px;line-height:1.6">推荐填你现有的本地代理（如 Clash 端口）。所有出口节点默认都会先经过这里，再走住宅 IP / 落地机出口。</div>
          <div class="relay-grid">
            <div class="relay-cell">
              <span class="relay-label">HTTP</span>
              <input class="form-control relay-input" id="envHttpProxy" placeholder="http://127.0.0.1:6578" />
            </div>
            <div class="relay-cell">
              <span class="relay-label">HTTPS</span>
              <input class="form-control relay-input" id="envHttpsProxy" placeholder="http://127.0.0.1:6578" />
            </div>
            <div class="relay-cell">
              <span class="relay-label">ALL</span>
              <input class="form-control relay-input" id="envAllProxy" placeholder="socks5://127.0.0.1:6578" />
            </div>
            <div class="relay-cell">
              <span class="relay-label">NO</span>
              <input class="form-control relay-input" id="envNoProxy" placeholder="localhost,127.0.0.1,.local" />
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
            <button class="btn btn-ghost btn-sm" id="resetEnvBtn">重置</button>
            <button class="btn btn-primary btn-sm" id="applyEnvBtn">保存前置跳板</button>
          </div>
        </div>

        <div id="anchor-nodes"></div>
        <div class="card">
          <div class="sec-h">
            <div class="sec-t"><span class="dot"></span>出口节点池（落地机）</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-ghost btn-sm" id="latencyTestAllBtn">⚡ 全部测延时</button>
              <button class="btn btn-primary btn-sm" id="addUpstreamBtn">+ 添加出口节点</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">出口节点 = 最终对外出站的住宅 IP / 落地机。默认复用上方「前置跳板」为中转。<strong style="color:var(--cyan)">权重</strong>：加权策略下数字越大被选概率越大（如 A=1、B=3 → B 被选概率是 A 的 3 倍）；轮询/随机策略下权重字段被忽略。</div>
          <table id="upstreamTable" style="display:none">
            <thead><tr><th>名称</th><th>协议</th><th>地址</th><th>权重</th><th>延时</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="upstreamBody"></tbody>
          </table>
          <div class="empty-tip" id="upstreamEmpty">暂无出口节点，点击「添加」新建</div>
        </div>

        <div id="anchor-mode"></div>
        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>TRAFFIC MODE · 流量模式</div></div>
          <div class="mode-switch">
            <button class="mode-btn active" data-mode="rule">
              <span class="mode-btn-title">规则模式</span>
              <span class="mode-btn-desc">命中规则走代理 / 直连，未命中走默认（和下方规则一致）</span>
            </button>
            <button class="mode-btn" data-mode="global">
              <span class="mode-btn-title">全局代理</span>
              <span class="mode-btn-desc">所有流量都走出口节点池（忽略下方规则）</span>
            </button>
            <button class="mode-btn" data-mode="direct">
              <span class="mode-btn-title">直连模式</span>
              <span class="mode-btn-desc">所有流量直连，不走任何出口（忽略下方规则）</span>
            </button>
          </div>
          <div class="mode-hint" id="modeHint"></div>
        </div>

        <div id="anchor-rules"></div>
        <div class="card" id="rulesCard">
          <div class="sec-h">
            <div class="sec-t"><span class="dot"></span>分流规则</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-ghost btn-sm" id="clashImportOpenBtn">⇪ 批量导入</button>
              <button class="btn btn-primary btn-sm" id="addRuleBtn">+ 添加规则</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">规则决定流量是直连，还是进入某个出口节点池；表格靠上的规则优先命中。仅在「规则模式」下生效。</div>
          <div class="filter-bar">
            <input class="form-control filter-search" id="ruleFilterSearch" placeholder="搜索匹配值，如 claude.ai / 10.0.0.0 / CN" />
            <select class="form-control filter-select" id="ruleFilterGroup">
              <option value="">全部分组</option>
            </select>
            <select class="form-control filter-select" id="ruleFilterType">
              <option value="">全部类型</option>
              <option value="domain-suffix">domain-suffix</option>
              <option value="domain-exact">domain-exact</option>
              <option value="domain-keyword">domain-keyword</option>
              <option value="ipv4-cidr">ipv4-cidr</option>
              <option value="ipv6-cidr">ipv6-cidr</option>
              <option value="geo-country">geo-country</option>
              <option value="geo-region">geo-region</option>
            </select>
            <select class="form-control filter-select" id="ruleFilterAction">
              <option value="">全部动作</option>
              <option value="proxy">proxy</option>
              <option value="direct">direct</option>
            </select>
            <select class="form-control filter-select" id="ruleFilterUpstream">
              <option value="">全部出口</option>
            </select>
            <select class="form-control filter-select" id="ruleFilterEnabled" style="min-width:110px">
              <option value="">全部状态</option>
              <option value="on">仅启用</option>
              <option value="off">仅禁用</option>
            </select>
            <select class="form-control filter-select" id="ruleFilterPageSize" style="min-width:90px">
              <option value="20">20 / 页</option>
              <option value="50">50 / 页</option>
              <option value="100">100 / 页</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="ruleFilterReset">重置筛选</button>
          </div>
          <table id="rulesTable" style="display:none">
            <thead><tr><th style="width:40px">#</th><th>启用</th><th>分组</th><th>类型</th><th>匹配值</th><th>动作</th><th>出口节点</th><th>操作</th></tr></thead>
            <tbody id="rulesBody"></tbody>
          </table>
          <div class="empty-tip" id="rulesEmpty">暂无规则，点击「添加」新建</div>
          <div class="pager" id="rulesPager" style="display:none">
            <span class="pager-meta" id="rulesPagerMeta"></span>
            <button class="btn btn-ghost btn-sm" id="rulesPagerPrev">◀ 上一页</button>
            <span id="rulesPagerPage"></span>
            <button class="btn btn-ghost btn-sm" id="rulesPagerNext">下一页 ▶</button>
          </div>
        </div>

      </div><!-- /page-config -->

      <!-- ========== PAGE: LOGS (访问日志) ========== -->
      <div class="page" id="page-logs">
      <div class="card">
        <div class="sec-h">
          <div class="sec-t"><span class="dot"></span>最近访问日志</div>
          <div style="display:flex;gap:6px">
            <select class="form-control filter-select" id="logsLimit" style="min-width:110px;height:32px;padding:4px 8px;font-size:12.5px">
              <option value="20">最近 20 条</option>
              <option value="50">最近 50 条</option>
              <option value="100">最近 100 条</option>
              <option value="200">最近 200 条</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="refreshLogsBtn">↻ 刷新</button>
          </div>
        </div>
        <div id="logsList"><div class="empty-tip">加载中...</div></div>
      </div>
      </div><!-- /page-logs -->

    </div>

    <div class="apply-bar">
      <span class="apply-bar-text">// 修改后点击 APPLY 保存到本地配置并热重载</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="resetConfigBtn">RESET</button>
        <button class="btn btn-primary" id="applyConfigBtn">✓ APPLY</button>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <!-- Upstream Modal -->
  <div class="modal-overlay" id="upstreamModal">
    <div class="modal">
      <div class="modal-title" id="upstreamModalTitle">添加出口节点</div>
      <div class="form-group"><label class="form-label">名称 *</label><input class="form-control" id="upName" placeholder="如: residential-US-01" /></div>
      <div class="form-group"><label class="form-label">代理 URL *</label><input class="form-control" id="upUrl" placeholder="socks5://user:pass@host:port" /></div>
      <div class="grid-2" style="gap:12px">
        <div class="form-group"><label class="form-label">到期时间</label><input class="form-control" id="upExpiresAt" type="date" /></div>
        <div class="form-group"><label class="form-label">权重</label><input class="form-control" id="upWeight" type="number" value="1" min="1" /></div>
      </div>
      <div class="form-group"><label class="form-label">购买官网（方便续费）</label><input class="form-control" id="upVendorUrl" placeholder="如: https://vendor.com/dashboard" /></div>
      <div class="form-group"><label class="form-label">备注</label><input class="form-control" id="upNote" maxlength="200" placeholder="如: 美国住宅 · 10GB/月 · 仅用于 claude.ai" /></div>
      <div style="font-size:12px;color:var(--text-3);margin:-4px 0 12px">默认会复用上面配置的全局前置跳板。只有这个出口需要单独前置链路时，才展开「高级设置」。</div>
      <div class="form-group" style="margin-bottom:8px">
        <button type="button" class="btn btn-ghost btn-sm" id="toggleUpViaBtn">高级设置：单独 via</button>
      </div>
      <div class="form-group" id="upViaGroup" style="display:none"><label class="form-label">单独 via（可选）</label><input class="form-control" id="upVia" placeholder="如: socks5://entry-user:pass@host:port 或 http://host:port" /></div>
      <div class="form-group" style="display:flex;align-items:center;gap:12px">
        <label class="form-label" style="margin:0">启用</label>
        <label class="toggle"><input type="checkbox" id="upEnabled" checked /><span class="toggle-slider"></span></label>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="upCancelBtn">取消</button>
        <button class="btn btn-primary" id="upSaveBtn">保存</button>
      </div>
    </div>
  </div>

  <!-- Rule Modal -->
  <div class="modal-overlay" id="ruleModal">
    <div class="modal">
      <div class="modal-title" id="ruleModalTitle">添加分流规则</div>
      <div class="grid-2" style="gap:12px">
        <div class="form-group"><label class="form-label">规则类型</label>
          <select class="form-control" id="ruleType">
            <option value="domain-suffix">域名后缀 (domain-suffix)</option>
            <option value="domain-exact">精确域名 (domain-exact)</option>
            <option value="domain-keyword">域名关键词 (domain-keyword)</option>
            <option value="ipv4-cidr">IPv4 CIDR</option>
            <option value="ipv6-cidr">IPv6 CIDR</option>
            <option value="geo-country">国家代码 (geo-country)</option>
            <option value="geo-region">地区代码 (geo-region)</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">动作</label>
          <select class="form-control" id="ruleAction">
            <option value="proxy">代理 (proxy)</option>
            <option value="direct">直连 (direct)</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">匹配值 *</label><input class="form-control" id="ruleValue" placeholder="如: claude.ai" /></div>
      <div class="form-group"><label class="form-label">分组</label><input class="form-control" id="ruleGroup" list="ruleGroupOptions" placeholder="如: AI / 国内 / 默认" /><datalist id="ruleGroupOptions"></datalist></div>
      <div class="form-group" id="ruleUpstreamsGroup">
        <label class="form-label">出口节点</label>
        <div id="ruleUpstreamCheckboxes"></div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px;font-family:var(--mono)">// 不勾选 = 从出口节点池按「负载均衡策略」挑（CHAIN tab 设置）</div>
      </div>
      <div class="form-group" style="display:flex;align-items:center;gap:12px">
        <label class="form-label" style="margin:0">启用该规则</label>
        <label class="toggle"><input type="checkbox" id="ruleEnabled" checked /><span class="toggle-slider"></span></label>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="ruleCancelBtn">取消</button>
        <button class="btn btn-primary" id="ruleSaveBtn">保存</button>
      </div>
    </div>
  </div>

  <!-- Clash Import Modal -->
  <div class="modal-overlay" id="clashImportModal">
    <div class="modal" style="width:820px">
      <div class="modal-title">批量导入 · 粘贴 Clash 风格规则</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px;line-height:1.7;font-family:var(--mono)">
        // 支持 Clash 规则前缀：DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / IP-CIDR6 / GEOIP<br>
        // 不支持 PROCESS-NAME（Roo 是纯网络代理，看不到进程名）—— 粘贴时自动跳过<br>
        // 支持任意格式：纯行、带引号、逗号结尾、注释行（// 或 #）都能识别
      </div>
      <div class="form-group">
        <label class="form-label">粘贴规则（每行一条）</label>
        <textarea class="form-control" id="clashInput" rows="10" style="font-family:var(--mono);font-size:12px;resize:vertical" placeholder='DOMAIN-SUFFIX,claude.ai,🛬 AI落地节点
DOMAIN-SUFFIX,alipay.com,DIRECT
PROCESS-NAME,Claude,🛬 AI落地节点'></textarea>
      </div>
      <div class="grid-2" style="gap:12px">
        <div class="form-group"><label class="form-label">导入到分组</label><input class="form-control" id="clashImportGroup" value="导入" /></div>
        <div class="form-group"><label class="form-label">位置</label>
          <select class="form-control" id="clashImportPosition">
            <option value="prepend">插入到表格最上方（优先命中）</option>
            <option value="append">追加到表格末尾</option>
          </select>
        </div>
      </div>
      <div class="form-group" id="clashMappingGroup" style="display:none">
        <label class="form-label">未识别的 target → 映射到 Roo 出口</label>
        <div id="clashMappingList" style="display:grid;gap:8px;max-height:240px;overflow-y:auto;padding:2px"></div>
      </div>
      <div class="form-group" id="clashPreviewGroup" style="display:none">
        <label class="form-label">预览（将导入 <span id="clashPreviewCount">0</span> 条，跳过 <span id="clashSkipCount">0</span> 条）</label>
        <div id="clashPreviewList" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-lg);padding:8px;background:var(--panel-2);font-size:11.5px;font-family:var(--mono)"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="clashCancelBtn">取消</button>
        <button class="btn btn-ghost" id="clashParseBtn">解析预览</button>
        <button class="btn btn-primary" id="clashImportBtn" disabled>导入 <span id="clashImportCount">0</span> 条</button>
      </div>
    </div>
  </div>

<script>
let cfg = null, originalCfg = null, lastStatus = null, envSettings = null, systemProxyStatus = null;
let editUpIdx = -1;
let overviewRefreshToken = 0;
let lastNetDiagRenderKey = null;
let upViaExpanded = false;
const ruleFilter = { search: '', type: '', action: '', upstream: '', group: '', enabled: '', page: 1, pageSize: 20 };
const upstreamLatency = {}; // { [name]: { pending, ok, latencyMs, ip, meta, error } }

function updateTopbarStatus(running) {
  const el = document.getElementById('sidebarStatus');
  if (!el) return;
  if (running === false) {
    el.className = 'topbar-status danger';
    el.innerHTML = '<span class="pulse"></span>OFFLINE';
  } else {
    el.className = 'topbar-status';
    el.innerHTML = '<span class="pulse"></span>ONLINE';
  }
}

// ---- Top nav tabs ----
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const pageId = tab.dataset.page;
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById('page-' + pageId);
    if (target) target.classList.add('active');
    if (pageId === 'logs') loadLogs();
  });
});

// ---- CONFIG sub-anchor nav (smooth scroll + active tracking) ----
document.querySelectorAll('.subnav-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const anchorId = item.dataset.anchor;
    const el = document.getElementById(anchorId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.subnav-item').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
  });
});

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '请求失败 ' + res.status);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function maskUrl(url) {
  try { const u = new URL(url); if (u.password) u.password = '****'; return u.toString(); } catch { return url; }
}

function describeExpiry(iso) {
  if (!iso) return { badgeCls: '', short: '', tooltip: '', days: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { badgeCls: '', short: '', tooltip: '', days: null };
  const now = new Date();
  const ms = d.getTime() - now.getTime();
  const days = Math.floor(ms / 86400000);
  const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  if (days < 0) return { badgeCls: 'badge-red', short: '已过期', tooltip: '已于 ' + dateStr + ' 过期，请尽快续费', days };
  if (days <= 3) return { badgeCls: 'badge-red', short: days === 0 ? '今日到期' : days + ' 天到期', tooltip: dateStr + ' 到期', days };
  if (days <= 7) return { badgeCls: 'badge-amber', short: days + ' 天到期', tooltip: dateStr + ' 到期', days };
  if (days <= 30) return { badgeCls: 'badge-blue', short: days + ' 天', tooltip: dateStr + ' 到期', days };
  return { badgeCls: 'badge-gray', short: dateStr.slice(5), tooltip: dateStr + ' 到期', days };
}

function isoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function dateInputToIso(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const d = new Date(v + 'T23:59:59');
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function renderExpiryReminder() {
  const wrap = document.getElementById('ovExpiryReminder');
  if (!wrap) return;
  const items = (cfg?.upstreams || [])
    .map(u => ({ u, exp: describeExpiry(u.expiresAt) }))
    .filter(({ exp }) => exp.days != null && exp.days <= 30)
    .sort((a, b) => a.exp.days - b.exp.days);
  if (!items.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const critical = items.filter(({ exp }) => exp.days <= 7).length;
  const hint = critical
    ? '<strong style="color:var(--red)">' + critical + ' 个节点将在 7 天内到期</strong>，请抓紧续费：'
    : items.length + ' 个节点将在 30 天内到期：';
  wrap.innerHTML =
    '<div class="card-h"><div class="card-title"><span class="dot" style="background:var(--amber)"></span>续费提醒</div></div>' +
    '<div style="font-size:12.5px;color:var(--text-2);margin-bottom:10px">' + hint + '</div>' +
    '<div class="expiry-list">' +
    items.slice(0, 8).map(({ u, exp }) => {
      const vendor = u.vendorUrl
        ? '<a href="' + esc(u.vendorUrl) + '" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">去续费 ↗</a>'
        : '<span class="badge badge-gray" title="未配置购买官网，无法一键跳转续费">未配购买官网</span>';
      return '<div class="expiry-row">'
        + '<div><strong>' + esc(u.name) + '</strong>'
        + ' <span class="badge ' + exp.badgeCls + '">' + esc(exp.short) + '</span>'
        + (u.note ? '<div style="font-size:12px;color:var(--text-3);margin-top:4px">' + esc(u.note) + '</div>' : '')
        + '</div>'
        + '<div>' + vendor + '</div>'
        + '</div>';
    }).join('') +
    '</div>';
}

function formatConfigExportName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return 'roo-config-'
    + d.getFullYear()
    + pad(d.getMonth() + 1)
    + pad(d.getDate())
    + '-'
    + pad(d.getHours())
    + pad(d.getMinutes())
    + pad(d.getSeconds())
    + '.json';
}

function downloadConfig(config) {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = formatConfigExportName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  if (d) return d + '天 ' + h + '小时';
  if (h) return h + '小时 ' + m + '分';
  if (m) return m + '分 ' + s + '秒';
  return s + '秒';
}


function formatNum(n) {
  if (n == null) return '-';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatIpMeta(meta) {
  if (!meta || !meta.ip) return '获取失败';
  const parts = [meta.ip];
  const location = [meta.country, meta.region, meta.city].filter(Boolean).join(' / ');
  if (location) parts.push(location);
  if (meta.isp) parts.push('ISP: ' + meta.isp);
  return parts.join(' · ');
}

function getDiagValue(meta, fallback, emptyText = '获取失败') {
  if (meta && meta.ip) return formatIpMeta(meta);
  if (fallback) return fallback;
  return emptyText;
}

function buildNetDiagSummary(netDiag = {}) {
  const summary = netDiag.upstreamCheckSummary || { totalEnabled: 0, checked: 0, ok: 0, failed: 0, skipped: 0 };
  const failedChecks = Array.isArray(netDiag.upstreamChecks)
    ? netDiag.upstreamChecks.filter((item) => !item.ok)
    : [];
  const relay = netDiag.relayProbe;

  // 前置代理自己挂了：这是头号问题，所有依赖前置的节点都会连带异常
  if (relay && relay.configured && relay.ok === false) {
    return {
      tone: 'danger',
      badge: '前置异常',
      title: '前置代理自身探测失败',
      desc: '前置代理 ' + esc(netDiag.envProxy || '') + ' 无法访问外网（' + esc(relay.error || '未知错误') + '）。',
      meta: summary.failed > 0
        ? '所有需要走前置的出口节点都会连带异常（当前已有 ' + summary.failed + ' 个异常），先恢复前置再查节点。'
        : '所有需要走前置的出口节点都会受影响。',
      actions: ['检查前置代理', '确认 shell 中的 HTTP_PROXY/ALL_PROXY 指向可用服务'],
    };
  }

  if (summary.failed > 0) {
    const failedNames = failedChecks.slice(0, 2).map((item) => item.name).filter(Boolean);
    return {
      tone: 'danger',
      badge: '异常',
      title: '出口节点存在异常',
      desc: '已检查 ' + esc(String(summary.checked || 0)) + ' 个出口，失败 ' + esc(String(summary.failed || 0)) + ' 个。',
      meta: failedNames.length ? ('异常节点：' + esc(failedNames.join('、'))) : '请优先处理失败节点。',
      actions: ['检查失败节点', netDiag.envProxy ? '检查前置代理' : '检查出口配置'],
    };
  }

  if (netDiag.envProxy) {
    return {
      tone: 'warning',
      badge: '前置代理中',
      title: '当前已启用前置代理链路',
      desc: '服务可用，出口结果会受前置代理影响。',
      meta: netDiag.envProxy ? ('当前前置代理：' + netDiag.envProxy) : '当前前置代理：未设置',
      actions: ['确认出口是否符合预期'],
    };
  }

  return {
    tone: 'success',
    badge: '正常',
    title: '当前链路正常',
    desc: summary.totalEnabled
      ? ('已检查 ' + esc(String(summary.checked || 0)) + ' 个出口，未发现异常。')
      : '当前没有启用出口节点，按默认路由工作。',
    meta: '概览页仅保留关键状态。',
    actions: ['需要时再看日志'],
  };
}

function renderSummaryActions(actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
  if (!list.length) {
    return '<span class="summary-action">暂无额外建议</span>';
  }
  return list.map((item) => '<span class="summary-action">' + esc(item) + '</span>').join('');
}

function updateOverviewSummary(netDiag) {
  const summary = buildNetDiagSummary(netDiag);

  // 新的赛博朋克状态条
  const strip = document.getElementById('ovStatusStrip');
  const sBadge = document.getElementById('ovStatusBadge');
  const sBadgeText = document.getElementById('ovStatusBadgeText');
  const sTitle = document.getElementById('ovStatusTitle');
  const sDesc = document.getElementById('ovStatusDesc');
  const sMeta = document.getElementById('ovStatusMeta');
  if (strip && sBadge && sTitle && sDesc && sMeta) {
    const toneMap = { danger: 'danger', warning: 'warn', success: 'success', neutral: '' };
    const cls = toneMap[summary.tone] || '';
    strip.className = 'status-strip' + (cls ? ' ' + cls : '');
    const badgeLabel = ({ success: 'OK', warning: 'RELAY', danger: 'ALERT', neutral: 'SCAN' })[summary.tone] || 'SCAN';
    if (sBadgeText) sBadgeText.textContent = badgeLabel;
    sTitle.innerHTML = '<strong>' + esc(summary.title) + '</strong>';
    sDesc.textContent = summary.desc;
    sMeta.textContent = summary.meta || '';
  }

  // 旧 summary-shell 保持更新（隐藏，但保持 DOM 一致避免 JS 引用报错）
  const shell = document.getElementById('ovRunSummary');
  const badge = document.getElementById('ovSummaryBadge');
  const title = document.getElementById('ovSummaryTitle');
  const desc = document.getElementById('ovSummaryDesc');
  const meta = document.getElementById('ovSummaryMeta');
  const actions = document.getElementById('ovSummaryActions');
  if (shell && badge && title && desc && meta && actions) {
    shell.className = 'summary-shell ' + summary.tone;
    badge.className = 'summary-badge ' + summary.tone;
    badge.innerHTML = '<span class="summary-badge-dot"></span>' + esc(summary.badge);
    title.textContent = summary.title;
    desc.textContent = summary.desc;
    meta.textContent = summary.meta;
    actions.innerHTML = renderSummaryActions(summary.actions);
  }
}


function renderRelayBlock(netDiag) {
  const envProxy = netDiag.envProxy;
  const relay = netDiag.relayProbe || { configured: false };
  if (!envProxy && !relay.configured) {
    return '<div class="diag-block">'
      + '<div class="diag-caption" style="display:flex;justify-content:space-between;align-items:center">'
        + '<span>前置代理</span>'
        + '<span class="badge badge-gray"><span class="badge-dot"></span>未配置</span>'
      + '</div>'
      + '<div class="diag-text">未设置</div>'
      + '</div>';
  }
  let badgeCls, badgeTxt, extra = '';
  if (relay.ok === true) {
    badgeCls = 'badge-green'; badgeTxt = '正常';
    const ipLine = relay.meta ? formatIpMeta(relay.meta) : (relay.ip || '');
    const latency = relay.latencyMs != null ? (relay.latencyMs + ' ms') : '';
    extra = '<div class="diag-text" style="margin-top:6px;font-size:12px;color:var(--text-2)">前置出口：' + esc(ipLine) + (latency ? ' · ' + esc(latency) : '') + '</div>';
  } else if (relay.ok === false) {
    badgeCls = 'badge-red'; badgeTxt = '异常';
    extra = '<div class="diag-text" style="margin-top:6px;font-size:12px;color:var(--red)">探测失败：' + esc(relay.error || '未知错误') + '</div>';
  } else {
    badgeCls = 'badge-gray'; badgeTxt = '未检测';
  }
  return '<div class="diag-block' + (relay.ok === false ? ' bad' : '') + '">'
    + '<div class="diag-caption" style="display:flex;justify-content:space-between;align-items:center">'
      + '<span>前置代理</span>'
      + '<span class="badge ' + badgeCls + '"><span class="badge-dot"></span>' + esc(badgeTxt) + '</span>'
    + '</div>'
    + '<div class="diag-text">' + esc(envProxy) + '</div>'
    + extra
    + '</div>';
}

function renderNetDiag(netDiag) {
  const summary = netDiag.upstreamCheckSummary || { totalEnabled: 0, checked: 0, ok: 0, failed: 0, skipped: 0 };
  const checks = Array.isArray(netDiag.upstreamChecks) ? netDiag.upstreamChecks : [];
  const failedChecks = checks.filter((item) => !item.ok).slice(0, 3);
  const relay = netDiag.relayProbe || { configured: false };
  const relayDown = relay.configured && relay.ok === false;

  // 出口节点块：明确区分「选中的节点」和「该节点实际出的 IP」
  let egressBlock;
  const meta = netDiag.rooProxyMeta;
  const ipLine = meta && meta.ip ? formatIpMeta(meta) : (netDiag.rooProxyIp || '暂无数据');
  if (netDiag.rooProbeMode === 'upstream-probe' && netDiag.rooProbeUpstream) {
    // 节点探测成功：IP 就是节点真实出口
    egressBlock =
      '<div class="diag-block">'
      + '<div class="diag-caption" style="display:flex;justify-content:space-between;align-items:center">'
        + '<span>选中节点</span>'
        + '<span class="badge badge-green"><span class="badge-dot"></span>' + esc(netDiag.rooProbeUpstream) + '</span>'
      + '</div>'
      + '<div class="diag-text" style="margin-top:4px;font-size:11.5px;color:var(--text-3)">节点真实出口 IP（地区 / ISP）：</div>'
      + '<div class="diag-text" style="color:var(--cyan)">' + esc(ipLine) + '</div>'
      + '</div>';
  } else if (netDiag.rooProbeMode === 'upstream-probe-failed' && netDiag.rooProbeUpstream) {
    // 节点探测失败：下面的 IP 是 fallback（本机直连 / 前置），不是该节点的
    egressBlock =
      '<div class="diag-block bad">'
      + '<div class="diag-caption" style="display:flex;justify-content:space-between;align-items:center">'
        + '<span>选中节点</span>'
        + '<span class="badge badge-red"><span class="badge-dot"></span>' + esc(netDiag.rooProbeUpstream) + ' · 异常</span>'
      + '</div>'
      + '<div class="diag-text" style="margin-top:4px;font-size:11.5px;color:var(--yellow)">⚠ 该节点探测失败，下方 IP <strong>不是</strong>该节点的真实出口，而是 Roo 本机/前置 fallback：</div>'
      + '<div class="diag-text" style="color:var(--text-3)">' + esc(ipLine) + '</div>'
      + '</div>';
  } else {
    // 无选中节点（direct 模式 / 全局 / 未启用出口）：展示 Roo 本机出口
    const label = netDiag.rooProbeMode === 'roo-route' ? 'Roo 代理链路实际出口' : '当前出口';
    egressBlock =
      '<div class="diag-block">'
      + '<div class="diag-caption">' + esc(label) + '</div>'
      + '<div class="diag-text" style="margin-top:2px;font-size:11.5px;color:var(--text-3)">经 Roo 出口测得的 IP（地区 / ISP）：</div>'
      + '<div class="diag-text" style="color:var(--cyan)">' + esc(ipLine) + '</div>'
      + '</div>';
  }

  return [
    '<div class="section-stack">',
      '<div class="diag-grid">',
        '<div class="diag-panel">',
          '<div class="diag-title">当前路径</div>',
          '<div class="diag-list">',
            renderRelayBlock(netDiag),
            egressBlock,
          '</div>',
        '</div>',
        '<div class="diag-panel">',
          '<div class="diag-title">出口检查</div>',
          '<div class="diag-stats">',
            '<div class="diag-stat"><div class="diag-stat-label">启用</div><div class="diag-stat-value">' + esc(String(summary.totalEnabled || 0)) + '</div></div>',
            '<div class="diag-stat"><div class="diag-stat-label">已检查</div><div class="diag-stat-value">' + esc(String(summary.checked || 0)) + '</div></div>',
            '<div class="diag-stat"><div class="diag-stat-label">正常</div><div class="diag-stat-value">' + esc(String(summary.ok || 0)) + '</div></div>',
            '<div class="diag-stat"><div class="diag-stat-label">异常</div><div class="diag-stat-value">' + esc(String(summary.failed || 0)) + '</div></div>',
          '</div>',
          relayDown && summary.failed > 0
            ? '<div class="diag-note diag-note-warning" style="margin-bottom:8px">⚠ 前置代理异常，下方节点故障很可能是被前置拖累，先修复前置后再判断节点真实状态。</div>'
            : '',
          failedChecks.length
            ? ('<div class="diag-list">'
                + failedChecks.map((item) => {
                  const viaRelay = item.probeMode === 'via-chain' || item.probeMode === 'env-proxy';
                  const blameTag = relayDown && viaRelay
                    ? '<span class="badge badge-amber" style="margin-left:6px" title="该节点依赖前置代理，前置代理已异常">疑似前置拖累</span>'
                    : '';
                  return '<div class="diag-block bad">'
                    + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
                      + '<div style="font-size:13px;font-weight:600;color:var(--text)">' + esc(item.name) + blameTag + '</div>'
                      + '<span class="badge badge-red"><span class="badge-dot"></span>异常</span>'
                    + '</div>'
                    + '<div class="diag-text" style="margin-top:6px;font-size:12px;color:var(--text-2)">' + esc(item.error || '连接失败') + '</div>'
                  + '</div>';
                }).join('')
              + '</div>')
            : '<div class="diag-note diag-note-success">未发现出口异常。</div>',
        '</div>',
      '</div>',
    '</div>'
  ].join('');
}

function renderEnvSettings() {
  const current = envSettings?.effective || {};
  document.getElementById('envHttpProxy').value = current.HTTP_PROXY || '';
  document.getElementById('envHttpsProxy').value = current.HTTPS_PROXY || '';
  document.getElementById('envAllProxy').value = current.ALL_PROXY || '';
  document.getElementById('envNoProxy').value = current.NO_PROXY || '';
}

function describeSysProxyBadge(status) {
  if (!status) return { cls: 'badge-gray', text: '读取中' };
  if (!status.supported) return { cls: 'badge-gray', text: '不支持' };
  if (status.managed) return { cls: 'badge-green', text: '已接管' };
  return { cls: 'badge-amber', text: '未接管' };
}

function formatSysEndpoint(item, fallback) {
  if (item && item.enabled && item.host && item.port) {
    return item.host + ':' + item.port;
  }
  if (fallback) return fallback;
  return '未启用';
}

function renderSystemProxyStatus(status) {
  systemProxyStatus = status || null;
  const badge = document.getElementById('sysProxyBadge');
  const detail = document.getElementById('sysProxyDetail');
  const httpEl = document.getElementById('sysEndpointHttp');
  const httpsEl = document.getElementById('sysEndpointHttps');
  const socksEl = document.getElementById('sysEndpointSocks');
  const enableBtn = document.getElementById('enableSystemProxyBtn');
  const disableBtn = document.getElementById('disableSystemProxyBtn');
  const restoreBtn = document.getElementById('restoreSystemProxyBtn');

  if (!badge || !detail || !httpEl || !httpsEl || !socksEl || !enableBtn || !disableBtn || !restoreBtn) {
    return;
  }

  const b = describeSysProxyBadge(status);
  badge.className = 'badge ' + b.cls;
  badge.innerHTML = '<span class="badge-dot"></span>' + esc(b.text);

  if (!status) {
    httpEl.textContent = '-';
    httpsEl.textContent = '-';
    socksEl.textContent = '-';
    detail.innerHTML = '';
    enableBtn.disabled = false;
    disableBtn.disabled = false;
    restoreBtn.disabled = false;
    return;
  }

  const current = status.current || {};
  const localFallback = status.managed ? (status.localEndpoint || '') : '';
  httpEl.textContent = formatSysEndpoint(current.web, localFallback);
  httpsEl.textContent = formatSysEndpoint(current.secureweb, localFallback);
  socksEl.textContent = formatSysEndpoint(current.socksfirewall, localFallback);

  const serviceHint = status.device
    ? (status.service + ' (' + status.device + ')')
    : (status.service || '-');
  const snapshotTime = status.snapshot?.savedAt
    ? new Date(status.snapshot.savedAt).toLocaleString('zh-CN')
    : null;
  const parts = ['<strong>目标服务</strong> ' + esc(serviceHint)];
  if (snapshotTime) {
    parts.push('<strong>恢复快照</strong> ' + esc(snapshotTime));
  }
  detail.innerHTML = parts.join(' &nbsp;·&nbsp; ');

  const unsupported = status.supported === false;
  enableBtn.disabled = unsupported || Boolean(status.managed);
  disableBtn.disabled = unsupported || !status.managed;
  restoreBtn.disabled = unsupported || !status.snapshot;
}

async function loadSystemProxyStatus() {
  try {
    const status = await api('/system-proxy');
    renderSystemProxyStatus(status);
  } catch (e) {
    renderSystemProxyStatus(null);
    const detail = document.getElementById('sysProxyDetail');
    if (detail) detail.innerHTML = '<span style="color:var(--red)">读取失败：' + esc(e.message) + '</span>';
  }
}

async function applySystemProxyAction(action, buttonId, loadingText, successText) {
  const btn = document.getElementById(buttonId);
  if (!btn) {
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingText;
  try {
    const result = await api('/system-proxy/' + action, { method: 'POST' });
    renderSystemProxyStatus(result);
    toast(successText);
    loadOverview();
  } catch (e) {
    toast('系统代理操作失败：' + e.message, 'error');
    await loadSystemProxyStatus();
  } finally {
    btn.textContent = originalText;
  }
}

function setNetDiagLoading(message = '网络状态刷新中...') {
  const el = document.getElementById('ovNetDiag');
  if (!el) return;
  // 新状态条
  const strip = document.getElementById('ovStatusStrip');
  const sBadgeText = document.getElementById('ovStatusBadgeText');
  const sTitle = document.getElementById('ovStatusTitle');
  const sDesc = document.getElementById('ovStatusDesc');
  const sMeta = document.getElementById('ovStatusMeta');
  if (strip) strip.className = 'status-strip';
  if (sBadgeText) sBadgeText.textContent = 'SCAN';
  if (sTitle) sTitle.innerHTML = '<strong>正在评估链路状态…</strong>';
  if (sDesc) sDesc.textContent = message;
  if (sMeta) sMeta.textContent = '';
  // 旧 shell 兼容
  const shell = document.getElementById('ovRunSummary');
  const badge = document.getElementById('ovSummaryBadge');
  const title = document.getElementById('ovSummaryTitle');
  const desc = document.getElementById('ovSummaryDesc');
  const meta = document.getElementById('ovSummaryMeta');
  const actions = document.getElementById('ovSummaryActions');
  if (shell) shell.className = 'summary-shell neutral';
  if (badge) badge.className = 'summary-badge neutral';
  if (badge) badge.innerHTML = '<span class="summary-badge-dot"></span>加载中';
  if (title) title.textContent = '正在评估当前链路状态';
  if (desc) desc.textContent = message;
  if (meta) meta.textContent = '请稍候，系统正在刷新关键状态。';
  if (actions) actions.innerHTML = '<span class="summary-action">等待诊断完成</span>';
  el.innerHTML = '<div class="diag-note">' + esc(message) + '</div>';
}

function setNetDiagError(message = '网络诊断刷新失败，请稍后重试') {
  const el = document.getElementById('ovNetDiag');
  if (!el) return;
  updateOverviewSummary({
    upstreamCheckSummary: { totalEnabled: 0, checked: 0, ok: 0, failed: 1, skipped: 0 },
    upstreamChecks: [{ name: 'network-diagnostics', ok: false, error: message }],
    envProxy: null,
  });
  el.innerHTML = '<div class="diag-note diag-note-danger">' + esc(message) + '</div>';
}

async function refreshNetworkDiagnostics(token) {
  const el = document.getElementById('ovNetDiag');
  const hasExistingContent = Boolean(el && el.innerHTML.trim());
  if (!hasExistingContent) {
    setNetDiagLoading();
  }
  try {
    const diagnostics = await api('/network-diagnostics');
    if (token !== overviewRefreshToken) {
      return;
    }
    updateOverviewSummary(diagnostics || {});
    const nextRender = renderNetDiag(diagnostics || {});
    const nextRenderKey = JSON.stringify(diagnostics || {});
    if (el && nextRenderKey !== lastNetDiagRenderKey) {
      el.innerHTML = nextRender;
      lastNetDiagRenderKey = nextRenderKey;
    }
  } catch (error) {
    if (token !== overviewRefreshToken) {
      return;
    }
    setNetDiagError('网络诊断刷新失败：' + (error.message || '未知错误'));
  }
}

async function loadOverview() {
  const token = Date.now();
  overviewRefreshToken = token;

  try {
    const status = await api('/status');
    if (token !== overviewRefreshToken) {
      return;
    }

    lastStatus = status;
    renderOverview(status);
    updateTopbarStatus(status.running !== false);

    refreshNetworkDiagnostics(token);
  } catch (e) {
    if (token !== overviewRefreshToken) {
      return;
    }

    document.getElementById('ovStatus').textContent = '离线';
    updateTopbarStatus(false);
    setNetDiagError('服务状态获取失败，暂无法刷新网络诊断');
  }
}

function renderOverview(s) {
  const running = s.running !== false;
  document.getElementById('ovStatus').innerHTML = running
    ? '<span style="color:var(--green)">● 运行中</span>'
    : '<span style="color:var(--red)">● 已停止</span>';
  document.getElementById('ovUptime').textContent = '已运行 ' + formatDuration(s.startedAtSeconds);

  const st = s.statsSummary || {};
  document.getElementById('ovToday').textContent = formatNum(st.todayRequests || 0);
  document.getElementById('ovTotal').textContent = '累计 ' + formatNum(st.totalRequests || 0) + ' 次请求';

  const health = s.upstreamHealth || [];
  const healthy = health.filter(h => h.healthy).length;
  document.getElementById('ovUpstream').innerHTML = healthy + '<small>/ ' + health.length + '</small>';
  document.getElementById('ovUpstreamHint').textContent = health.length
    ? (healthy === health.length ? '全部健康运行' : (health.length - healthy) + ' 个异常待处理')
    : '暂无启用出口节点';

  const ups = st.upstreams || {};
  let totalReq = 0, totalDur = 0;
  Object.values(ups).forEach(u => { totalReq += u.requests || 0; totalDur += u.totalDurationMs || 0; });
  const avg = totalReq ? (totalDur / totalReq) : 0;
  document.getElementById('ovLatency').innerHTML = (avg / 1000).toFixed(1) + '<small>s</small>';
  document.getElementById('ovLatencyHint').textContent = totalReq ? (totalReq + ' 个代理请求统计') : '暂无代理请求样本';

  const hw = document.getElementById('ovHealthWrap');
  if (!health.length) { hw.innerHTML = '<div class="empty-tip">暂无出口节点配置</div>'; }
  else {
    hw.innerHTML = '<table><thead><tr><th>名称</th><th>状态</th><th>请求数</th><th>成功率</th><th>平均延迟</th></tr></thead><tbody>' +
      health.map(h => {
        const u = ups[h.name] || {};
        const rate = u.requests ? ((u.success / u.requests) * 100).toFixed(1) + '%' : '-';
        const avgMs = u.averageDurationMs ? (u.averageDurationMs / 1000).toFixed(1) + 's' : '-';
        return '<tr>' +
          '<td><strong>' + esc(h.name) + '</strong></td>' +
          '<td><span class="badge ' + (h.healthy ? 'badge-green' : 'badge-red') + '"><span class="badge-dot"></span>' + (h.healthy ? '健康' : '异常') + '</span></td>' +
          '<td>' + (u.requests || 0) + '</td>' +
          '<td>' + rate + '</td>' +
          '<td>' + avgMs + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
  }

  const env = s.env || {};
  const info = [
    ['配置来源', s.configSource || '-'],
    ['本地端口', (s.localProxy?.host || '-') + ':' + (s.localProxy?.port || '-')],
    ['面板端口', (s.dashboard?.host || '-') + ':' + (s.dashboard?.port || '-')],
    ['日志级别', env.logLevel || '-'],
    ['日志保留', (env.logRetainDays || '-') + ' 天'],
    ['刷新周期', (env.configRefreshIntervalMinutes || '-') + ' 分钟'],
    ['远程配置', env.remoteConfigEnabled ? '已启用' : '未启用'],
    ['最后更新', st.updatedAt ? new Date(st.updatedAt).toLocaleString('zh-CN') : '-']
  ];
  document.getElementById('ovInfo').innerHTML = info.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');
}


// ---- Unsaved-changes tracker + APPLY 扫光 ----
function computeConfigDiff() {
  if (!cfg || !originalCfg) return { dirty: false, parts: [] };
  const parts = [];
  if (cfg.traffic_mode !== originalCfg.traffic_mode) parts.push('流量模式');
  if (cfg.balance_strategy !== originalCfg.balance_strategy) parts.push('负载策略');
  if (JSON.stringify(cfg.default_route || {}) !== JSON.stringify(originalCfg.default_route || {})) parts.push('默认路由');

  const oldUp = originalCfg.upstreams || [];
  const newUp = cfg.upstreams || [];
  if (JSON.stringify(newUp) !== JSON.stringify(oldUp)) {
    if (newUp.length !== oldUp.length) parts.push('出口节点 (' + oldUp.length + '→' + newUp.length + ')');
    else parts.push('出口节点');
  }

  const oldRul = originalCfg.rules || [];
  const newRul = cfg.rules || [];
  if (JSON.stringify(newRul) !== JSON.stringify(oldRul)) {
    if (newRul.length !== oldRul.length) parts.push('分流规则 (' + oldRul.length + '→' + newRul.length + ')');
    else parts.push('分流规则');
  }

  return { dirty: parts.length > 0, parts };
}

function updateApplyBar() {
  const bar = document.querySelector('.apply-bar');
  const text = document.querySelector('.apply-bar-text');
  const btn = document.getElementById('applyConfigBtn');
  if (!bar || !text || !btn) return;
  const { dirty, parts } = computeConfigDiff();
  if (dirty) {
    bar.classList.add('dirty');
    btn.classList.add('has-changes');
    text.innerHTML = '<span class="unsaved-badge">UNSAVED</span>待保存：<strong>' + esc(parts.join(' · ')) + '</strong> — 点 APPLY 生效并热重载。';
  } else {
    bar.classList.remove('dirty');
    btn.classList.remove('has-changes');
    text.innerHTML = '// 已同步。修改后点击 APPLY 保存到本地配置文件并热重载。';
  }
}

// ---- Traffic mode switcher ----
const MODE_HINTS = {
  rule: '命中规则 → 按规则处理；未命中 → 按「默认路由」处理。规则表中靠上的优先。',
  global: '所有流量都会走出口节点池（按负载策略挑选）。下方规则暂时不生效。',
  direct: '所有流量都直连，不走任何出口。下方规则暂时不生效；等同于临时关闭代理。',
};

function renderTrafficMode() {
  if (!cfg) return;
  const mode = cfg.traffic_mode || 'rule';
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = MODE_HINTS[mode] || MODE_HINTS.rule;
  const rulesCard = document.getElementById('rulesCard');
  if (rulesCard) rulesCard.classList.toggle('dimmed', mode !== 'rule');
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!cfg) return;
    cfg.traffic_mode = btn.dataset.mode;
    renderTrafficMode();
    updateApplyBar();
  });
});

// ---- Config ----
function renderConfig() {
  if (!cfg) return;
  document.getElementById('cfgStrategy').value = cfg.balance_strategy || 'round-robin';
  document.getElementById('cfgDefaultRoute').value = cfg.default_route?.action || 'direct';
  renderTrafficMode();

  const ups = cfg.upstreams || [];
  const upBody = document.getElementById('upstreamBody');
  upBody.innerHTML = '';
  document.getElementById('upstreamTable').style.display = ups.length ? '' : 'none';
  document.getElementById('upstreamEmpty').style.display = ups.length ? 'none' : '';
  ups.forEach((u, i) => {
    let proto = '-'; try { proto = new URL(u.url).protocol.replace(':', ''); } catch {}
    const tr = document.createElement('tr');
    const viaTag = u.via
      ? ' <span class="badge badge-purple" title="单独 via: ' + esc(maskUrl(u.via)) + '">via</span>'
      : '';
    const exp = describeExpiry(u.expiresAt);
    const expTag = exp.badgeCls
      ? ' <span class="badge ' + exp.badgeCls + '" title="' + esc(exp.tooltip) + '">' + esc(exp.short) + '</span>'
      : '';
    const noteTag = u.note
      ? ' <span class="badge badge-gray" title="' + esc(u.note) + '">备注</span>'
      : '';
    const vendorTag = u.vendorUrl
      ? ' <a href="' + esc(u.vendorUrl) + '" target="_blank" rel="noopener" class="badge badge-blue" title="前往续费：' + esc(u.vendorUrl) + '">续费 ↗</a>'
      : '';
    const latency = upstreamLatency[u.name];
    let latencyCell;
    if (!latency) {
      latencyCell = '<span style="color:var(--text-3);font-size:11px">—</span>';
    } else if (latency.pending) {
      latencyCell = '<span style="color:var(--cyan);font-size:11px;font-family:var(--mono)">测试中...</span>';
    } else if (latency.ok) {
      const ms = latency.latencyMs;
      const color = ms < 500 ? 'var(--green)' : ms < 1500 ? 'var(--yellow)' : 'var(--red)';
      latencyCell = '<span style="color:' + color + ';font-family:var(--mono);font-weight:700" title="出口 IP: ' + esc((latency.meta && latency.meta.ip) || latency.ip || '-') + '">' + ms + ' ms</span>';
    } else {
      latencyCell = '<span style="color:var(--red);font-size:11px;font-family:var(--mono)" title="' + esc(latency.error || '失败') + '">失败</span>';
    }
    tr.innerHTML =
      '<td><div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap"><strong>' + esc(u.name) + '</strong>' + viaTag + expTag + noteTag + vendorTag + '</div></td>' +
      '<td><span class="badge badge-blue">' + esc(proto) + '</span></td>' +
      '<td><span class="url-text" title="' + esc(maskUrl(u.url)) + '">' + esc(maskUrl(u.url)) + '</span></td>' +
      '<td title="加权策略下数字越大被选概率越大；轮询/随机策略下被忽略">' + u.weight + '</td>' +
      '<td>' + latencyCell + '</td>' +
      '<td><span class="badge ' + (u.enabled !== false ? 'badge-green' : 'badge-gray') + '"><span class="badge-dot"></span>' + (u.enabled !== false ? '启用' : '禁用') + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="testUpstreamLatency(&quot;' + esc(u.name) + '&quot;)">⚡ 测</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="editUpstream(' + i + ')">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="delUpstream(' + i + ')">删除</button>' +
      '</td>';
    upBody.appendChild(tr);
  });
  renderExpiryReminder();

  renderRulesUpstreamFilterOptions();
  renderRules();
  updateApplyBar();
}

function renderRulesUpstreamFilterOptions() {
  const sel = document.getElementById('ruleFilterUpstream');
  if (!sel) return;
  const current = sel.value;
  const names = (cfg?.upstreams || []).map(u => u.name);
  sel.innerHTML = '<option value="">全部出口</option>'
    + '<option value="__direct__">直连 / 无出口</option>'
    + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  sel.value = names.includes(current) || current === '__direct__' || current === '' ? current : '';
}

function getRuleGroups() {
  const set = new Set();
  (cfg?.rules || []).forEach(r => set.add((r.group || '默认').trim() || '默认'));
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
}

function renderRuleGroupOptions() {
  const sel = document.getElementById('ruleFilterGroup');
  const dl = document.getElementById('ruleGroupOptions');
  const groups = getRuleGroups();
  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">全部分组</option>'
      + groups.map(g => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('');
    sel.value = groups.includes(current) ? current : '';
  }
  if (dl) {
    dl.innerHTML = groups.map(g => '<option value="' + esc(g) + '"></option>').join('');
  }
}

function matchRuleFilter(r) {
  const f = ruleFilter;
  if (f.type && r.type !== f.type) return false;
  if (f.action && r.action !== f.action) return false;
  if (f.group && (r.group || '默认') !== f.group) return false;
  if (f.enabled === 'on' && r.enabled === false) return false;
  if (f.enabled === 'off' && r.enabled !== false) return false;
  if (f.upstream) {
    const ups = r.upstreams || [];
    if (f.upstream === '__direct__') {
      if (ups.length) return false;
    } else if (!ups.includes(f.upstream)) {
      return false;
    }
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = [r.value, r.type, r.action, r.group || '', (r.upstreams || []).join(',')].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderRules() {
  renderRuleGroupOptions();
  const rules = cfg?.rules || [];
  const filtered = rules.map((r, i) => ({ r, i })).filter(x => matchRuleFilter(x.r));
  const total = filtered.length;
  const pageSize = ruleFilter.pageSize > 0 ? ruleFilter.pageSize : 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (ruleFilter.page > totalPages) ruleFilter.page = totalPages;
  if (ruleFilter.page < 1) ruleFilter.page = 1;
  const start = (ruleFilter.page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  const rb = document.getElementById('rulesBody');
  const table = document.getElementById('rulesTable');
  const empty = document.getElementById('rulesEmpty');
  const pager = document.getElementById('rulesPager');
  const pagerMeta = document.getElementById('rulesPagerMeta');
  const pagerPage = document.getElementById('rulesPagerPage');

  rb.innerHTML = '';
  if (!rules.length) {
    table.style.display = 'none';
    empty.style.display = '';
    empty.textContent = '暂无规则，点击「添加」新建';
    pager.style.display = 'none';
    return;
  }
  if (!total) {
    table.style.display = 'none';
    empty.style.display = '';
    empty.textContent = '当前筛选条件下没有匹配的规则';
    pager.style.display = 'none';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';
  pageRows.forEach(({ r, i }) => {
    const tr = document.createElement('tr');
    const enabled = r.enabled !== false;
    const group = r.group || '默认';
    tr.style.opacity = enabled ? '1' : '0.5';
    tr.innerHTML =
      '<td style="color:var(--text-3);font-size:12px">' + (i + 1) + '</td>' +
      '<td><label class="toggle" style="width:36px;height:18px"><input type="checkbox"' + (enabled ? ' checked' : '') + ' onchange="toggleRuleEnabled(' + i + ')" /><span class="toggle-slider"></span></label></td>' +
      '<td><span class="badge badge-blue" style="max-width:160px;overflow:hidden;text-overflow:ellipsis" title="' + esc(group) + '">' + esc(group) + '</span></td>' +
      '<td><span class="badge badge-purple">' + esc(r.type) + '</span></td>' +
      '<td><code>' + esc(r.value) + '</code></td>' +
      '<td><span class="badge ' + (r.action === 'proxy' ? 'badge-amber' : 'badge-gray') + '">' + esc(r.action) + '</span></td>' +
      '<td style="font-size:12px;color:var(--text-2)">' + ((r.upstreams || []).join(', ') || '<span style="color:var(--text-3)">池选</span>') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="editRule(' + i + ')">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="delRule(' + i + ')">删除</button>' +
      '</td>';
    rb.appendChild(tr);
  });

  pager.style.display = total > pageSize ? '' : 'none';
  pagerMeta.textContent = '共 ' + total + ' 条（总规则 ' + rules.length + '）';
  pagerPage.textContent = ruleFilter.page + ' / ' + totalPages;
  document.getElementById('rulesPagerPrev').disabled = ruleFilter.page <= 1;
  document.getElementById('rulesPagerNext').disabled = ruleFilter.page >= totalPages;
}


async function loadEnvSettings() {
  try {
    envSettings = await api('/env-settings');
    renderEnvSettings();
  } catch (e) {
    toast('加载环境代理失败：' + e.message, 'error');
  }
}

document.getElementById('refreshSystemProxyBtn').addEventListener('click', async () => {
  await loadSystemProxyStatus();
  toast('系统代理状态已刷新');
});

document.getElementById('enableSystemProxyBtn').addEventListener('click', async () => {
  await applySystemProxyAction('enable', 'enableSystemProxyBtn', '开启中...', '系统代理已切换到 Roo 本地入口');
});

document.getElementById('disableSystemProxyBtn').addEventListener('click', async () => {
  await applySystemProxyAction('disable', 'disableSystemProxyBtn', '关闭中...', '系统代理接管已关闭');
});

document.getElementById('restoreSystemProxyBtn').addEventListener('click', async () => {
  await applySystemProxyAction('restore', 'restoreSystemProxyBtn', '恢复中...', '系统代理已恢复到接管前状态');
});

document.getElementById('applyEnvBtn').addEventListener('click', async () => {
  const btn = document.getElementById('applyEnvBtn');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    envSettings = await api('/env-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        HTTP_PROXY: document.getElementById('envHttpProxy').value.trim(),
        HTTPS_PROXY: document.getElementById('envHttpsProxy').value.trim(),
        ALL_PROXY: document.getElementById('envAllProxy').value.trim(),
        NO_PROXY: document.getElementById('envNoProxy').value.trim(),
      }),
    });
    renderEnvSettings();
    toast('前置跳板已保存到 .env，并已更新当前 Roo 进程');
    loadOverview();
  } catch (e) {
    toast('保存前置跳板失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存前置跳板';
  }
});

document.getElementById('envQuickSameBtn').addEventListener('click', () => {
  const v = document.getElementById('envHttpProxy').value.trim();
  if (!v) { toast('先在 HTTP 行填一个代理地址，再点一键同步', 'error'); return; }
  document.getElementById('envHttpsProxy').value = v;
  // ALL_PROXY 习惯用 socks5://，如果 HTTP 是 http:// 开头，智能替换
  const allVal = document.getElementById('envAllProxy').value.trim();
  if (!allVal) {
    document.getElementById('envAllProxy').value = v.replace(/^https?:\\/\\//, 'socks5://');
  }
  toast('已把 HTTP 同步到 HTTPS / ALL');
});

document.getElementById('envClearAllBtn').addEventListener('click', () => {
  ['envHttpProxy','envHttpsProxy','envAllProxy','envNoProxy'].forEach(id => document.getElementById(id).value = '');
  toast('已清空全部字段（未保存，点「保存前置跳板」才生效）');
});

document.getElementById('resetEnvBtn').addEventListener('click', async () => {
  try {
    envSettings = await api('/env-settings');
    renderEnvSettings();
    toast('已恢复为当前生效的前置跳板配置');
  } catch (e) {
    toast('重置前置跳板失败：' + e.message, 'error');
  }
});

function renderUpViaGroup() {
  const group = document.getElementById('upViaGroup');
  const btn = document.getElementById('toggleUpViaBtn');
  if (!group || !btn) return;
  group.style.display = upViaExpanded ? '' : 'none';
  btn.textContent = upViaExpanded ? '收起高级设置：单独 via' : '高级设置：单独 via';
}

document.getElementById('toggleUpViaBtn').addEventListener('click', () => {
  upViaExpanded = !upViaExpanded;
  renderUpViaGroup();
});

document.getElementById('cfgStrategy').addEventListener('change', e => { if (cfg) { cfg.balance_strategy = e.target.value; updateApplyBar(); } });
document.getElementById('cfgDefaultRoute').addEventListener('change', e => { if (cfg) { cfg.default_route = { action: e.target.value, upstreams: [] }; updateApplyBar(); } });

// ---- Rule filter / pagination ----
function bindRuleFilterEvents() {
  const search = document.getElementById('ruleFilterSearch');
  const typeSel = document.getElementById('ruleFilterType');
  const actionSel = document.getElementById('ruleFilterAction');
  const upstreamSel = document.getElementById('ruleFilterUpstream');
  const pageSizeSel = document.getElementById('ruleFilterPageSize');
  const reset = document.getElementById('ruleFilterReset');
  const prev = document.getElementById('rulesPagerPrev');
  const next = document.getElementById('rulesPagerNext');

  let searchTimer = null;
  search.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ruleFilter.search = e.target.value.trim();
      ruleFilter.page = 1;
      renderRules();
    }, 120);
  });
  typeSel.addEventListener('change', (e) => { ruleFilter.type = e.target.value; ruleFilter.page = 1; renderRules(); });
  actionSel.addEventListener('change', (e) => { ruleFilter.action = e.target.value; ruleFilter.page = 1; renderRules(); });
  upstreamSel.addEventListener('change', (e) => { ruleFilter.upstream = e.target.value; ruleFilter.page = 1; renderRules(); });
  pageSizeSel.addEventListener('change', (e) => { ruleFilter.pageSize = parseInt(e.target.value, 10) || 20; ruleFilter.page = 1; renderRules(); });
  const groupSel = document.getElementById('ruleFilterGroup');
  const enabledSel = document.getElementById('ruleFilterEnabled');
  if (groupSel) groupSel.addEventListener('change', (e) => { ruleFilter.group = e.target.value; ruleFilter.page = 1; renderRules(); });
  if (enabledSel) enabledSel.addEventListener('change', (e) => { ruleFilter.enabled = e.target.value; ruleFilter.page = 1; renderRules(); });
  reset.addEventListener('click', () => {
    ruleFilter.search = '';
    ruleFilter.type = '';
    ruleFilter.action = '';
    ruleFilter.upstream = '';
    ruleFilter.group = '';
    ruleFilter.enabled = '';
    ruleFilter.page = 1;
    search.value = '';
    typeSel.value = '';
    actionSel.value = '';
    upstreamSel.value = '';
    if (groupSel) groupSel.value = '';
    if (enabledSel) enabledSel.value = '';
    renderRules();
  });
  prev.addEventListener('click', () => { if (ruleFilter.page > 1) { ruleFilter.page--; renderRules(); } });
  next.addEventListener('click', () => { ruleFilter.page++; renderRules(); });
}
bindRuleFilterEvents();

// ---- Upstream CRUD ----

document.getElementById('addUpstreamBtn').addEventListener('click', () => {
  editUpIdx = -1;
  upViaExpanded = false;
  renderUpViaGroup();
  document.getElementById('upstreamModalTitle').textContent = '添加出口节点';
  document.getElementById('upName').value = '';
  document.getElementById('upUrl').value = '';
  document.getElementById('upVia').value = '';
  document.getElementById('upWeight').value = '1';
  document.getElementById('upNote').value = '';
  document.getElementById('upExpiresAt').value = '';
  document.getElementById('upVendorUrl').value = '';
  document.getElementById('upEnabled').checked = true;
  document.getElementById('upstreamModal').classList.add('open');
});

window.editUpstream = i => {
  editUpIdx = i;
  const u = cfg.upstreams[i];
  upViaExpanded = Boolean(u.via);
  renderUpViaGroup();
  document.getElementById('upstreamModalTitle').textContent = '编辑出口节点';
  document.getElementById('upName').value = u.name;
  document.getElementById('upUrl').value = u.url;
  document.getElementById('upVia').value = u.via || '';
  document.getElementById('upWeight').value = u.weight;
  document.getElementById('upNote').value = u.note || '';
  document.getElementById('upExpiresAt').value = isoToDateInput(u.expiresAt);
  document.getElementById('upVendorUrl').value = u.vendorUrl || '';
  document.getElementById('upEnabled').checked = u.enabled !== false;
  document.getElementById('upstreamModal').classList.add('open');
};

window.testUpstreamLatency = async (name) => {
  if (!name) return;
  upstreamLatency[name] = { pending: true };
  renderConfig();
  try {
    const r = await api('/upstream-latency?name=' + encodeURIComponent(name));
    const hit = (r.results || []).find(x => x.name === name);
    if (hit) {
      upstreamLatency[name] = { pending: false, ok: hit.ok, latencyMs: hit.latencyMs, ip: hit.ip, meta: hit.meta, error: hit.error };
    } else {
      upstreamLatency[name] = { pending: false, ok: false, error: '节点未启用或已删除' };
    }
  } catch (e) {
    upstreamLatency[name] = { pending: false, ok: false, error: e.message };
  }
  renderConfig();
};

document.getElementById('latencyTestAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('latencyTestAllBtn');
  const names = (cfg?.upstreams || []).filter(u => u.enabled !== false).map(u => u.name);
  if (!names.length) { toast('没有启用中的出口节点可测', 'error'); return; }
  names.forEach(n => upstreamLatency[n] = { pending: true });
  renderConfig();
  btn.disabled = true; btn.textContent = '测试中...';
  try {
    const r = await api('/upstream-latency');
    (r.results || []).forEach((hit) => {
      upstreamLatency[hit.name] = { pending: false, ok: hit.ok, latencyMs: hit.latencyMs, ip: hit.ip, meta: hit.meta, error: hit.error };
    });
    toast('延时测试完成');
  } catch (e) {
    names.forEach(n => upstreamLatency[n] = { pending: false, ok: false, error: e.message });
    toast('延时测试失败：' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '⚡ 全部测延时';
    renderConfig();
  }
});

window.delUpstream = i => {
  if (!confirm('确认删除该出口节点？相关规则的引用也将清除。')) return;
  const name = cfg.upstreams[i].name;
  cfg.upstreams.splice(i, 1);
  cfg.rules.forEach(r => { r.upstreams = (r.upstreams || []).filter(n => n !== name); });
  renderConfig();
};

document.getElementById('upCancelBtn').addEventListener('click', () => document.getElementById('upstreamModal').classList.remove('open'));

document.getElementById('upSaveBtn').addEventListener('click', () => {
  const name = document.getElementById('upName').value.trim();
  const url = document.getElementById('upUrl').value.trim();
  const via = document.getElementById('upVia').value.trim();
  const weight = parseInt(document.getElementById('upWeight').value) || 1;
  const enabled = document.getElementById('upEnabled').checked;
  const note = document.getElementById('upNote').value.trim().slice(0, 200);
  const expiresAt = dateInputToIso(document.getElementById('upExpiresAt').value);
  const vendorUrl = document.getElementById('upVendorUrl').value.trim() || null;
  if (!name || !url) { toast('名称和 URL 不能为空', 'error'); return; }
  if (vendorUrl && !/^https?:\\/\\//i.test(vendorUrl)) {
    toast('购买官网必须以 http:// 或 https:// 开头', 'error');
    return;
  }
  const entry = { name, url, via: via || null, weight, enabled, note, expiresAt, vendorUrl };
  if (editUpIdx >= 0) {
    const oldName = cfg.upstreams[editUpIdx].name;
    cfg.upstreams[editUpIdx] = entry;
    if (oldName !== name) cfg.rules.forEach(r => { r.upstreams = (r.upstreams || []).map(n => n === oldName ? name : n); });
  } else {
    cfg.upstreams.push(entry);
  }
  document.getElementById('upstreamModal').classList.remove('open');
  renderConfig();
});

// ---- Rule CRUD ----
let editRuleIdx = -1;

function renderRuleUpstreams(selected) {
  const names = (cfg?.upstreams || []).map(u => u.name);
  const el = document.getElementById('ruleUpstreamCheckboxes');
  if (!names.length) { el.innerHTML = '<span style="font-size:13px;color:var(--text-3)">请先添加出口节点</span>'; return; }
  el.innerHTML = names.map(n =>
    '<label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;cursor:pointer">' +
    '<input type="checkbox" value="' + esc(n) + '"' + (selected.includes(n) ? ' checked' : '') + ' style="width:14px;height:14px">' +
    esc(n) + '</label>').join('');
}

document.getElementById('ruleAction').addEventListener('change', e => {
  document.getElementById('ruleUpstreamsGroup').style.display = e.target.value === 'proxy' ? '' : 'none';
});

document.getElementById('addRuleBtn').addEventListener('click', () => {
  editRuleIdx = -1;
  document.getElementById('ruleModalTitle').textContent = '添加分流规则';
  document.getElementById('ruleType').value = 'domain-suffix';
  document.getElementById('ruleValue').value = '';
  document.getElementById('ruleAction').value = 'proxy';
  document.getElementById('ruleGroup').value = '默认';
  document.getElementById('ruleEnabled').checked = true;
  document.getElementById('ruleUpstreamsGroup').style.display = '';
  renderRuleGroupOptions();
  renderRuleUpstreams([]);
  document.getElementById('ruleModal').classList.add('open');
});

window.editRule = i => {
  editRuleIdx = i;
  const r = cfg.rules[i];
  document.getElementById('ruleModalTitle').textContent = '编辑分流规则';
  document.getElementById('ruleType').value = r.type;
  document.getElementById('ruleValue').value = r.value;
  document.getElementById('ruleAction').value = r.action;
  document.getElementById('ruleGroup').value = r.group || '默认';
  document.getElementById('ruleEnabled').checked = r.enabled !== false;
  document.getElementById('ruleUpstreamsGroup').style.display = r.action === 'proxy' ? '' : 'none';
  renderRuleGroupOptions();
  renderRuleUpstreams(r.upstreams || []);
  document.getElementById('ruleModal').classList.add('open');
};

window.delRule = i => {
  if (!confirm('确认删除该规则？')) return;
  cfg.rules.splice(i, 1);
  renderConfig();
};

window.toggleRuleEnabled = i => {
  if (!cfg || !cfg.rules[i]) return;
  cfg.rules[i].enabled = cfg.rules[i].enabled === false ? true : false;
  renderRules();
};


document.getElementById('ruleCancelBtn').addEventListener('click', () => document.getElementById('ruleModal').classList.remove('open'));

// ---- Clash 风格规则批量导入 ----
let clashParseResult = null;

function parseClashRules(text) {
  const parsed = [];
  const skipped = [];
  const targets = new Set();
  const lines = String(text || '').split(/\\r?\\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\\/\\//.test(line) || /^#/.test(line)) continue;
    line = line.replace(/[,，]?\\s*$/, ''); // 去尾逗号
    line = line.replace(/^["']|["']$/g, ''); // 去外层引号
    const m = line.match(/^([A-Z][A-Z0-9\\-]*)\\s*[,，]\\s*(.+)$/);
    if (!m) { skipped.push({ line: raw, reason: '无法解析' }); continue; }
    const kind = m[1].toUpperCase();
    let rest = m[2].replace(/["']$/g, '').replace(/^["']/, '');
    rest = rest.replace(/\\s*,\\s*no-resolve\\s*$/i, '');
    const parts = rest.split(/\\s*,\\s*/);
    const value = (parts[0] || '').trim();
    const target = (parts[1] || '').trim();
    if (!value || !target) { skipped.push({ line: raw, reason: '缺少字段' }); continue; }
    let type;
    if (kind === 'DOMAIN') type = 'domain-exact';
    else if (kind === 'DOMAIN-SUFFIX') type = 'domain-suffix';
    else if (kind === 'DOMAIN-KEYWORD') type = 'domain-keyword';
    else if (kind === 'IP-CIDR') type = value.includes(':') ? 'ipv6-cidr' : 'ipv4-cidr';
    else if (kind === 'IP-CIDR6') type = 'ipv6-cidr';
    else if (kind === 'GEOIP') type = 'geo-country';
    else if (kind === 'PROCESS-NAME' || kind === 'PROCESS-PATH') { skipped.push({ line: raw, reason: 'Roo 不支持 PROCESS-*（纯网络代理看不到进程）' }); continue; }
    else if (kind === 'MATCH' || kind === 'FINAL') { skipped.push({ line: raw, reason: '跳过 MATCH/FINAL（用 CHAIN tab 的默认路由替代）' }); continue; }
    else { skipped.push({ line: raw, reason: '暂不支持类型：' + kind }); continue; }
    parsed.push({ type, value, target });
    targets.add(target);
  }
  return { parsed, skipped, targets: Array.from(targets) };
}

function openClashImport() {
  document.getElementById('clashInput').value = '';
  document.getElementById('clashImportGroup').value = '导入';
  document.getElementById('clashMappingGroup').style.display = 'none';
  document.getElementById('clashPreviewGroup').style.display = 'none';
  document.getElementById('clashImportBtn').disabled = true;
  document.getElementById('clashImportCount').textContent = '0';
  clashParseResult = null;
  document.getElementById('clashImportModal').classList.add('open');
}

function renderClashPreview(result) {
  const mapWrap = document.getElementById('clashMappingGroup');
  const mapList = document.getElementById('clashMappingList');
  const preWrap = document.getElementById('clashPreviewGroup');
  const preList = document.getElementById('clashPreviewList');
  const skipCount = document.getElementById('clashSkipCount');
  const preCount = document.getElementById('clashPreviewCount');
  const impBtn = document.getElementById('clashImportBtn');
  const impCount = document.getElementById('clashImportCount');

  const upstreams = (cfg?.upstreams || []).map(u => u.name);
  const BUILTINS = new Set(['DIRECT','REJECT','PROXY','GLOBAL']);
  const custom = result.targets.filter(t => !BUILTINS.has(t.toUpperCase()));

  if (custom.length) {
    mapWrap.style.display = '';
    mapList.innerHTML = custom.map(t => {
      const autoPick = upstreams.includes(t) ? ('up:' + t) : 'pool';
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--panel-2)">'
        + '<code style="flex:1;background:transparent;border:none;color:var(--magenta)">' + esc(t) + '</code>'
        + '<span style="color:var(--text-3);font-size:11.5px">→</span>'
        + '<select class="form-control" data-target="' + esc(t) + '" style="width:280px;height:32px;padding:5px 8px;font-size:12px">'
        + '<option value="pool"' + (autoPick==='pool'?' selected':'') + '>走出口池（按策略挑选）</option>'
        + '<option value="direct">直连（DIRECT）</option>'
        + '<option value="skip">跳过不导入</option>'
        + upstreams.map(n => '<option value="up:' + esc(n) + '"' + (autoPick==='up:'+n?' selected':'') + '>出口：' + esc(n) + '</option>').join('')
        + '</select>'
        + '</div>';
    }).join('');
  } else {
    mapWrap.style.display = 'none';
  }

  preWrap.style.display = '';
  preCount.textContent = String(result.parsed.length);
  skipCount.textContent = String(result.skipped.length);
  const head = result.parsed.slice(0, 30).map(r =>
    '<div>' + esc(r.type).padEnd(16) + ' &nbsp; ' + esc(r.value) + '  <span style="color:var(--cyan)">→</span>  <span style="color:var(--magenta)">' + esc(r.target) + '</span></div>'
  ).join('');
  const more = result.parsed.length > 30 ? '<div style="color:var(--text-3);margin-top:6px">... 及另外 ' + (result.parsed.length - 30) + ' 条</div>' : '';
  const skippedInfo = result.skipped.length
    ? '<div style="margin-top:10px;color:var(--yellow)">// 跳过 ' + result.skipped.length + ' 行：'
      + result.skipped.slice(0, 5).map(s => esc(s.reason)).join('；') + (result.skipped.length > 5 ? '…' : '') + '</div>'
    : '';
  preList.innerHTML = head + more + skippedInfo;

  impBtn.disabled = result.parsed.length === 0;
  impCount.textContent = String(result.parsed.length);
}

document.getElementById('clashImportOpenBtn').addEventListener('click', openClashImport);
document.getElementById('clashCancelBtn').addEventListener('click', () => document.getElementById('clashImportModal').classList.remove('open'));
document.getElementById('clashParseBtn').addEventListener('click', () => {
  const text = document.getElementById('clashInput').value;
  clashParseResult = parseClashRules(text);
  renderClashPreview(clashParseResult);
});
document.getElementById('clashImportBtn').addEventListener('click', () => {
  if (!clashParseResult || !clashParseResult.parsed.length) return;
  const groupName = (document.getElementById('clashImportGroup').value.trim() || '导入').slice(0, 60);
  const position = document.getElementById('clashImportPosition').value;

  const userMap = {};
  document.querySelectorAll('#clashMappingList select').forEach(sel => { userMap[sel.dataset.target] = sel.value; });
  const BUILT = { DIRECT: 'direct', REJECT: 'skip', PROXY: 'pool', GLOBAL: 'pool' };

  const newRules = [];
  for (const r of clashParseResult.parsed) {
    const mapKey = userMap[r.target] ?? BUILT[r.target.toUpperCase()] ?? 'pool';
    if (mapKey === 'skip') continue;
    let rule;
    if (mapKey === 'direct') rule = { type: r.type, value: r.value, action: 'direct', upstreams: [], group: groupName, enabled: true };
    else if (mapKey === 'pool') rule = { type: r.type, value: r.value, action: 'proxy', upstreams: [], group: groupName, enabled: true };
    else if (mapKey.startsWith('up:')) rule = { type: r.type, value: r.value, action: 'proxy', upstreams: [mapKey.slice(3)], group: groupName, enabled: true };
    else continue;
    newRules.push(rule);
  }

  if (!cfg.rules) cfg.rules = [];
  cfg.rules = position === 'prepend' ? [...newRules, ...cfg.rules] : [...cfg.rules, ...newRules];

  document.getElementById('clashImportModal').classList.remove('open');
  toast('已导入 ' + newRules.length + ' 条规则到分组「' + groupName + '」，别忘了 APPLY 生效');
  renderConfig();
});

document.getElementById('ruleSaveBtn').addEventListener('click', () => {
  const type = document.getElementById('ruleType').value;
  const value = document.getElementById('ruleValue').value.trim();
  const action = document.getElementById('ruleAction').value;
  const group = (document.getElementById('ruleGroup').value.trim() || '默认').slice(0, 60);
  const enabled = document.getElementById('ruleEnabled').checked;
  const upstreams = [...document.querySelectorAll('#ruleUpstreamCheckboxes input:checked')].map(el => el.value);
  if (!value) { toast('匹配值不能为空', 'error'); return; }
  const rule = { type, value, action, upstreams, group, enabled };
  if (editRuleIdx >= 0) cfg.rules[editRuleIdx] = rule; else cfg.rules.push(rule);
  document.getElementById('ruleModal').classList.remove('open');
  renderConfig();
});

document.getElementById('applyConfigBtn').addEventListener('click', async () => {
  const btn = document.getElementById('applyConfigBtn');
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存中...';
  btn.classList.remove('has-changes');
  try {
    const result = await api('/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    originalCfg = JSON.parse(JSON.stringify(result.config || cfg));
    cfg = JSON.parse(JSON.stringify(originalCfg));
    renderConfig();
    toast('配置已保存并应用！');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel || '✓ APPLY';
    updateApplyBar();
  }
});

document.getElementById('exportConfigBtn').addEventListener('click', async () => {
  const btn = document.getElementById('exportConfigBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中...';
  try {
    const currentConfig = await api('/config');
    downloadConfig(currentConfig);
    toast('当前配置已导出');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById('importConfigBtn').addEventListener('click', () => {
  document.getElementById('configImportInput').click();
});

document.getElementById('configImportInput').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!confirm('导入配置会覆盖当前未保存的修改，并立即保存生效。确认继续？')) {
    event.target.value = '';
    return;
  }

  const btn = document.getElementById('importConfigBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导入中...';

  try {
    const raw = await file.text();
    let importedConfig;
    try {
      importedConfig = JSON.parse(raw);
    } catch {
      throw new Error('文件不是合法 JSON');
    }

    const result = await api('/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importedConfig)
    });
    originalCfg = JSON.parse(JSON.stringify(result.config || importedConfig));
    cfg = JSON.parse(JSON.stringify(originalCfg));
    renderConfig();
    toast('配置已导入并应用：' + file.name);
  } catch (e) {
    toast('导入失败：' + e.message, 'error');
  } finally {
    event.target.value = '';
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById('resetConfigBtn').addEventListener('click', () => {
  if (!originalCfg) return;
  if (!confirm('确认重置为上次保存的配置？')) return;
  cfg = JSON.parse(JSON.stringify(originalCfg));
  renderConfig();
  toast('已重置为上次保存的配置');
});

// ---- Logs ----
async function loadLogs() {
  try {
    const limitSel = document.getElementById('logsLimit');
    const limit = limitSel ? (parseInt(limitSel.value, 10) || 50) : 50;
    const logs = await api('/logs?n=' + limit);
    const box = document.getElementById('logsList');
    if (!logs.length) { box.innerHTML = '<div class="empty-tip">暂无日志</div>'; return; }
    box.innerHTML = '<table><thead><tr><th style="width:150px">时间</th><th style="width:70px">类型</th><th>内容</th><th style="width:90px">状态</th><th style="width:90px">耗时</th></tr></thead><tbody>' +
      logs.map(l => {
        const t = l.time ? new Date(l.time).toLocaleTimeString('zh-CN') : '-';
        const type = l.type || l.level || '-';
        const typeClass = l.type === 'access'
          ? 'badge-purple'
          : ({ error: 'badge-red', warn: 'badge-amber', info: 'badge-blue', debug: 'badge-gray' }[l.level] || 'badge-gray');
        const statusText = l.type === 'access'
          ? (l.status || '-')
          : (l.level || '-');
        const statusClass = l.type === 'access'
          ? (l.status === 'success' ? 'badge-green' : l.status === 'failed' ? 'badge-red' : 'badge-gray')
          : ({ error: 'badge-red', warn: 'badge-amber', info: 'badge-blue', debug: 'badge-gray' }[l.level] || 'badge-gray');
        const duration = l.type === 'access' && l.durationMs != null
          ? (l.durationMs >= 1000 ? (l.durationMs / 1000).toFixed(1) + 's' : l.durationMs + 'ms')
          : '-';
        const content = l.type === 'access'
          ? '<div><strong>' + esc(l.hostname || '-') + '</strong></div>' +
            '<div style="font-size:12px;color:var(--text-3);margin-top:2px">' +
            '路由: ' + esc(l.rule || '默认') + ' · ' +
            '出口节点: ' + esc(l.upstream || (l.isDirect ? '直连' : '-')) +
            (l.error ? ' · 错误: ' + esc(l.error) : '') +
            '</div>'
          : '<div><strong>' + esc(l.message || l.raw || '-') + '</strong></div>' +
            '<div style="font-size:12px;color:var(--text-3);margin-top:2px">' +
            esc(JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !['time', 'level', 'message', 'type', 'raw'].includes(k))))) +
            '</div>';
        return '<tr>' +
          '<td style="font-family:monospace;font-size:12px;color:var(--text-2)">' + esc(t) + '</td>' +
          '<td><span class="badge ' + typeClass + '">' + esc(type) + '</span></td>' +
          '<td>' + content + '</td>' +
          '<td><span class="badge ' + statusClass + '">' + esc(statusText) + '</span></td>' +
          '<td style="font-family:monospace;font-size:12px;color:var(--text-2)">' + esc(duration) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
  } catch (e) {
    document.getElementById('logsList').innerHTML = '<div class="empty-tip">加载失败：' + esc(e.message) + '</div>';
  }
}
document.getElementById('refreshLogsBtn').addEventListener('click', loadLogs);
document.getElementById('logsLimit').addEventListener('change', loadLogs);

document.getElementById('reloadRulesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('reloadRulesBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重新拉取中...';

  try {
    await api('/reload', { method: 'POST' });
    toast('规则已重新拉取，正在刷新概览');
    await loadOverview();
    cfg = await api('/config');
    originalCfg = JSON.parse(JSON.stringify(cfg));
    renderConfig();
  } catch (e) {
    toast('重载失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

async function init() {
  loadOverview();
  try {
    envSettings = await api('/env-settings');
    renderEnvSettings();
  } catch (e) {
    toast('加载前置跳板失败：' + e.message, 'error');
  }
  await loadSystemProxyStatus();
  try {
    cfg = await api('/config');
    originalCfg = JSON.parse(JSON.stringify(cfg));
    renderConfig();
  } catch (e) {
    toast('加载配置失败：' + e.message, 'error');
  }
  renderUpViaGroup();
  loadLogs();
}

init();
setInterval(loadOverview, 15000);
setInterval(loadLogs, 30000);
</script>
</body>
</html>`;
}

function createDashboard(options = {}) {
  const app = express();
  const host = options.host || '127.0.0.1';
  const port = options.port;
  const configManager = options.configManager;
  const balancer = options.balancer;
  const chainManager = options.chainManager;
  const stats = options.stats;
  const logger = options.logger;
  const logsDir = options.logsDir;
  const getStatus = options.getStatus;

  app.use(express.json());

  app.get('/', (req, res) => {
    res.type('html').send(renderHtml());
  });

  app.get('/status', (req, res) => {
    res.json(getStatus());
  });

  app.get('/stats', (req, res) => {
    res.json(stats.getStats());
  });

  app.get('/logs', async (req, res) => {
    const limit = Math.max(Number.parseInt(req.query.n, 10) || 100, 1);
    const logs = await readRecentLogs(logsDir, limit);
    res.json(logs);
  });

  app.get('/config', (req, res) => {
    res.json(configManager.getConfig());
  });

  app.get('/network-diagnostics', async (req, res) => {
    try {
      const diagnostics = await getNetworkDiagnostics(configManager.settings.localPort, balancer, chainManager);
      res.json(diagnostics);
    } catch (error) {
      res.status(500).json({ message: error.message || '获取网络诊断失败' });
    }
  });

  app.get('/upstream-latency', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      const envProxy = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
      const enabled = balancer && typeof balancer.getEnabledUpstreams === 'function'
        ? balancer.getEnabledUpstreams()
        : [];
      const targets = name ? enabled.filter((u) => u.name === name) : enabled;
      const results = await Promise.all(targets.map(async (u) => {
        const t0 = Date.now();
        const probe = await probeUpstreamConnectivity(u, chainManager, envProxy);
        return {
          name: u.name,
          ok: probe.ok,
          latencyMs: Date.now() - t0,
          ip: probe.ip,
          meta: probe.meta,
          error: probe.error,
        };
      }));
      res.json({ results });
    } catch (error) {
      res.status(500).json({ message: error.message || '延时测试失败' });
    }
  });

  app.get('/env-settings', async (req, res) => {
    try {
      const settings = await readEffectiveEnvSettings();
      res.json(settings);
    } catch (error) {
      res.status(500).json({ message: error.message || '读取前置跳板失败' });
    }
  });

  app.get('/system-proxy', async (req, res) => {
    try {
      const status = await getSystemProxyStatus(configManager.settings);
      res.json(status);
    } catch (error) {
      res.status(400).json({ message: error.message || '读取系统代理状态失败' });
    }
  });

  app.post('/system-proxy/enable', async (req, res) => {
    try {
      const status = await enableSystemProxy(configManager.settings, {
        service: req.body && req.body.service ? String(req.body.service).trim() : undefined,
      });
      res.json(status);
    } catch (error) {
      res.status(400).json({ message: error.message || '开启系统代理接管失败' });
    }
  });

  app.post('/system-proxy/disable', async (req, res) => {
    try {
      const status = await disableSystemProxy(configManager.settings, {
        service: req.body && req.body.service ? String(req.body.service).trim() : undefined,
      });
      res.json(status);
    } catch (error) {
      res.status(400).json({ message: error.message || '关闭系统代理接管失败' });
    }
  });

  app.post('/system-proxy/restore', async (req, res) => {
    try {
      const status = await restoreSystemProxy(configManager.settings, {
        service: req.body && req.body.service ? String(req.body.service).trim() : undefined,
      });
      res.json(status);
    } catch (error) {
      res.status(400).json({ message: error.message || '恢复系统代理失败' });
    }
  });

  app.post('/env-settings', async (req, res) => {
    try {
      const nextValues = {
        HTTP_PROXY: req.body.HTTP_PROXY || '',
        HTTPS_PROXY: req.body.HTTPS_PROXY || '',
        ALL_PROXY: req.body.ALL_PROXY || '',
        NO_PROXY: req.body.NO_PROXY || '',
      };
      const saved = await writeEnvSettings(nextValues);
      applyEnvToProcess(saved.values);
      res.json({ file: saved.values, effective: saved.values, message: '前置跳板已保存' });
    } catch (error) {
      res.status(400).json({ message: error.message || '保存前置跳板失败' });
    }
  });

  app.post('/config', async (req, res) => {
    try {
      await updateActiveConfig(() => req.body, configManager.settings);
      const reloaded = await configManager.reloadConfig('dashboard');
      balancer.updateConfig(reloaded);
      res.json({ ok: true, config: reloaded });
    } catch (error) {
      await logger.error('Dashboard 保存配置失败', { error: error.message });
      res.status(400).json({ ok: false, message: error.message });
    }
  });

  app.post('/reload', async (req, res) => {
    try {
      const config = await configManager.reloadConfig('dashboard');
      balancer.updateConfig(config);
      res.json({ ok: true, message: '规则已重新拉取', config });
    } catch (error) {
      await logger.error('Dashboard 触发重载失败', { error: error.message });
      res.status(500).json({ ok: false, message: `重新拉取失败：${error.message}` });
    }
  });

  let httpServer = null;

  return {
    async listen() {
      await new Promise((resolve) => {
        httpServer = app.listen(port, host, resolve);
      });
      await logger.info(`Dashboard 已启动，监听 ${host}:${port}`);
    },
    async close() {
      if (!httpServer) {
        return;
      }
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

module.exports = {
  createDashboard,
};
