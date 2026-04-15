/**
 * 链式代理管理器
 *
 * 实现代理跳跃：client → roo → via(入口代理) → upstream(住宅IP) → target
 *
 * 每个唯一 (via, upstream) 组合会在本地启动一个轻量 HTTP CONNECT 服务，
 * proxy-chain 把它当成普通上游代理使用，对外透明。
 */

const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { SocksClient } = require('socks');

// ---- URL 解析工具 ----

function parseSocksProxy(rawUrl) {
  const u = new URL(rawUrl);
  const type = u.protocol.startsWith('socks4') ? 4 : 5;
  const proxy = {
    host: u.hostname,
    port: Number(u.port) || 1080,
    type,
  };
  if (u.username) proxy.userId = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}

function isSocksProtocol(url) {
  return new URL(url).protocol.startsWith('socks');
}

function isHttpProtocol(url) {
  const p = new URL(url).protocol;
  return p === 'http:' || p === 'https:';
}

// ---- 底层建连 ----

/**
 * 通过 HTTP CONNECT 代理建立到 targetHost:targetPort 的 TCP 隧道，
 * 返回已就绪的 Socket。
 */
function createHttpConnectTunnel(viaUrl, targetHost, targetPort) {
  const via = new URL(viaUrl);
  const viaPort = Number(via.port) || (via.protocol === 'https:' ? 443 : 80);
  const requestImpl = via.protocol === 'https:' ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const headers = {
      Host: `${targetHost}:${targetPort}`,
    };
    if (via.username) {
      const cred = `${decodeURIComponent(via.username)}:${decodeURIComponent(via.password || '')}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }

    const req = requestImpl({
      host: via.hostname,
      port: viaPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      servername: via.protocol === 'https:' ? via.hostname : undefined,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        socket.removeAllListeners();
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`HTTP via 代理 CONNECT 失败，状态码：${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

async function upgradeSocketToTls(socket, servername) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername });
    const onError = (error) => {
      secureSocket.removeListener('secureConnect', onSecureConnect);
      reject(error);
    };
    const onSecureConnect = () => {
      secureSocket.removeListener('error', onError);
      resolve(secureSocket);
    };

    secureSocket.once('error', onError);
    secureSocket.once('secureConnect', onSecureConnect);
  });
}

/**
 * 创建链式连接，返回已连接到 targetHost:targetPort 的 Socket。
 *
 * 支持：
 *   SOCKS5 via + SOCKS5 upstream → SocksClient.createConnectionChain
 *   HTTP    via + SOCKS5 upstream → HTTP CONNECT 隧道 + SocksClient.createConnection
 *   SOCKS5 via + HTTP   upstream  → via SOCKS 到 upstream，把 upstream 当 HTTP CONNECT proxy
 *   HTTP    via + HTTP   upstream  → via 建隧道到 upstream，再通过 upstream CONNECT 到目标
 */
async function createChainSocket(viaUrl, upstreamUrl, targetHost, targetPort) {
  const upstreamIsSOCKS = isSocksProtocol(upstreamUrl);
  const viaIsSOCKS = isSocksProtocol(viaUrl);
  const viaIsHTTP = isHttpProtocol(viaUrl);
  const upstreamIsHTTP = isHttpProtocol(upstreamUrl);

  // ① SOCKS via → SOCKS upstream → target
  if (viaIsSOCKS && upstreamIsSOCKS) {
    const { socket } = await SocksClient.createConnectionChain({
      proxies: [parseSocksProxy(viaUrl), parseSocksProxy(upstreamUrl)],
      destination: { host: targetHost, port: targetPort },
      command: 'connect',
    });
    return socket;
  }

  // ② HTTP via → SOCKS upstream → target
  if (viaIsHTTP && upstreamIsSOCKS) {
    const upstreamParsed = new URL(upstreamUrl);
    const upstreamPort = Number(upstreamParsed.port) || 1080;
    const tunnel = await createHttpConnectTunnel(viaUrl, upstreamParsed.hostname, upstreamPort);
    const { socket } = await SocksClient.createConnection({
      proxy: parseSocksProxy(upstreamUrl),
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      socket: tunnel,
    });
    return socket;
  }

  // ③ SOCKS via → HTTP upstream → target（通过 SOCKS 隧道连接到 HTTP 代理，再发 CONNECT）
  if (viaIsSOCKS && upstreamIsHTTP) {
    const upstreamParsed = new URL(upstreamUrl);
    const upstreamPort = Number(upstreamParsed.port) || (upstreamParsed.protocol === 'https:' ? 443 : 80);
    const { socket: socksSocket } = await SocksClient.createConnection({
      proxy: parseSocksProxy(viaUrl),
      command: 'connect',
      destination: { host: upstreamParsed.hostname, port: upstreamPort },
    });

    let tunnel = socksSocket;
    if (upstreamParsed.protocol === 'https:') {
      tunnel = await upgradeSocketToTls(tunnel, upstreamParsed.hostname);
    }

    return doHttpConnectOnSocket(tunnel, upstreamUrl, targetHost, targetPort);
  }

  // ④ HTTP via → HTTP upstream → target（先到 upstream，再由 upstream CONNECT 目标）
  if (viaIsHTTP && upstreamIsHTTP) {
    const upstreamParsed = new URL(upstreamUrl);
    const upstreamPort = Number(upstreamParsed.port) || (upstreamParsed.protocol === 'https:' ? 443 : 80);
    let tunnel = await createHttpConnectTunnel(viaUrl, upstreamParsed.hostname, upstreamPort);

    if (upstreamParsed.protocol === 'https:') {
      tunnel = await upgradeSocketToTls(tunnel, upstreamParsed.hostname);
    }

    return doHttpConnectOnSocket(tunnel, upstreamUrl, targetHost, targetPort);
  }

  throw new Error(
    `不支持的代理链协议组合：via=${new URL(viaUrl).protocol} upstream=${new URL(upstreamUrl).protocol}`
  );
}

