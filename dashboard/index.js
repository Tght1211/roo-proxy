const express = require('express');
const { readRecentLogs } = require('../server/logger');

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Roo Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; background: #f6f8fa; color: #24292f; }
    h1, h2 { margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: #0d1117; color: #c9d1d9; padding: 12px; border-radius: 8px; overflow: auto; }
    button { padding: 8px 12px; border: 0; background: #0969da; color: white; border-radius: 8px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #d8dee4; }
  </style>
</head>
<body>
  <h1>Roo 运维面板</h1>
  <p>页面会每 30 秒自动刷新一次数据。</p>
  <button id="reloadBtn">手动重新拉取规则</button>
  <div class="grid" style="margin-top: 16px;">
    <section class="card"><h2>服务状态</h2><pre id="status">加载中...</pre></section>
    <section class="card"><h2>流量统计</h2><pre id="stats">加载中...</pre></section>
    <section class="card" style="grid-column: 1 / -1;"><h2>最近访问日志</h2><pre id="logs">加载中...</pre></section>
  </div>
  <script>
    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error('请求失败：' + response.status);
      }
      return response.json();
    }

    async function refresh() {
      const [status, stats, logs] = await Promise.all([
        fetchJson('/status'),
        fetchJson('/stats'),
        fetchJson('/logs?n=50')
      ]);
      document.getElementById('status').textContent = JSON.stringify(status, null, 2);
      document.getElementById('stats').textContent = JSON.stringify(stats, null, 2);
      document.getElementById('logs').textContent = JSON.stringify(logs, null, 2);
    }

    document.getElementById('reloadBtn').addEventListener('click', async () => {
      try {
        await fetchJson('/reload', { method: 'POST' });
        await refresh();
        alert('规则已重新拉取');
      } catch (error) {
        alert(error.message);
      }
    });

    refresh().catch((error) => {
      document.getElementById('status').textContent = error.message;
    });
    setInterval(() => refresh().catch(() => {}), 30000);
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
