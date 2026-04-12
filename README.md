# Roo

> 像袋鼠跳跃一样，把命中规则的流量二次跳跃到干净的住宅 IP 出口。

Roo 是一个面向个人使用场景的代理管理系统。它会在本地启动一个 HTTP CONNECT 代理，根据 GitHub Private Gist 中维护的规则，决定某个域名是否需要经过上游代理；命中规则时走配置好的住宅 IP / SOCKS / HTTP upstream，未命中时保持直连。

CLI 统一使用 `roo`。

---

## 特性

- 本地监听 `127.0.0.1:LOCAL_PORT`，默认 `7890`
- 基于 `apify/proxy-chain` 实现 HTTP CONNECT 代理
- 规则配置存储在 GitHub Private Gist，支持自动刷新
- 支持多个 upstream
- 支持三种负载均衡策略：
  - `round-robin`
  - `random`
  - `weighted`
- upstream 失败自动跳过，并支持探活恢复
- 未命中规则时直连
- 提供本地 dashboard 面板
- 提供 `roo` CLI 管理命令
- 提供安装脚本与环境自检
- 提供 GitHub Actions CI 基础冒烟检查
- 所有用户可见错误均为中文友好提示

---

## 系统架构图

```text
┌──────────────────────┐
│ Browser / App / CLI  │
└──────────┬───────────┘
           │ HTTP/HTTPS 代理
           ▼
┌──────────────────────────────┐
│ Roo Local Proxy              │
│ 127.0.0.1:7890               │
│ - HTTP CONNECT               │
│ - 规则匹配                   │
│ - 负载均衡                   │
│ - 健康检查                   │
└───────┬──────────────────────┘
        │
        ├───────────── 未命中规则 ─────────────► 直连目标站点（由底层 TUN / 系统网络接管）
        │
        └───────────── 命中规则 ───────────────► 选中 upstream
                                              │
                                              ▼
                          ┌────────────────────────────────┐
                          │ Upstream Proxies               │
                          │ - socks5://residential-01      │
                          │ - http://residential-02        │
                          │ - socks4://backup-node         │
                          └────────────────────────────────┘

                  ┌──────────────────────────┐
                  │ GitHub Private Gist      │
                  │ - 规则列表 rules         │
                  │ - 上游列表 upstreams     │
                  │ - 负载策略 strategy      │
                  └──────────┬───────────────┘
                             │ 定时刷新 / CLI 增删改查
                             ▼
                    ┌───────────────────────┐
                    │ Roo CLI / Dashboard   │
                    │ - roo add/remove      │
                    │ - roo upstream ...    │
                    │ - /status /stats      │
                    └───────────────────────┘
```

---

## 快速开始

只要 3 步就能跑起来。

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

至少填写：

```env
GIST_ID=你的_private_gist_id
GITHUB_TOKEN=你的_github_token
```

### 3. 启动服务

```bash
npm run start
```

如果你还没有安装 pm2，也可以先直接运行：

```bash
npm run serve
```

启动成功后：

- 本地代理：`127.0.0.1:7890`
- 运维面板：`http://127.0.0.1:7891`

---

## Gist 配置格式

建议在 Private Gist 中保存一个 JSON 文件，例如 `roo-config.json`：

```json
{
  "balance_strategy": "round-robin",
  "upstreams": [
    {
      "name": "residential-01",
      "url": "socks5://user:pass@host1:1080",
      "weight": 1,
      "enabled": true
    },
    {
      "name": "residential-02",
      "url": "http://user:pass@host2:8080",
      "weight": 2,
      "enabled": true
    }
  ],
  "rules": [
    "openai.com",
    "anthropic.com",
    "claude.ai"
  ]
}
```

你也可以直接参考仓库中的示例文件：

- [examples/roo-config.example.json](examples/roo-config.example.json)

---

## CLI 命令

### 基础命令

```bash
roo status
roo list
roo add openai.com
roo remove openai.com
roo show
roo reload
roo stats
roo logs --n=100
roo doctor
```

### upstream 管理

```bash
roo upstream list
roo upstream add residential-01 socks5://user:pass@host1:1080 --weight 2
roo upstream remove residential-01
roo upstream enable residential-01
roo upstream disable residential-01
roo upstream set-weight residential-01 5
```

### 负载策略切换

```bash
roo strategy round-robin
roo strategy random
roo strategy weighted
```

更多开发相关说明见：

- [开发指南](docs/development.md)
- [CLI 与 Dashboard API 简介](docs/api-overview.md)

---

## Dashboard 接口

- `GET /`：极简运维页面
- `GET /status`：服务状态、配置摘要、upstream 健康状态
- `GET /stats`：流量统计 JSON
- `GET /logs?n=100`：最近访问日志
- `POST /reload`：手动重新拉取规则