/**
 * 在已有 socket 上执行 HTTP CONNECT 握手，返回可用的隧道 socket。
 */
function doHttpConnectOnSocket(socket, upstreamUrl, targetHost, targetPort) {
  const via = new URL(upstreamUrl);
  const headers = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
  if (via.username) {
    const cred = `${decodeURIComponent(via.username)}:${decodeURIComponent(via.password || '')}`;
    headers.push(`Proxy-Authorization: Basic ${Buffer.from(cred).toString('base64')}`);
  }
  socket.write(headers.join('\r\n') + '\r\n\r\n');

  return new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    const onData = (chunk) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const idx = headerBuffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', reject);
      const responseHead = headerBuffer.subarray(0, idx).toString('latin1');
      const statusLine = responseHead.split('\r\n')[0];
      const code = parseInt(statusLine.split(' ')[1], 10);
      const rest = headerBuffer.subarray(idx + 4);
      if (code === 200) {
        if (rest.length) {
          socket.unshift(rest);
        }
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`HTTP upstream CONNECT 失败，状态码：${code}`));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

// ---- HTTP CONNECT 本地代理 ----

function parseConnectRequest(buf) {
  const str = buf.toString('ascii', 0, Math.min(buf.length, 512));
  const m = str.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP/i);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

class ChainProxy {
  constructor(viaUrl, upstreamUrl) {
    this.viaUrl = viaUrl;
    this.upstreamUrl = upstreamUrl;
    this.server = null;
    this.url = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((client) => this._handle(client));
      this.server.on('error', (err) => { if (!this.url) reject(err); });
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address();
        this.url = `http://127.0.0.1:${port}`;
        resolve(this.url);
      });
    });
  }

  _handle(client) {
    client.on('error', () => {});
    client.once('data', async (data) => {
      const target = parseConnectRequest(data);
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      try {
        const socket = await createChainSocket(
          this.viaUrl, this.upstreamUrl,
          target.host, target.port,
        );
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        socket.on('error', () => client.destroy());
        client.on('error', () => socket.destroy());
        socket.pipe(client);
        client.pipe(socket);
      } catch {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

// ---- 管理器 ----

class ChainProxyManager {
  constructor() {
    this.cache = new Map();
  }

  /**
   * 获取（或创建）(via, upstream) 链的本地代理 URL。
   * proxy-chain 把它当普通 HTTP 上游使用。
   */
  async getChainUrl(viaUrl, upstreamUrl) {
    const key = `${viaUrl}||${upstreamUrl}`;
    if (this.cache.has(key)) return this.cache.get(key).url;
    const proxy = new ChainProxy(viaUrl, upstreamUrl);
    await proxy.start();
    this.cache.set(key, proxy);
    return proxy.url;
  }

  async probeUpstream(viaUrl, upstreamUrl, options = {}) {
    const {
      targetHost = 'api.ip.sb',
      targetPort = 443,
      timeoutMs = 5_000,
    } = options;

    let timeoutId = null;
    let socket = null;
    try {
      socket = await Promise.race([
        createChainSocket(viaUrl, upstreamUrl, targetHost, targetPort),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('链路探测超时')), timeoutMs);
        }),
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      socket.destroy();
      return true;
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (socket) {
        socket.destroy();
      }
      throw error;
    }
  }

  /**
   * 当配置更新时调用，清除不再需要的链代理，预热新的。
   */
  async syncUpstreams(upstreams = []) {
    const needed = new Set(
      upstreams
        .filter((u) => u.via && u.enabled !== false)
        .map((u) => `${u.via}||${u.url}`)
    );
    for (const [key, proxy] of this.cache) {
      if (!needed.has(key)) {
        await proxy.stop().catch(() => {});
        this.cache.delete(key);
      }
    }
    for (const u of upstreams) {
      if (u.via && u.enabled !== false) {
        await this.getChainUrl(u.via, u.url).catch(() => {});
      }
    }
  }

  async stopAll() {
    for (const proxy of this.cache.values()) {
      await proxy.stop().catch(() => {});
    }
    this.cache.clear();
  }
}

module.exports = { ChainProxyManager };
