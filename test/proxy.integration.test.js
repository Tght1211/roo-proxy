const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { UpstreamBalancer } = require('../server/balancer');
const { createProxyServer } = require('../server/proxy');

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

function requestViaProxy(proxyPort, targetUrl) {
  const parsedTarget = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: {
        host: parsedTarget.host,
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
