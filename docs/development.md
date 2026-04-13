# 开发指南

## 项目结构

- `server/`：本地代理、配置拉取、负载均衡、日志、统计
- `cli/`：`roo` 命令行入口
- `dashboard/`：本地 HTTP 运维面板
- `scripts/`：安装脚本与环境自检

## 本地开发

```bash
npm install
cp .env.example .env
npm run serve
```

如果要调试 CLI：

```bash
node cli/index.js --help
node cli/index.js doctor
```

## 模块职责

### `server/config.js`

负责：
- 加载 `.env`
- 拉取 GitHub Gist 配置
- 本地缓存配置
- 自动刷新

### `server/router.js`

负责：
- 域名规则匹配
- 默认出口解析
- 精确匹配与子域名匹配

### `server/balancer.js`

负责：
- upstream 选择
- round-robin / random / weighted
- upstream 健康状态与探活恢复

### `server/proxy.js`

负责：
- 基于 `proxy-chain` 接收代理请求
- 命中规则时按规则指定的 upstream 集合选出口
- 未命中规则时按 `default_route` 决定走直连还是默认 upstream
- 记录请求结果、日志与统计

### `server/logger.js`

负责：
- stdout + 文件日志
- 访问日志读取
- 历史日志清理

### `server/stats.js`

负责：
- 内存流量统计
- `stats.json` 持久化

### `dashboard/index.js`

负责：
- `/status` `/stats` `/logs` `/reload`
- 简易 HTML 运维面板

### `cli/index.js`

负责：
- 配置增删改查
- 状态、日志、统计、自检

## 调试建议

### 1. 先验证 dashboard

```bash
curl http://127.0.0.1:7891/status
```

### 2. 再验证代理直连路径

```bash
curl -I -x http://127.0.0.1:7890 http://example.com
```

### 3. 再验证 Gist 配置

```bash
node cli/index.js show
node cli/index.js reload
```

## 二次开发建议

- 如果未来要支持更多配置源，可把 `server/config.js` 抽象成 provider 模式。
- 如果未来要支持更复杂的规则匹配，可在 `server/router.js` 增加通配符或正则规则，但建议保持向后兼容。
- 如果未来要支持前端页面增强，建议保持 dashboard 为零构建依赖，避免引入前端工程化复杂度。
