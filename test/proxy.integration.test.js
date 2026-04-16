const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { UpstreamBalancer } = require('../server/balancer');
const { createProxyServer } = require('../server/proxy');
const { handleSocks5Connection } = require('../server/socks5');

function listen(server, host) {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function createTargetServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      host: req.headers.host,
      url: req.url,
    }));
  });

  const port = await listen(server);
  return { server, port };
}

async function createRecordingHttpProxy(name) {
  const records = [];
  const server = http.createServer((req, res) => {
    const targetUrl = new URL(req.url);
    records.push({
      name,
      type: 'http',
      method: req.method,
      url: req.url,
      host: targetUrl.host,
    });

    const upstreamRequest = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: {
        ...req.headers,
        host: targetUrl.host,
      },
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });

    upstreamRequest.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(error.message);
    });

    req.pipe(upstreamRequest);
  });

  server.on('connect', (req, clientSocket, head) => {
    const [hostname, port] = req.url.split(':');
    records.push({
      name,
      type: 'connect',
      host: req.url,
    });

    const targetSocket = net.connect(Number(port), hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) {
        targetSocket.write(head);
      }
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', () => {
      clientSocket.destroy();
    });
  });

  const port = await listen(server, '127.0.0.1');
  return { server, port, records };
}

function createLoggerStub() {
  return {
    info: async () => {},
    error: async () => {},
    access: async () => {},
  };
}

function createStatsStub() {
  return {
    recordRequest() {},
  };
}

async function createRooServer(config) {
  const logger = createLoggerStub();
  const balancer = new UpstreamBalancer({ logger });
  balancer.updateConfig(config);

  const proxy = createProxyServer({
    port: 0,
    host: '127.0.0.1',
    configManager: {
      getConfig: () => config,
      settings: {
        localPort: 0,
      },
    },
    balancer,
    logger,
    stats: createStatsStub(),
  });

  await proxy.listen();
  return {
    proxy,
    port: proxy.getServer().port,
  };
}


/**
 * A multiplexed Roo server that handles HTTP + HTTPS CONNECT + SOCKS5 on the same port.
 * Mirrors what server/index.js does at runtime.
 */
async function createMultiplexedRooServer(config) {
  const logger = createLoggerStub();
  const balancer = new UpstreamBalancer({ logger });
  balancer.updateConfig(config);

  const configManager = {
    getConfig: () => config,
    settings: { localPort: 0 },
  };
  const stats = createStatsStub();

  const proxy = createProxyServer({
    port: 0,
    host: '127.0.0.1',
    configManager,
    balancer,
    logger,
    stats,
  });

  await proxy.listen();

  const internalHttpServer = proxy.getServer().server;
  const activeSockets = new Set();
  const multiplexer = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
    socket.once('data', (firstChunk) => {
      if (firstChunk[0] === 0x05) {
        socket.pause();
        socket.unshift(firstChunk);
        handleSocks5Connection(socket, { balancer, configManager, logger, stats, chainManager: null })
          .catch(() => socket.destroy());
      } else {
        socket.unshift(firstChunk);
        internalHttpServer.emit('connection', socket);
      }
    });
    socket.on('error', () => {});
  });

  const port = await listen(multiplexer);

  return {
    proxy,
    multiplexer,
    balancer,
    port,
    async close() {
      // Destroy all tracked sockets so multiplexer.close() resolves immediately.
      for (const s of activeSockets) s.destroy();
      activeSockets.clear();
      await new Promise((resolve) => multiplexer.close(resolve));
      await proxy.close();
    },
  };
}

/**
 * Performs a raw SOCKS5 NO-AUTH CONNECT handshake and returns the established socket.
 * The returned socket is live — pipe data into/out of it.
 */
