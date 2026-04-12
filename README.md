# Roo

> 像袋鼠跳跃一样，把命中规则的流量二次跳跃到干净的住宅 IP 出口。

Roo 是一个面向个人使用场景的代理管理系统。它会在本地启动一个 HTTP CONNECT 代理，根据规则决定某个域名是否需要经过上游代理；命中规则时走配置好的住宅 IP / SOCKS / HTTP upstream，未命中时保持直连。

CLI 统一使用 `roo`。

---

## 你最关心的两个问题

### 1）怎么启动这个程序？

最简单的方法：

```bash
bash scripts/install.sh
```

它会引导你：
- 选择配置模式（`local` 或 `gist`）
- 自动写 `.env`
- local 模式下自动生成本地规则文件
- 自动安装 `roo` 命令
- 自动用 pm2 启动 Roo

如果安装脚本刚执行完但当前终端还没识别 `roo`，可以先执行：

```bash
hash -r
```

如果还是不行，可以临时直接执行：

```bash
node cli/index.js --help
```

如果你不想用安装脚本，也可以：

```bash
npm install
npm install -g .
roo init
npm run serve
```

---

### 2）怎么添加网络规则？

启动后直接用这些命令：

```bash
roo add openai.com
roo add anthropic.com
roo upstream add residential-01 socks5://user:pass@host:1080
roo show
```

含义分别是：

- `roo add openai.com`：把 `openai.com` 加入需要走代理的规则列表
- `roo upstream add ...`：添加一个真正的上游出口
- `roo show`：查看当前完整配置

**注意：只有命中规则的域名才会走 upstream。**
如果你只添加了规则、没添加 upstream，那么命中规则时会失败。

---

## 第一次使用（推荐路径）

Roo 现在支持两种配置模式：

- `local`：规则保存在本地 JSON 文件，最适合第一次使用
- `gist`：规则保存在 GitHub Private Gist，适合需要在线更新规则的人

### 模式一：local（推荐新手）

#### 第 1 步：安装并初始化

```bash
bash scripts/install.sh
```

如果安装后当前 shell 还没识别 `roo`：

```bash
hash -r
```

或者：

```bash
npm install
npm install -g .
roo init
```

初始化完成后，默认本地配置文件在：

```text
data/roo-config.json
```

---

#### 第 2 步：添加规则

```bash
roo add openai.com
roo add claude.ai
roo list
```

---

#### 第 3 步：添加 upstream

```bash
roo upstream add residential-01 socks5://user:pass@host:1080
roo upstream list
```

---

#### 第 4 步：启动服务

```bash
npm run serve
```

或使用 pm2：

```bash
npm run start
```

---

#### 第 5 步：验证是否成功

```bash
roo status
roo show
```

打开 dashboard：

```text
http://127.0.0.1:7891
```

浏览器代理设置到：

```text
127.0.0.1:7890
```

---

### 模式二：gist（适合在线更新规则）

#### 第 1 步：准备 GitHub Private Gist

创建一个 Private Gist，里面放一个 JSON 文件，例如：

```json
{
  "balance_strategy": "round-robin",
  "upstreams": [],
  "rules": []
}
```

你也可以直接参考仓库示例：

- [examples/roo-config.example.json](examples/roo-config.example.json)

---

#### 第 2 步：初始化 Roo

```bash
bash scripts/install.sh
```

或者：

```bash
npm install
npm install -g .
roo init
```

然后选择：

```text
gist
```

并输入：
- `GIST_ID`
- `GITHUB_TOKEN`

---

#### 第 3 步：在线添加规则

```bash
roo add openai.com
roo add anthropic.com
roo upstream add residential-01 socks5://user:pass@host:1080
roo strategy weighted
roo show
```

这些命令会直接更新远端 Gist。

---

#### 第 4 步：启动服务

```bash
npm run serve
```

或：

```bash
npm run start
```

---

#### 第 5 步：让服务重新加载规则

Gist 模式下有 3 种方式：

1. 自动刷新（按 `CONFIG_REFRESH_INTERVAL`）
2. 手动执行：

```bash
roo reload
```

3. 调 dashboard 接口：

```http
POST /reload
```

---

## 最小可运行示例

```bash
npm install
npm install -g .
roo init
roo add openai.com
roo upstream add residential-01 socks5://user:pass@host:1080
roo show
npm run serve
```