接口简要说明见：

- [CLI 与 Dashboard API 简介](docs/api-overview.md)

---

## 浏览器代理设置说明

### Chrome

1. 打开系统设置中的网络代理。
2. 选择手动代理。
3. 将 HTTP 和 HTTPS 代理都设置为 `127.0.0.1:7890`。
4. 保存后重新打开浏览器测试。

### Safari

1. 打开“系统设置 -> 网络”。
2. 进入当前网络的“详情”。
3. 打开“代理”。
4. 勾选“Web 代理(HTTP)” 和 “安全 Web 代理(HTTPS)”。
5. 地址填写 `127.0.0.1`，端口填写 `7890`。

说明：

- 当前仓库暂未附带实际截图资源。
- 后续可以在 `docs/` 中补充 macOS / Chrome / Safari 的设置截图。

---

## 环境变量

```env
# 代理服务
LOCAL_PORT=7890                  # 本地监听端口
LOG_LEVEL=info                   # 日志级别 debug/info/error
LOG_RETAIN_DAYS=7                # 日志保留天数

# 规则配置源
GIST_ID=                         # GitHub Gist ID
GITHUB_TOKEN=                    # GitHub Personal Access Token
CONFIG_REFRESH_INTERVAL=5        # 规则刷新间隔（分钟）

# 运维面板
DASHBOARD_PORT=7891              # 面板监听端口
```

---

## 常用脚本

```bash
npm run start     # pm2 启动
npm run stop      # pm2 停止并删除进程
npm run restart   # pm2 重启
npm run logs      # 查看 pm2 日志
npm run doctor    # 环境自检
npm run serve     # 直接运行 node server/index.js
```

---

## CI

仓库已经包含基础 GitHub Actions 工作流：

- 安装依赖
- 检查 CLI help
- 运行 doctor
- 启动服务做 dashboard / proxy 冒烟测试

工作流文件：

- [.github/workflows/ci.yml](.github/workflows/ci.yml)

---

## FAQ

### 1. 为什么服务启动后没有走上游代理？

只有命中 `rules` 的域名才会走 upstream。未命中的域名会直连。

### 2. 为什么 `roo status` 显示服务未运行？

通常表示本地 dashboard 当前不可连接。请确认已经执行 `npm run start` 或 `npm run serve`。

### 3. Gist 存在，但还是拉取失败怎么办？

常见原因包括：

- `GIST_ID` 填错
- `GITHUB_TOKEN` 过期
- Token 权限不足
- 当前网络无法访问 GitHub API

### 4. upstream 失效后会怎样？

Roo 会把该 upstream 标记为不健康并跳过，后续通过探活自动恢复。

### 5. 没有配置 upstream 可以启动吗？

可以启动，但命中规则后因为没有可用上游会失败。如果你只需要全部直连，可以先不要添加相关规则。

### 6. `roo logs` 没有输出怎么办？

请先确认服务已运行，并且真实请求已经经过 Roo 代理。默认日志写入 `logs/access-YYYY-MM-DD.log`。

---

## 升级与维护

### 升级

```bash
npm install
npm run restart
```

如果你更新了 `.env`、Gist 配置结构或 pm2 配置，建议额外执行：

```bash
pm2 reload roo
```

### 维护建议

- 定期执行 `roo doctor`
- 观察 dashboard 中的 upstream 健康状态和失败次数
- 定期备份 Gist 配置
- 定期清理或归档日志与 `stats.json`
- 更换 Token 后同步更新 `.env`

详细维护与开发说明见：

- [开发指南](docs/development.md)

---

## 首发 Release 文案

仓库已附带首发说明草稿：

- [docs/release-v1.0.0.md](docs/release-v1.0.0.md)

可以直接复制到 GitHub Release 页面使用。

---

## Roadmap

后续计划与已知限制见：

- [Roadmap](docs/roadmap.md)

---

## 目录结构

```text
roo/
├── server/
│   ├── index.js
│   ├── proxy.js
│   ├── config.js
│   ├── router.js
│   ├── balancer.js
│   ├── logger.js
│   ├── stats.js
│   ├── constants.js
│   └── ecosystem.config.js
├── cli/
│   └── index.js
├── dashboard/
│   └── index.js
├── scripts/
│   ├── install.sh
│   └── healthcheck.js
├── docs/
│   ├── development.md
│   ├── api-overview.md
│   ├── roadmap.md
│   └── release-v1.0.0.md
├── examples/
│   └── roo-config.example.json
├── .github/workflows/
│   └── ci.yml
├── .env.example
├── package.json
└── README.md
```

---

## License

[MIT](LICENSE)