function socks5Connect(proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.on('error', reject);

    let step = 'greeting';
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (step === 'greeting') {
        // Server greeting response: VER(1) METHOD(1)
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          socket.destroy();
          reject(new Error(`SOCKS5 握手失败：${buf[0].toString(16)} ${buf[1].toString(16)}`));
          return;
        }
        buf = buf.slice(2);
        step = 'reply';

        // Send CONNECT request
        const hostBuf = Buffer.from(targetHost);
        const req = Buffer.allocUnsafe(7 + hostBuf.length);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; // VER CMD RSV
        req[3] = 0x03; // ATYP: domain
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + hostBuf.length);
        socket.write(req);
      } else if (step === 'reply') {
        // Server reply: VER(1) REP(1) RSV(1) ATYP(1) BND.ADDR BND.PORT(2)
        // Minimum 10 bytes for IPv4 reply
        if (buf.length < 4) return;
        const rep = buf[1];
        const atyp = buf[3];
        let replyLen = 6; // VER REP RSV ATYP PORT(2)
        if (atyp === 0x01) replyLen += 4;
        else if (atyp === 0x04) replyLen += 16;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          replyLen += 1 + buf[4];
        }
        if (buf.length < replyLen) return;

        socket.removeListener('data', onData);
        socket.removeListener('error', reject);
        socket.on('error', () => {});

        if (rep !== 0x00) {
          socket.destroy();
          reject(Object.assign(new Error(`SOCKS5 CONNECT 失败，REP=${rep}`), { rep }));
          return;
        }

        // Push back any remaining bytes past the reply
        const rest = buf.slice(replyLen);
        if (rest.length > 0) socket.unshift(rest);
        resolve(socket);
      }
    };

    socket.on('data', onData);

    // Send greeting: VER(1=0x05) NMETHODS(1) METHODS[NO_AUTH=0x00]
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

function requestViaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: {
        host: parsed.host,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function connectViaProxy(proxyPort, targetHost, targetPort = 443) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });

    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ statusCode: res.statusCode, body: '' });
    });

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

test('proxy routes matched domains to residential upstream and falls back to default upstream', async (t) => {
  const target = await createTargetServer();
  const vpnProxy = await createRecordingHttpProxy('vpn-default');
  const residentialProxy = await createRecordingHttpProxy('residential');
  const roo = await createRooServer({
    balance_strategy: 'round-robin',
    default_route: {
      action: 'proxy',
      upstreams: ['vpn-default'],
    },
    upstreams: [
      { name: 'vpn-default', url: `http://127.0.0.1:${vpnProxy.port}`, enabled: true, weight: 1 },
      { name: 'residential', url: `http://127.0.0.1:${residentialProxy.port}`, enabled: true, weight: 1 },
    ],
    rules: [
      { domain: 'localhost', action: 'proxy', upstreams: ['residential'] },
    ],
  });

  t.after(async () => {
    await Promise.all([
      close(target.server),
      close(vpnProxy.server),
      close(residentialProxy.server),
      roo.proxy.close(),
    ]);
  });

  const matched = await requestViaProxy(roo.port, `http://localhost:${target.port}/matched`);
  assert.equal(matched.statusCode, 200);

  const fallback = await requestViaProxy(roo.port, `http://127.0.0.1:${target.port}/fallback`);
  assert.equal(fallback.statusCode, 200);

  assert.equal(residentialProxy.records.length, 1);
  assert.equal(residentialProxy.records[0].host, `localhost:${target.port}`);
  assert.equal(vpnProxy.records.length, 1);
  assert.equal(vpnProxy.records[0].host, `127.0.0.1:${target.port}`);
});

test('proxy returns 502 when a rule points to unavailable upstreams only', async (t) => {
  const target = await createTargetServer();
  const roo = await createRooServer({
    balance_strategy: 'round-robin',
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    upstreams: [
      { name: 'residential', url: 'http://127.0.0.1:9', enabled: false, weight: 1 },
    ],
    rules: [
      { domain: 'localhost', action: 'proxy', upstreams: ['residential'] },
    ],
  });

  t.after(async () => {
    await Promise.all([
      close(target.server),
      roo.proxy.close(),
    ]);
  });

  const response = await requestViaProxy(roo.port, `http://localhost:${target.port}/needs-proxy`);
  assert.equal(response.statusCode, 502);
  assert.match(response.body, /当前没有可用的上游代理/);
});