然后把浏览器代理设置到：

```text
127.0.0.1:7890
```

---

## 规则配置是否支持在线更新？

支持。

### Gist 模式

- `roo add/remove/upstream ...` 会直接更新远端 Gist
- server 会按 `CONFIG_REFRESH_INTERVAL` 自动刷新
- 你也可以手动 `roo reload`
- dashboard 也支持 `POST /reload`

### local 模式

- `roo add/remove/upstream ...` 会直接写本地 JSON 文件
- 然后你可以 `roo reload`
- 或通过 dashboard 的 `/reload` 重新加载

---

## 常用命令速查

### 初始化与启动

```bash
roo init
npm run serve
npm run start
npm run stop
npm run restart
```

### 规则管理

```bash
roo list
roo add openai.com
roo remove openai.com
```

### upstream 管理

```bash
roo upstream list
roo upstream add residential-01 socks5://user:pass@host:1080
roo upstream remove residential-01
roo upstream enable residential-01
roo upstream disable residential-01
roo upstream set-weight residential-01 5
```

### 策略与状态

```bash
roo strategy round-robin
roo strategy random
roo strategy weighted
roo show
roo status
roo reload
roo stats
roo logs --n=100
roo doctor
```

---

## Gist 配置格式

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

---

## Dashboard 接口

- `GET /`：极简运维页面
- `GET /status`：服务状态、配置摘要、upstream 健康状态
- `GET /stats`：流量统计 JSON
- `GET /logs?n=100`：最近访问日志
- `POST /reload`：手动重新加载配置

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

---

## 环境变量

```env
# 代理服务
LOCAL_PORT=7890                  # 本地监听端口
LOG_LEVEL=info                   # 日志级别 debug/info/error
LOG_RETAIN_DAYS=7                # 日志保留天数

# 配置后端
CONFIG_SOURCE=local              # local 或 gist，推荐新手先用 local
LOCAL_CONFIG_PATH=data/roo-config.json  # 本地配置文件路径（CONFIG_SOURCE=local 时生效）

# 规则配置源（CONFIG_SOURCE=gist 时生效）
GIST_ID=                         # GitHub Private Gist ID
GITHUB_TOKEN=                    # GitHub Personal Access Token
CONFIG_REFRESH_INTERVAL=5        # 规则刷新间隔（分钟，仅 gist 模式自动刷新）

# 运维面板
DASHBOARD_PORT=7891              # 面板监听端口
```

---

## FAQ

### 1. 安装完后提示 `roo: command not found` 怎么办？

先执行：

```bash
hash -r
```

如果还是不行，说明当前 shell 还没刷新 PATH，先直接用：

```bash
node cli/index.js --help
```

也可以手动执行：

```bash
npm install -g .
```

### 2. 为什么我添加了规则，但还是没走代理？

因为还需要至少一个可用 upstream。规则只决定“哪些域名要走代理”，upstream 才是真正的出口。

### 3. local 和 gist 应该选哪个？

- 想先快速跑通：选 `local`
- 想远程在线改规则：选 `gist`

### 4. upstream 失效后会怎样？

Roo 会把该 upstream 标记为不健康并跳过，后续通过探活自动恢复。

### 5. 没有配置 upstream 可以启动吗？

可以启动，但命中规则后因为没有可用上游会失败。

### 6. `roo logs` 没有输出怎么办？

请先确认服务已运行，并且真实请求已经经过 Roo 代理。

---

## 升级与维护

### 升级

```bash
npm install
npm run restart
```

### 维护建议

- 定期执行 `roo doctor`
- 观察 dashboard 中的 upstream 健康状态和失败次数
- Gist 模式建议定期备份配置
- Local 模式建议备份 `data/roo-config.json`

详细维护与开发说明见：

- [开发指南](docs/development.md)

---

## 首发 Release 文案

- [docs/release-v1.0.0.md](docs/release-v1.0.0.md)

---

## Roadmap

- [Roadmap](docs/roadmap.md)

---

## 目录结构

```text
roo/
├── server/
├── cli/
├── dashboard/
├── scripts/
├── docs/
├── examples/
├── data/
├── .github/workflows/
├── .env.example
├── package.json
└── README.md
```

---

## License

[MIT](LICENSE)
