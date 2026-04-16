const net = require('net');
const { SocksClient } = require('socks');
const { resolveRoute, formatRuleLabel } = require('./router');
const { createHttpConnectTunnel } = require('./chain');

function toErrorMessage(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return String(error.message || error);
}

/**
 * Read exactly `n` bytes from socket. Any excess bytes are pushed back.
 */
function readBytes(socket, n) {
  return new Promise((resolve, reject) => {
    if (n === 0) {
      resolve(Buffer.alloc(0));
      return;
    }

    const chunks = [];
    let total = 0;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      // Pause so flow() does not consume unshifted leftover bytes before
      // the next readBytes call adds its own 'data' listener.
      socket.pause();
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        cleanup();
        const buf = Buffer.concat(chunks);
        if (buf.length > n) socket.unshift(buf.slice(n));
        resolve(buf.slice(0, n));
      }
    };

    const onError = (err) => { cleanup(); reject(err); };
    const onEnd = () => { cleanup(); reject(new Error('连接意外关闭')); };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.resume();
  });
}

function sendReply(socket, rep) {
  // VER | REP | RSV | ATYP(IPv4) | BND.ADDR(0.0.0.0) | BND.PORT(0)
  socket.write(Buffer.from([0x05, rep, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
}

function pipeSockets(a, b) {
  const destroyB = () => b.destroy();
  const destroyA = () => a.destroy();
  a.on('error', destroyB);
  b.on('error', destroyA);
  a.on('close', destroyB);
  b.on('close', destroyA);
  a.pipe(b);
  b.pipe(a);
}

async function connectDirect(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect(targetPort, targetHost);
    s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
    s.once('error', reject);
  });
}

async function buildTargetSocket(upstream, targetHost, targetPort, chainManager) {
  if (!upstream) {
    return connectDirect(targetHost, targetPort);
  }

  const viaUrl = upstream.via ? String(upstream.via).trim() : null;

  if (viaUrl && chainManager) {
    // Use ChainProxyManager to get a local HTTP CONNECT proxy, then tunnel through it
    const chainUrl = await chainManager.getChainUrl(viaUrl, upstream.url);
    return createHttpConnectTunnel(chainUrl, targetHost, targetPort);
  }

  const upstreamUrl = upstream.url;
  const proto = new URL(upstreamUrl).protocol;

  if (proto.startsWith('socks')) {
    const u = new URL(upstreamUrl);
    const type = proto.startsWith('socks4') ? 4 : 5;
    const proxy = { host: u.hostname, port: Number(u.port) || 1080, type };
    if (u.username) proxy.userId = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);

    const { socket } = await SocksClient.createConnection({
      proxy,
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
    });
    return socket;
  }

  // HTTP / HTTPS upstream
  return createHttpConnectTunnel(upstreamUrl, targetHost, targetPort);
}