test('proxy keeps upstream available after upstream returns 502 for one tunnel', async (t) => {
  const failingProxy = http.createServer();
  failingProxy.on('connect', (req, clientSocket) => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    clientSocket.destroy();
  });
  const failingPort = await listen(failingProxy, '127.0.0.1');

  const balancer = new UpstreamBalancer({ logger: createLoggerStub() });
  const config = {
    balance_strategy: 'round-robin',
    default_route: {
      action: 'proxy',
      upstreams: ['residential'],
    },
    upstreams: [
      { name: 'residential', url: `http://127.0.0.1:${failingPort}`, enabled: true, weight: 1 },
    ],
    rules: [
      { domain: 'ping0.cc', action: 'proxy', upstreams: ['residential'] },
    ],
  };
  balancer.updateConfig(config);

  const proxy = createProxyServer({
    port: 0,
    host: '127.0.0.1',
    configManager: {
      getConfig: () => config,
      settings: {
        localPort: 0,
      },
    },
    balancer,
    logger: createLoggerStub(),
    stats: createStatsStub(),
  });

  await proxy.listen();

  t.after(async () => {
    await Promise.all([
      close(failingProxy),
      proxy.close(),
    ]);
  });

  const first = await connectViaProxy(proxy.getServer().port, 'ping0.cc');
  assert.equal(first.statusCode, 590);
  assert.equal(balancer.getSnapshot()[0].healthy, true);

  const second = await connectViaProxy(proxy.getServer().port, 'ping0.cc');
  assert.equal(second.statusCode, 590);
  assert.equal(balancer.getSnapshot()[0].healthy, true);
});

test('proxy keeps upstream healthy when relay probe times out before request setup', async (t) => {
  const logger = createLoggerStub();
  const balancer = new UpstreamBalancer({ logger });
  const config = {
    balance_strategy: 'round-robin',
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    upstreams: [
      {
        name: 'residential',
        url: 'socks5://127.0.0.1:1080',
        via: 'http://127.0.0.1:6578',
        enabled: true,
        weight: 1,
      },
    ],
    rules: [
      { domain: 'ping0.cc', action: 'proxy', upstreams: ['residential'] },
    ],
  };
  balancer.updateConfig(config);

  const chainManager = {
    async getChainUrl(_viaUrl, upstreamUrl) {
      return upstreamUrl;
    },
    async probeUpstream() {
      throw new Error('链路探测超时');
    },
  };

  const proxy = createProxyServer({
    port: 0,
    host: '127.0.0.1',
    configManager: {
      getConfig: () => config,
      settings: {
        localPort: 0,
      },
    },
    balancer,
    logger,
    stats: createStatsStub(),
    chainManager,
  });

  await proxy.listen();

  t.after(async () => {
    await proxy.close();
  });

  const first = await requestViaProxy(proxy.getServer().port, 'http://ping0.cc/probe-1');
  assert.equal(first.statusCode, 502);
  assert.match(first.body, /当前没有可用的上游代理/);
  assert.equal(balancer.getSnapshot()[0].healthy, true);

  const second = await requestViaProxy(proxy.getServer().port, 'http://ping0.cc/probe-2');
  assert.equal(second.statusCode, 502);
  assert.match(second.body, /当前没有可用的上游代理/);
  assert.equal(balancer.getSnapshot()[0].healthy, true);
});

// ── SOCKS5 same-port tests ────────────────────────────────────────────────────

test('multiplexed server: HTTP request still works on same port', async (t) => {
  const target = await createTargetServer();
  const upstream = await createRecordingHttpProxy('vpn');
  const roo = await createMultiplexedRooServer({
    balance_strategy: 'round-robin',
    default_route: { action: 'proxy', upstreams: ['vpn'] },
    upstreams: [{ name: 'vpn', url: `http://127.0.0.1:${upstream.port}`, enabled: true, weight: 1 }],
    rules: [],
  });

  t.after(async () => {
    await Promise.all([close(target.server), close(upstream.server), roo.close()]);
  });

  const res = await requestViaProxy(roo.port, `http://127.0.0.1:${target.port}/http-check`);
  assert.equal(res.statusCode, 200);
  assert.equal(upstream.records.length, 1);
});

test('multiplexed server: HTTPS CONNECT still works on same port', async (t) => {
  const target = await createTargetServer();
  const upstream = await createRecordingHttpProxy('vpn');
  const roo = await createMultiplexedRooServer({
    balance_strategy: 'round-robin',
    default_route: { action: 'proxy', upstreams: ['vpn'] },
    upstreams: [{ name: 'vpn', url: `http://127.0.0.1:${upstream.port}`, enabled: true, weight: 1 }],
    rules: [],
  });

  t.after(async () => {
    await Promise.all([close(target.server), close(upstream.server), roo.close()]);
  });

  const res = await connectViaProxy(roo.port, `127.0.0.1`, target.port);
  assert.equal(res.statusCode, 200);
  assert.equal(upstream.records.length, 1);
  assert.equal(upstream.records[0].type, 'connect');
});

