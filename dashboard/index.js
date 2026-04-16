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

async function getNetworkDiagnostics(localProxyPort, balancer, chainManager) {
  const envProxy = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;

  const [directIpResult, envProxyIpResult, rooRouteIpResult] = await Promise.allSettled([
    fetchIpByCurl(['-s', '--noproxy', '*', 'https://api.ip.sb/ip']),
    envProxy ? fetchIpByCurl(['-s', 'https://api.ip.sb/ip']) : Promise.resolve(null),
    fetchIpByCurl(['-s', '--proxy', `http://127.0.0.1:${localProxyPort}`, 'https://api.ip.sb/ip']),
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

  let routeHint;
  if (upstreamCheckSummary.failed > 0) {
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
      --bg:#f7f8fc;
      --panel:#ffffff;
      --text:#0f172a;
      --text-2:#475569;
      --text-3:#94a3b8;
      --border:#e5e7eb;
      --border-soft:#f1f5f9;
      --primary:#2563eb;
      --primary-hover:#1d4ed8;
      --primary-soft:#eff6ff;
      --green:#10b981;
      --green-soft:#ecfdf5;
      --red:#ef4444;
      --red-soft:#fef2f2;
      --amber:#f59e0b;
      --amber-soft:#fffbeb;
      --purple:#8b5cf6;
      --purple-soft:#f5f3ff;
      --shadow-sm:0 1px 2px rgba(15,23,42,.05);
      --shadow:0 1px 3px rgba(15,23,42,.06),0 1px 2px rgba(15,23,42,.04);
      --shadow-lg:0 10px 25px -5px rgba(15,23,42,.08),0 8px 10px -6px rgba(15,23,42,.05);
      --radius:10px;
      --radius-lg:14px;
    }

    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
      background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;
      display:flex;overflow:hidden;-webkit-font-smoothing:antialiased}

    /* ---- Sidebar ---- */
    .sidebar{width:232px;background:#0b1120;color:#cbd5e1;display:flex;flex-direction:column;flex-shrink:0;
      background-image:linear-gradient(180deg,#0b1120 0%,#0f172a 100%)}
    .brand{padding:22px 20px;border-bottom:1px solid rgba(148,163,184,.08);display:flex;align-items:center;gap:10px}
    .brand-logo{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#2563eb,#8b5cf6);
      display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;
      box-shadow:0 4px 12px rgba(37,99,235,.35)}
    .brand-text{font-size:15px;font-weight:700;color:#f1f5f9;letter-spacing:.3px}
    .brand-sub{font-size:11px;color:#64748b;margin-top:2px;letter-spacing:.5px;text-transform:uppercase}
    .sidebar-nav{flex:1;padding:14px 10px}
    .nav-item{display:flex;align-items:center;gap:12px;padding:10px 12px;cursor:pointer;font-size:13.5px;
      color:#94a3b8;border-radius:8px;margin-bottom:2px;transition:all .15s;font-weight:500}
    .nav-item:hover{background:rgba(148,163,184,.08);color:#e2e8f0}
    .nav-item.active{background:linear-gradient(135deg,rgba(37,99,235,.25),rgba(139,92,246,.15));color:#fff}
    .nav-item.active .ni-ico{color:#60a5fa}
    .ni-ico{width:18px;height:18px;flex-shrink:0;color:#64748b;transition:color .15s}
    .sidebar-footer{padding:14px 20px;border-top:1px solid rgba(148,163,184,.08);font-size:11px;color:#475569;display:flex;align-items:center;gap:8px}
    .pulse{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(16,185,129,.55);animation:pulse 2s infinite}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.55)}70%{box-shadow:0 0 0 8px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}

    /* ---- Main ---- */
    .main{flex:1;display:flex;flex-direction:column;overflow:hidden}
    .topbar{background:var(--panel);padding:14px 28px;border-bottom:1px solid var(--border);
      display:flex;align-items:center;justify-content:space-between}
    .page-title{font-size:17px;font-weight:700;color:var(--text);letter-spacing:-.01em}
    .page-sub{font-size:12.5px;color:var(--text-3);margin-top:2px}
    .content{flex:1;overflow-y:auto;padding:24px 28px 32px}

    /* ---- Pages ---- */
    .page{display:none}
    .page.active{display:block}

    /* ---- Card ---- */
    .card{background:var(--panel);border-radius:var(--radius-lg);padding:20px;box-shadow:var(--shadow);
      border:1px solid var(--border-soft);margin-bottom:16px}
    .card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
    .card-title{font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
    .card-title .dot{width:4px;height:16px;background:var(--primary);border-radius:2px}

    /* ---- Stat cards ---- */
    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
    .stat{background:var(--panel);border-radius:var(--radius-lg);padding:18px;box-shadow:var(--shadow);
      border:1px solid var(--border-soft);position:relative;overflow:hidden}
    .stat-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
    .stat-label{font-size:12px;color:var(--text-2);font-weight:500;letter-spacing:.02em}
    .stat-ico{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center}
    .stat-ico svg{width:16px;height:16px}
    .ico-blue{background:var(--primary-soft);color:var(--primary)}
    .ico-green{background:var(--green-soft);color:var(--green)}
    .ico-purple{background:var(--purple-soft);color:var(--purple)}
    .ico-amber{background:var(--amber-soft);color:var(--amber)}
    .ico-red{background:var(--red-soft);color:var(--red)}
    .stat-v{font-size:26px;font-weight:700;color:var(--text);line-height:1.1;letter-spacing:-.02em}
    .stat-v small{font-size:13px;font-weight:500;color:var(--text-3);margin-left:4px}
    .stat-tip{font-size:11.5px;color:var(--text-3);margin-top:6px;display:flex;align-items:center;gap:4px}
    .stat-tip.up{color:var(--green)}
    .stat-tip.down{color:var(--red)}

    /* ---- Table ---- */
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:10px 14px;color:var(--text-2);font-weight:500;font-size:12px;
      border-bottom:1px solid var(--border-soft);background:var(--border-soft);letter-spacing:.02em}
    th:first-child{border-top-left-radius:8px}
    th:last-child{border-top-right-radius:8px}
    td{padding:12px 14px;border-bottom:1px solid var(--border-soft);color:var(--text)}
    tr:last-child td{border-bottom:none}
    tbody tr{transition:background .12s}
    tbody tr:hover td{background:var(--border-soft)}

    /* ---- Badges ---- */
    .badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;
      font-size:11.5px;font-weight:500;white-space:nowrap}
    .badge-green{background:var(--green-soft);color:#065f46}
    .badge-red{background:var(--red-soft);color:#991b1b}
    .badge-blue{background:var(--primary-soft);color:#1e40af}
    .badge-gray{background:var(--border-soft);color:var(--text-2)}
    .badge-amber{background:var(--amber-soft);color:#92400e}
    .badge-purple{background:var(--purple-soft);color:#5b21b6}
    .badge-dot{width:6px;height:6px;border-radius:50%}
    .badge-green .badge-dot{background:var(--green)}
    .badge-red .badge-dot{background:var(--red)}

    /* ---- Buttons ---- */
    .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:none;border-radius:8px;
      font-size:13px;cursor:pointer;transition:all .15s;font-weight:500;font-family:inherit}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-primary{background:var(--primary);color:#fff;box-shadow:0 1px 2px rgba(37,99,235,.25)}
    .btn-primary:hover:not(:disabled){background:var(--primary-hover);box-shadow:0 4px 12px rgba(37,99,235,.3);transform:translateY(-1px)}
    .btn-danger{background:var(--red-soft);color:var(--red)}
    .btn-danger:hover{background:#fecaca}
    .btn-ghost{background:transparent;color:var(--text-2);border:1px solid var(--border)}
    .btn-ghost:hover:not(:disabled){background:var(--border-soft);border-color:#cbd5e1;color:var(--text)}
    .btn-sm{padding:5px 10px;font-size:12px}
    .btn svg{width:14px;height:14px}

    /* ---- Form ---- */
    .form-group{margin-bottom:14px}
    .form-label{display:block;font-size:12.5px;font-weight:500;color:var(--text);margin-bottom:6px}
    .form-control{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;
      outline:none;transition:all .15s;background:#fff;color:var(--text);font-family:inherit}
    .form-control:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
    select.form-control{cursor:pointer}

    /* ---- Toggle ---- */
    .toggle{position:relative;width:40px;height:22px;flex-shrink:0}
    .toggle input{opacity:0;width:0;height:0}
    .toggle-slider{position:absolute;inset:0;background:#cbd5e1;border-radius:20px;cursor:pointer;transition:.2s}
    .toggle-slider::before{content:'';position:absolute;width:18px;height:18px;left:2px;bottom:2px;
      background:#fff;border-radius:50%;transition:.2s;box-shadow:0 2px 4px rgba(0,0,0,.15)}
    .toggle input:checked+.toggle-slider{background:var(--primary)}
    .toggle input:checked+.toggle-slider::before{transform:translateX(18px)}

    /* ---- Modal ---- */
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:100;
      align-items:center;justify-content:center;backdrop-filter:blur(4px)}
    .modal-overlay.open{display:flex}
    .modal{background:var(--panel);border-radius:16px;padding:24px;width:500px;max-width:90vw;
      max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg)}
    .modal-title{font-size:16px;font-weight:700;margin-bottom:20px;color:var(--text)}
    .modal-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:22px}

    /* ---- Log view ---- */
    pre.log-view{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#0f172a;color:#cbd5e1;
      padding:16px;border-radius:10px;overflow:auto;max-height:460px;line-height:1.6;
      font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace}

    /* ---- Section ---- */
    .sec-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
    .sec-t{font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
    .sec-t .dot{width:4px;height:16px;background:var(--primary);border-radius:2px}

    /* ---- Settings row ---- */
    .srow{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border-soft)}
    .srow:last-child{border-bottom:none}
    .srow:first-child{padding-top:0}
    .skey{font-size:13px;font-weight:500;color:var(--text)}
    .sdesc{font-size:12px;color:var(--text-3);margin-top:3px}

    /* ---- Toast ---- */
    .toast-container{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:8px;z-index:200}
    .toast{padding:12px 16px;border-radius:10px;font-size:13px;font-weight:500;animation:slideIn .25s ease;
      max-width:340px;box-shadow:var(--shadow-lg);display:flex;align-items:center;gap:10px}
    .toast-success{background:#fff;color:#065f46;border-left:3px solid var(--green)}
    .toast-error{background:#fff;color:#991b1b;border-left:3px solid var(--red)}
    @keyframes slideIn{from{transform:translateX(120px);opacity:0}to{transform:translateX(0);opacity:1}}

    /* ---- Apply bar ---- */
    .apply-bar{position:sticky;bottom:-32px;background:var(--panel);border-top:1px solid var(--border);
      padding:14px 28px;display:flex;align-items:center;justify-content:space-between;margin:8px -28px -32px;
      box-shadow:0 -4px 12px rgba(15,23,42,.04)}

    /* ---- Domain bar ---- */
    .bar-row{display:grid;grid-template-columns:180px 1fr 60px;gap:12px;align-items:center;padding:8px 0;font-size:12.5px}
    .bar-host{font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bar-track{height:8px;background:var(--border-soft);border-radius:6px;overflow:hidden}
    .bar-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-radius:6px;transition:width .4s ease}
    .bar-cnt{text-align:right;color:var(--text-2);font-variant-numeric:tabular-nums;font-size:12px}

    /* ---- KV box ---- */
    .kv{display:grid;grid-template-columns:auto 1fr;gap:8px 20px;font-size:13px}
    .kv dt{color:var(--text-3);font-weight:500}
    .kv dd{color:var(--text);text-align:right;font-variant-numeric:tabular-nums;font-family:'SFMono-Regular',Consolas,monospace;font-size:12.5px}

    /* ---- Overview summary ---- */
    .summary-shell{background:linear-gradient(180deg,#ffffff 0%,#f8fbff 100%);border:1px solid var(--border-soft);border-radius:18px;padding:22px 24px;box-shadow:var(--shadow);margin-bottom:16px}
    .summary-shell.danger{background:linear-gradient(180deg,#fff8f8 0%,#fff1f2 100%);border-color:#fecaca}
    .summary-shell.warning{background:linear-gradient(180deg,#fffdf5 0%,#fffbeb 100%);border-color:#fde68a}
    .summary-shell.success{background:linear-gradient(180deg,#fbfffd 0%,#f0fdf4 100%);border-color:#bbf7d0}
    .summary-shell.neutral{background:linear-gradient(180deg,#ffffff 0%,#f8fafc 100%)}
    .summary-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .summary-eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .summary-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:600}
    .summary-badge.success{background:var(--green-soft);color:#065f46}
    .summary-badge.warning{background:var(--amber-soft);color:#92400e}
    .summary-badge.danger{background:var(--red-soft);color:#991b1b}
    .summary-badge.neutral{background:var(--border-soft);color:var(--text-2)}
    .summary-badge-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.9}
    .summary-title{font-size:24px;line-height:1.15;font-weight:700;letter-spacing:-.03em;color:var(--text)}
    .summary-desc{font-size:13px;color:var(--text-2);margin-top:8px;line-height:1.7;max-width:760px}
    .summary-meta{font-size:12px;color:var(--text-3);margin-top:10px}
    .summary-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
    .summary-action{display:inline-flex;align-items:center;padding:7px 11px;border-radius:999px;background:rgba(255,255,255,.88);border:1px solid var(--border-soft);font-size:12px;color:var(--text-2)}

    /* ---- Diagnostic panels ---- */
    .section-stack{display:grid;gap:16px}
    .diag-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:16px}
    .diag-panel{border:1px solid var(--border-soft);border-radius:16px;background:#fff;padding:16px 18px}
    .diag-panel-muted{background:#fbfcfe}
    .diag-title{font-size:12px;color:var(--text-3);margin-bottom:10px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
    .diag-list{display:grid;gap:10px}
    .diag-block{border:1px solid var(--border-soft);border-radius:12px;padding:12px 14px;background:#fff}
    .diag-block.bad{border-color:#fecaca;background:#fff7f7}
    .diag-caption{font-size:12px;color:var(--text-3);margin-bottom:4px}
    .diag-text{font-size:13px;color:var(--text);line-height:1.7;word-break:break-all}
    .diag-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
    .diag-stat{border:1px solid var(--border-soft);border-radius:12px;padding:10px 12px;background:#fff}
    .diag-stat-label{font-size:11px;color:var(--text-3);margin-bottom:6px}
    .diag-stat-value{font-size:20px;font-weight:700;letter-spacing:-.02em;color:var(--text)}
    .diag-note{border:1px solid var(--border-soft);border-radius:12px;padding:12px 14px;background:#fff;font-size:13px;color:var(--text-2);line-height:1.7}
    .diag-note-success{border-color:#bbf7d0;background:#f0fdf4;color:#166534}
    .diag-note-warning{border-color:#fde68a;background:#fffbeb;color:#92400e}
    .diag-note-danger{border-color:#fecaca;background:#fff1f2;color:#991b1b}
    .diag-kv{display:grid;grid-template-columns:110px 1fr;gap:8px 12px}
    .diag-kv-key{font-size:12px;color:var(--text-3)}
    .diag-kv-val{font-size:12.5px;color:var(--text);word-break:break-all}
    .card-subtitle{font-size:12px;color:var(--text-3);margin:-4px 0 14px}

    /* ---- Misc ---- */
    .url-text{font-size:12px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text-2);
      max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .empty-tip{text-align:center;padding:40px 20px;color:var(--text-3);font-size:13px}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    code{font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;background:var(--border-soft);
      padding:2px 6px;border-radius:4px;color:var(--text)}

    @media (max-width:1100px){.stat-grid{grid-template-columns:repeat(2,1fr)}.grid-2{grid-template-columns:1fr}.diag-grid{grid-template-columns:1fr}.diag-stats{grid-template-columns:repeat(2,1fr)}.summary-head{flex-direction:column}.summary-title{font-size:21px}}
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="brand">
      <div class="brand-logo">R</div>
      <div>
        <div class="brand-text">Roo Proxy</div>
        <div class="brand-sub">Dashboard</div>
      </div>
    </div>
    <div class="sidebar-nav">
      <div class="nav-item active" data-page="overview">
        <svg class="ni-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
        概览
      </div>
      <div class="nav-item" data-page="config">
        <svg class="ni-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        链式编排
      </div>
      <div class="nav-item" data-page="logs">
        <svg class="ni-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
        访问日志
      </div>
    </div>
    <div class="sidebar-footer">
      <span class="pulse"></span>
      <span id="sidebarStatus">服务运行中</span>
    </div>
  </nav>

  <div class="main">
    <div class="topbar">
      <div>
        <div class="page-title" id="pageTitle">概览</div>
        <div class="page-sub" id="pageSub">实时查看链式代理编排状态与出口流量</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="reloadRulesBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          重新拉取
        </button>
      </div>
    </div>

    <div class="content">
      <!-- Overview -->
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

        <div class="summary-shell neutral" id="ovRunSummary">
          <div class="summary-head">
            <div>
              <div class="summary-eyebrow">
                <span class="summary-badge neutral" id="ovSummaryBadge"><span class="summary-badge-dot"></span>待检查</span>
                <span class="summary-meta" id="ovSummaryMeta">加载中</span>
              </div>
              <div class="summary-title" id="ovSummaryTitle">正在刷新概览状态</div>
              <div class="summary-desc" id="ovSummaryDesc">仅展示关键状态与异常提示。</div>
              <div class="summary-actions" id="ovSummaryActions"></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>网络状态</div></div>
          <div id="ovNetDiag"></div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-h"><div class="card-title"><span class="dot"></span>出口节点健康状态</div></div>
            <div id="ovHealthWrap"><div class="empty-tip">加载中...</div></div>
          </div>

          <div class="card">
            <div class="card-h"><div class="card-title"><span class="dot"></span>服务信息</div></div>
            <dl class="kv" id="ovInfo"></dl>
          </div>
        </div>

      </div>

      <!-- Config -->
      <div class="page" id="page-config">
        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>系统配置工具</div></div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">作用范围：完整系统运行配置（balance_strategy / default_route / upstreams / rules），不是仅“全局设置”字段。</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
            <input type="file" id="configImportInput" accept="application/json,.json" style="display:none" />
            <button class="btn btn-ghost" id="importConfigBtn">导入系统配置</button>
            <button class="btn btn-ghost" id="exportConfigBtn">导出系统配置</button>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>链式代理编排</div></div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">配置 Roo 如何作为链式代理编排器工作：未命中规则时默认如何处理，命中规则时如何分流到出口节点。</div>
          <div class="srow">
            <div>
              <div class="skey">负载均衡策略</div>
              <div class="sdesc">多个出口节点时的流量分配方式</div>
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

        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>系统代理接管（macOS）</div></div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">可将 macOS 系统代理直接指向 Roo 本地入口（同端口支持 HTTP / HTTPS CONNECT / SOCKS5），避免手动在多个程序里重复配置代理端口。</div>
          <div class="srow">
            <div>
              <div class="skey">当前接入方式</div>
              <div class="sdesc" id="sysProxySummary">正在读取系统代理状态...</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
              <button class="btn btn-ghost" id="refreshSystemProxyBtn">刷新状态</button>
              <button class="btn btn-ghost" id="restoreSystemProxyBtn">恢复系统代理</button>
              <button class="btn btn-danger" id="disableSystemProxyBtn">关闭接管</button>
              <button class="btn btn-primary" id="enableSystemProxyBtn">开启接管</button>
            </div>
          </div>
          <div id="sysProxyDetail" style="font-size:12px;color:var(--text-3);line-height:1.8"></div>
        </div>

        <div class="card">
          <div class="card-h"><div class="card-title"><span class="dot"></span>Roo 前置跳板（环境代理）</div></div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">推荐在这里填写你现有的本地代理端口。所有出口节点默认都会先经过这里，再走住宅 IP / 落地机出口；如果前置链路故障，Roo 会自动切到其他可用出口。</div>
          <div class="form-group"><label class="form-label">HTTP_PROXY</label><input class="form-control" id="envHttpProxy" placeholder="如: http://127.0.0.1:6578" /></div>
          <div class="form-group"><label class="form-label">HTTPS_PROXY</label><input class="form-control" id="envHttpsProxy" placeholder="如: http://127.0.0.1:6578" /></div>
          <div class="form-group"><label class="form-label">ALL_PROXY</label><input class="form-control" id="envAllProxy" placeholder="如: socks5://127.0.0.1:6578" /></div>
          <div class="form-group"><label class="form-label">NO_PROXY</label><input class="form-control" id="envNoProxy" placeholder="如: 127.0.0.1,localhost,.local" /></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-ghost" id="resetEnvBtn">重置前置跳板</button>
            <button class="btn btn-primary" id="applyEnvBtn">保存前置跳板</button>
          </div>
        </div>

        <div class="card">
          <div class="sec-h">
            <div class="sec-t"><span class="dot"></span>出口节点池（落地机）</div>
            <button class="btn btn-primary btn-sm" id="addUpstreamBtn">+ 添加出口节点</button>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">出口节点是最终对外出站的住宅 IP / 落地机。默认会复用上面的全局前置跳板；只有少数高级场景才需要给单个出口单独指定 via。</div>
          <table id="upstreamTable" style="display:none">
            <thead><tr><th>名称</th><th>协议</th><th>地址</th><th>单独 via</th><th>权重</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="upstreamBody"></tbody>
          </table>
          <div class="empty-tip" id="upstreamEmpty">暂无出口节点，点击「添加」新建</div>
        </div>

        <div class="card">
          <div class="sec-h">
            <div class="sec-t"><span class="dot"></span>分流规则</div>
            <button class="btn btn-primary btn-sm" id="addRuleBtn">+ 添加规则</button>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">规则决定流量是直连，还是进入某个出口节点池；匹配优先级高的规则会优先生效。</div>
          <table id="rulesTable" style="display:none">
            <thead><tr><th style="width:40px">#</th><th>类型</th><th>匹配值</th><th>动作</th><th>出口节点</th><th>操作</th></tr></thead>
            <tbody id="rulesBody"></tbody>
          </table>
          <div class="empty-tip" id="rulesEmpty">暂无规则，点击「添加」新建</div>
        </div>

        <div class="apply-bar">
          <span style="font-size:13px;color:var(--text-2)">修改后点击「应用」保存到本地配置文件并热重载</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="resetConfigBtn">重置</button>
            <button class="btn btn-primary" id="applyConfigBtn">✓ 应用配置</button>
          </div>
        </div>
      </div>

      <!-- Logs -->
      <div class="page" id="page-logs">
        <div class="card">
          <div class="sec-h">
            <div class="sec-t"><span class="dot"></span>最近访问日志</div>
            <button class="btn btn-ghost btn-sm" id="refreshLogsBtn">↻ 刷新</button>
          </div>
          <div id="logsList"><div class="empty-tip">加载中...</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <!-- Upstream Modal -->
  <div class="modal-overlay" id="upstreamModal">
    <div class="modal">
      <div class="modal-title" id="upstreamModalTitle">添加出口节点</div>
      <div class="form-group"><label class="form-label">名称 *</label><input class="form-control" id="upName" placeholder="如: residential-01" /></div>
      <div class="form-group"><label class="form-label">代理 URL *</label><input class="form-control" id="upUrl" placeholder="socks5://user:pass@host:port" /></div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">默认会复用上面配置的全局前置跳板。只有这个出口节点需要单独前置链路时，才展开填写高级 via。</div>
      <div class="form-group" style="margin-bottom:8px">
        <button type="button" class="btn btn-ghost btn-sm" id="toggleUpViaBtn">高级设置：单独 via</button>
      </div>
      <div class="form-group" id="upViaGroup" style="display:none"><label class="form-label">单独 via（可选）</label><input class="form-control" id="upVia" placeholder="如: socks5://entry-user:pass@host:port 或 http://host:port" /></div>
      <div class="form-group"><label class="form-label">权重</label><input class="form-control" id="upWeight" type="number" value="1" min="1" /></div>
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
      <div class="form-group"><label class="form-label">匹配值 *</label><input class="form-control" id="ruleValue" placeholder="如: claude.ai" /></div>
      <div class="form-group"><label class="form-label">动作</label>
        <select class="form-control" id="ruleAction">
          <option value="proxy">代理 (proxy)</option>
          <option value="direct">直连 (direct)</option>
        </select>
      </div>
      <div class="form-group" id="ruleUpstreamsGroup">
        <label class="form-label">出口节点</label>
        <div id="ruleUpstreamCheckboxes"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="ruleCancelBtn">取消</button>
        <button class="btn btn-primary" id="ruleSaveBtn">保存</button>
      </div>
    </div>
  </div>

<script>
let cfg = null, originalCfg = null, lastStatus = null, envSettings = null, systemProxyStatus = null;
let editUpIdx = -1;
let overviewRefreshToken = 0;
let lastNetDiagRenderKey = null;
let upViaExpanded = false;

const pageTitles = {
  overview: { title: '概览', sub: '实时查看链式代理编排状态与出口流量' },
  config: { title: '链式代理编排', sub: '管理系统代理接管、前置跳板、出口节点与分流规则' },
  logs: { title: '访问日志', sub: '查看最近的请求日志与实际出口结果' }
};

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + page).classList.add('active');
    document.getElementById('pageTitle').textContent = pageTitles[page].title;
    document.getElementById('pageSub').textContent = pageTitles[page].sub;
    if (page === 'logs') loadLogs();
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
  const shell = document.getElementById('ovRunSummary');
  const badge = document.getElementById('ovSummaryBadge');
  const title = document.getElementById('ovSummaryTitle');
  const desc = document.getElementById('ovSummaryDesc');
  const meta = document.getElementById('ovSummaryMeta');
  const actions = document.getElementById('ovSummaryActions');

  if (!shell || !badge || !title || !desc || !meta || !actions) {
    return;
  }

  shell.className = 'summary-shell ' + summary.tone;
  badge.className = 'summary-badge ' + summary.tone;
  badge.innerHTML = '<span class="summary-badge-dot"></span>' + esc(summary.badge);
  title.textContent = summary.title;
  desc.textContent = summary.desc;
  meta.textContent = summary.meta;
  actions.innerHTML = renderSummaryActions(summary.actions);
}


function renderNetDiag(netDiag) {
  const summary = netDiag.upstreamCheckSummary || { totalEnabled: 0, checked: 0, ok: 0, failed: 0, skipped: 0 };
  const checks = Array.isArray(netDiag.upstreamChecks) ? netDiag.upstreamChecks : [];
  const failedChecks = checks.filter((item) => !item.ok).slice(0, 2);
  const currentEgress = netDiag.rooProbeUpstream
    ? ('当前出口节点：' + netDiag.rooProbeUpstream)
    : '当前出口：经 Roo';
  const currentEgressValue = getDiagValue(netDiag.rooProxyMeta, netDiag.rooProxyIp);
  const relayStatus = netDiag.envProxy ? esc(netDiag.envProxy) : '未设置';

  return [
    '<div class="section-stack">',
      '<div class="diag-grid">',
        '<div class="diag-panel">',
          '<div class="diag-title">当前路径</div>',
          '<div class="diag-list">',
            '<div class="diag-block">',
              '<div class="diag-caption">前置代理</div>',
              '<div class="diag-text">' + relayStatus + '</div>',
            '</div>',
            '<div class="diag-block">',
              '<div class="diag-caption">' + esc(currentEgress) + '</div>',
              '<div class="diag-text">' + esc(currentEgressValue) + '</div>',
            '</div>',
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
          failedChecks.length
            ? ('<div class="diag-list">'
                + failedChecks.map((item) =>
                  '<div class="diag-block bad">'
                    + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
                      + '<div style="font-size:13px;font-weight:600;color:var(--text)">' + esc(item.name) + '</div>'
                      + '<span class="badge badge-red"><span class="badge-dot"></span>异常</span>'
                    + '</div>'
                    + '<div class="diag-text" style="margin-top:6px;font-size:12px;color:var(--text-2)">' + esc(item.error || '连接失败') + '</div>'
                  + '</div>'
                ).join('')
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

function summarizeSystemProxy(status) {
  if (!status) {
    return '暂未获取系统代理状态';
  }
  if (!status.supported) {
    return '当前系统不支持接管（仅支持 macOS）';
  }
  if (status.managed) {
    if (status.selectSource === 'default-route') {
      return 'macOS 系统代理已接管到默认路由接口对应服务';
    }
    return 'macOS 系统代理当前已由 Roo 本地入口接管';
  }
  if (status.snapshot) {
    return '当前未接管，但存在可恢复的系统代理快照';
  }
  return '当前仍使用系统原始代理配置，尚未由 Roo 接管';
}

function renderSystemProxyStatus(status) {
  systemProxyStatus = status || null;
  const summary = document.getElementById('sysProxySummary');
  const detail = document.getElementById('sysProxyDetail');
  const enableBtn = document.getElementById('enableSystemProxyBtn');
  const disableBtn = document.getElementById('disableSystemProxyBtn');
  const restoreBtn = document.getElementById('restoreSystemProxyBtn');

  if (!summary || !detail || !enableBtn || !disableBtn || !restoreBtn) {
    return;
  }

  summary.textContent = summarizeSystemProxy(status);

  if (!status) {
    detail.innerHTML = '<div>状态：未知</div>';
    enableBtn.disabled = false;
    disableBtn.disabled = false;
    restoreBtn.disabled = false;
    return;
  }

  const current = status.current || {};
  const serviceOrder = Array.isArray(status.serviceOrder) ? status.serviceOrder : [];
  const sourceText = status.selectSource === 'default-route'
    ? '按默认路由接口自动选择'
    : status.selectSource === 'preferred'
      ? '按显式配置指定'
      : '按回退规则选择';
  const defaultRouteText = status.defaultInterface
    ? ('默认路由接口：' + status.defaultInterface)
    : '默认路由接口：未识别';
  const serviceHint = status.device
    ? (status.service + ' (' + status.device + ')')
    : (status.service || '-');

  const formatItem = (label, item) => {
    const value = item && item.enabled ? ((item.host || '-') + ':' + (item.port || '-')) : '关闭';
    return '<div><strong>' + esc(label) + '：</strong>' + esc(value) + '</div>';
  };

  const serviceMap = serviceOrder.length
    ? ('<div style="margin-top:6px"><strong>服务映射：</strong>'
      + serviceOrder.map((item) => {
        const text = item.device
          ? (item.service + ' (' + item.device + ')')
          : item.service;
        return '<span style="display:inline-block;margin-right:8px">' + esc(text) + '</span>';
      }).join('')
      + '</div>')
    : '';

  detail.innerHTML = [
    '<div><strong>当前接管服务：</strong>' + esc(serviceHint) + '</div>',
    '<div><strong>选择依据：</strong>' + esc(sourceText) + '</div>',
    '<div><strong>' + esc(defaultRouteText) + '</strong></div>',
    serviceMap,
    '<div><strong>Roo 本地入口：</strong>' + esc(status.localEndpoint || '-') + '</div>',
    '<div><strong>恢复快照：</strong>' + esc(status.snapshot?.savedAt ? new Date(status.snapshot.savedAt).toLocaleString('zh-CN') : '无') + '</div>',
    '<div style="margin-top:6px">' + formatItem('HTTP', current.web) + formatItem('HTTPS', current.secureweb) + formatItem('SOCKS', current.socksfirewall) + '</div>'
  ].join('');

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
    const summary = document.getElementById('sysProxySummary');
    const detail = document.getElementById('sysProxyDetail');
    if (summary) summary.textContent = '读取系统代理状态失败';
    if (detail) detail.innerHTML = '<div style="color:var(--red)">错误：' + esc(e.message) + '</div>';
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
    document.getElementById('sidebarStatus').textContent = '服务运行中';

    refreshNetworkDiagnostics(token);
  } catch (e) {
    if (token !== overviewRefreshToken) {
      return;
    }

    document.getElementById('ovStatus').textContent = '离线';
    document.getElementById('sidebarStatus').textContent = '服务异常';
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


// ---- Config ----
function renderConfig() {
  if (!cfg) return;
  document.getElementById('cfgStrategy').value = cfg.balance_strategy || 'round-robin';
  document.getElementById('cfgDefaultRoute').value = cfg.default_route?.action || 'direct';

  const ups = cfg.upstreams || [];
  const upBody = document.getElementById('upstreamBody');
  upBody.innerHTML = '';
  document.getElementById('upstreamTable').style.display = ups.length ? '' : 'none';
  document.getElementById('upstreamEmpty').style.display = ups.length ? 'none' : '';
  ups.forEach((u, i) => {
    let proto = '-'; try { proto = new URL(u.url).protocol.replace(':', ''); } catch {}
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><strong>' + esc(u.name) + '</strong></td>' +
      '<td><span class="badge badge-blue">' + esc(proto) + '</span></td>' +
      '<td><span class="url-text" title="' + esc(maskUrl(u.url)) + '">' + esc(maskUrl(u.url)) + '</span></td>' +
      '<td><span class="url-text" title="' + esc(u.via ? maskUrl(u.via) : '-') + '">' + esc(u.via ? maskUrl(u.via) : '-') + '</span></td>' +
      '<td>' + u.weight + '</td>' +
      '<td><span class="badge ' + (u.enabled !== false ? 'badge-green' : 'badge-gray') + '"><span class="badge-dot"></span>' + (u.enabled !== false ? '启用' : '禁用') + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="editUpstream(' + i + ')">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="delUpstream(' + i + ')">删除</button>' +
      '</td>';
    upBody.appendChild(tr);
  });

  const rules = cfg.rules || [];
  const rb = document.getElementById('rulesBody');
  rb.innerHTML = '';
  document.getElementById('rulesTable').style.display = rules.length ? '' : 'none';
  document.getElementById('rulesEmpty').style.display = rules.length ? 'none' : '';
  rules.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td style="color:var(--text-3);font-size:12px">' + (i + 1) + '</td>' +
      '<td><span class="badge badge-purple">' + esc(r.type) + '</span></td>' +
      '<td><code>' + esc(r.value) + '</code></td>' +
      '<td><span class="badge ' + (r.action === 'proxy' ? 'badge-amber' : 'badge-gray') + '">' + esc(r.action) + '</span></td>' +
      '<td style="font-size:12px;color:var(--text-2)">' + ((r.upstreams || []).join(', ') || '-') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="editRule(' + i + ')">编辑</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="delRule(' + i + ')">删除</button>' +
      '</td>';
    rb.appendChild(tr);
  });
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

document.getElementById('cfgStrategy').addEventListener('change', e => { if (cfg) cfg.balance_strategy = e.target.value; });
document.getElementById('cfgDefaultRoute').addEventListener('change', e => { if (cfg) cfg.default_route = { action: e.target.value, upstreams: [] }; });

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
  document.getElementById('upEnabled').checked = u.enabled !== false;
  document.getElementById('upstreamModal').classList.add('open');
};

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
  if (!name || !url) { toast('名称和 URL 不能为空', 'error'); return; }
  const entry = { name, url, via: via || null, weight, enabled };
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
  document.getElementById('ruleUpstreamsGroup').style.display = '';
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
  document.getElementById('ruleUpstreamsGroup').style.display = r.action === 'proxy' ? '' : 'none';
  renderRuleUpstreams(r.upstreams || []);
  document.getElementById('ruleModal').classList.add('open');
};

window.delRule = i => {
  if (!confirm('确认删除该规则？')) return;
  cfg.rules.splice(i, 1);
  renderConfig();
};


document.getElementById('ruleCancelBtn').addEventListener('click', () => document.getElementById('ruleModal').classList.remove('open'));

document.getElementById('ruleSaveBtn').addEventListener('click', () => {
  const type = document.getElementById('ruleType').value;
  const value = document.getElementById('ruleValue').value.trim();
  const action = document.getElementById('ruleAction').value;
  const upstreams = [...document.querySelectorAll('#ruleUpstreamCheckboxes input:checked')].map(el => el.value);
  if (!value) { toast('匹配值不能为空', 'error'); return; }
  const rule = { type, value, action, upstreams };
  if (editRuleIdx >= 0) cfg.rules[editRuleIdx] = rule; else cfg.rules.push(rule);
  document.getElementById('ruleModal').classList.remove('open');
  renderConfig();
});

document.getElementById('applyConfigBtn').addEventListener('click', async () => {
  const btn = document.getElementById('applyConfigBtn');
  btn.disabled = true; btn.textContent = '保存中...';
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
    btn.disabled = false; btn.textContent = '✓ 应用配置';
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
    const logs = await api('/logs?n=80');
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
}

init();
setInterval(loadOverview, 15000);
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