async function handleSocks5Connection(socket, { balancer, configManager, logger, stats, chainManager }) {
  socket.on('error', () => {});

  try {
    // ── Greeting ──────────────────────────────────────────────────────────
    // Client: VER(1=0x05) | NMETHODS(1) | METHODS[NMETHODS]
    const greetHeader = await readBytes(socket, 2);
    if (greetHeader[0] !== 0x05) {
      socket.destroy();
      return;
    }

    const nmethods = greetHeader[1];
    const methods = nmethods > 0 ? await readBytes(socket, nmethods) : Buffer.alloc(0);

    if (!Array.from(methods).includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xFF])); // no acceptable method
      socket.destroy();
      return;
    }

    socket.write(Buffer.from([0x05, 0x00])); // NO AUTH selected

    // ── Request ───────────────────────────────────────────────────────────
    // Client: VER(1) | CMD(1) | RSV(1) | ATYP(1) | DST.ADDR | DST.PORT(2)
    const reqFixed = await readBytes(socket, 4);
    const cmd = reqFixed[1];
    const atyp = reqFixed[3];

    let targetHost;
    if (atyp === 0x01) {
      // IPv4: 4 bytes
      const addr = await readBytes(socket, 4);
      targetHost = Array.from(addr).join('.');
    } else if (atyp === 0x03) {
      // Domain: 1-byte length prefix
      const lenBuf = await readBytes(socket, 1);
      const domBuf = await readBytes(socket, lenBuf[0]);
      targetHost = domBuf.toString();
    } else if (atyp === 0x04) {
      // IPv6: 16 bytes
      const addr = await readBytes(socket, 16);
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(addr.readUInt16BE(i).toString(16));
      targetHost = parts.join(':');
    } else {
      sendReply(socket, 0x08); // address type not supported
      socket.destroy();
      return;
    }

    const portBuf = await readBytes(socket, 2);
    const targetPort = portBuf.readUInt16BE(0);

    if (cmd !== 0x01) {
      sendReply(socket, 0x07); // command not supported
      socket.destroy();
      return;
    }

    // ── Route & connect ───────────────────────────────────────────────────
    const config = configManager.getConfig();
    const route = await resolveRoute(targetHost, config);
    const rule = route.rule ? formatRuleLabel(route.rule) : null;
    const startedAt = Date.now();

    if (route.action !== 'proxy') {
      // Direct connection
      try {
        const targetSocket = await connectDirect(targetHost, targetPort);
        sendReply(socket, 0x00);
        const durationMs = Date.now() - startedAt;
        stats.recordRequest({ hostname: targetHost, rule, upstream: null, status: 'success', durationMs, isDirect: true });
        logger.access({ hostname: targetHost, rule, upstream: null, status: 'success', durationMs, isDirect: true }).catch(() => {});
        pipeSockets(socket, targetSocket);
      } catch (error) {
        sendReply(socket, 0x04); // host unreachable
        socket.destroy();
        const durationMs = Date.now() - startedAt;
        stats.recordRequest({ hostname: targetHost, rule, upstream: null, status: 'failed', durationMs, isDirect: true, error: toErrorMessage(error) });
        logger.access({ hostname: targetHost, rule, upstream: null, status: 'failed', durationMs, isDirect: true, error: toErrorMessage(error) }).catch(() => {});
      }
      return;
    }

    // Proxy — try upstreams with fallback
    const attemptedUpstreams = new Set();

    while (true) {
      const upstream = balancer.pickUpstream({
        names: route.upstreams,
        excludeNames: [...attemptedUpstreams],
      });

      if (!upstream) {
        const msg = route.upstreams.length
          ? `当前没有可用的上游代理，请检查这些 upstream：${route.upstreams.join(', ')}`
          : '当前没有可用的上游代理，请检查 upstream 健康状态。';
        sendReply(socket, 0x04);
        socket.destroy();
        const durationMs = Date.now() - startedAt;
        stats.recordRequest({ hostname: targetHost, rule, upstream: null, status: 'failed', durationMs, isDirect: false, error: msg });
        logger.access({ hostname: targetHost, rule, upstream: null, status: 'failed', durationMs, isDirect: false, error: msg }).catch(() => {});
        return;
      }

      attemptedUpstreams.add(upstream.name);

      try {
        const targetSocket = await buildTargetSocket(upstream, targetHost, targetPort, chainManager);
        sendReply(socket, 0x00);
        const durationMs = Date.now() - startedAt;
        balancer.markSuccess(upstream.name);
        stats.recordRequest({ hostname: targetHost, rule, upstream: upstream.name, status: 'success', durationMs, isDirect: false });
        logger.access({ hostname: targetHost, rule, upstream: upstream.name, status: 'success', durationMs, isDirect: false }).catch(() => {});
        pipeSockets(socket, targetSocket);
        return;
      } catch (error) {
        logger.error('SOCKS5 上游连接失败，尝试切流', {
          hostname: targetHost,
          rule,
          upstream: upstream.name,
          error: toErrorMessage(error),
        }).catch(() => {});
        // Don't mark upstream unhealthy on single-request failures
      }
    }
  } catch {
    socket.destroy();
  }
}

module.exports = { handleSocks5Connection };