test('SOCKS5 NO-AUTH handshake succeeds and connection is established', async (t) => {
  const target = await createTargetServer();
  const roo = await createMultiplexedRooServer({
    balance_strategy: 'round-robin',
    default_route: { action: 'direct', upstreams: [] },
    upstreams: [],
    rules: [],
  });

  t.after(async () => {
    await Promise.all([close(target.server), roo.close()]);
  });

  const socket = await socks5Connect(roo.port, '127.0.0.1', target.port);
  socket.destroy();
  // socks5Connect resolving without throwing confirms successful handshake
});

test('SOCKS5 CONNECT routes matched domain through the correct upstream', async (t) => {
  const target = await createTargetServer();
  const vpnProxy = await createRecordingHttpProxy('vpn');
  const residentialProxy = await createRecordingHttpProxy('residential');

  const roo = await createMultiplexedRooServer({
    balance_strategy: 'round-robin',
    default_route: { action: 'proxy', upstreams: ['vpn'] },
    upstreams: [
      { name: 'vpn', url: `http://127.0.0.1:${vpnProxy.port}`, enabled: true, weight: 1 },
      { name: 'residential', url: `http://127.0.0.1:${residentialProxy.port}`, enabled: true, weight: 1 },
    ],
    rules: [
      { domain: 'localhost', action: 'proxy', upstreams: ['residential'] },
    ],
  });

  t.after(async () => {
    await Promise.all([
      close(target.server),
      close(vpnProxy.server),
      close(residentialProxy.server),
      roo.close(),
    ]);
  });

  // SOCKS5 CONNECT to localhost → should go through residential
  const socket = await socks5Connect(roo.port, 'localhost', target.port);
  socket.destroy();

  assert.equal(residentialProxy.records.length, 1);
  assert.equal(vpnProxy.records.length, 0);
});

test('SOCKS5 unsupported command returns REP=0x07', async (t) => {
  const roo = await createMultiplexedRooServer({
    balance_strategy: 'round-robin',
    default_route: { action: 'direct', upstreams: [] },
    upstreams: [],
    rules: [],
  });

  t.after(async () => { await roo.close(); });

  // Manually send a SOCKS5 BIND (cmd=0x02) request
  await new Promise((resolve, reject) => {
    const socket = net.connect(roo.port, '127.0.0.1');
    socket.on('error', reject);
    let buf = Buffer.alloc(0);
    let step = 'greeting';

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (step === 'greeting' && buf.length >= 2) {
        // Server said NO AUTH
        assert.equal(buf[1], 0x00);
        buf = buf.slice(2);
        step = 'reply';
        // Send BIND (0x02) command for IPv4 127.0.0.1:1234
        socket.write(Buffer.from([
          0x05, 0x02, 0x00, 0x01,  // VER CMD(BIND) RSV ATYP(IPv4)
          127, 0, 0, 1,            // DST.ADDR
          0x04, 0xD2,              // DST.PORT = 1234
        ]));
      } else if (step === 'reply' && buf.length >= 2) {
        assert.equal(buf[1], 0x07); // Command not supported
        socket.destroy();
        resolve();
      }
    });

    socket.write(Buffer.from([0x05, 0x01, 0x00])); // greeting
  });
});

test('SOCKS5: no-upstream failure does not mark upstream unhealthy', async (t) => {
  const roo = await createMultiplexedRooServer({
    balance_strategy: 'round-robin',
    default_route: { action: 'proxy', upstreams: ['residential'] },
    upstreams: [
      { name: 'residential', url: 'http://127.0.0.1:9', enabled: false, weight: 1 },
    ],
    rules: [],
  });

  t.after(async () => { await roo.close(); });

  // Upstream is disabled → pickUpstream returns null → SOCKS5 REP 0x04
  const err = await socks5Connect(roo.port, 'ping0.cc', 443).catch((e) => e);
  assert.ok(err instanceof Error, '应抛出错误');
  assert.equal(err.rep, 0x04);

  // Upstream health status should not be affected (it was already disabled, still disabled)
  const snapshot = roo.balancer.getSnapshot();
  assert.equal(snapshot.length, 1);
  // enabled:false upstreams are excluded from health checks; healthy flag is not changed by a request failure
  assert.equal(snapshot[0].healthy, true);
});
