# Roo

> **把「前置 VPN + 独享落地 IP」串成一条稳定链路的本地代理管理器。**
> 专为 **Claude Code / ChatGPT / Codex / TikTok** 这类风控严格的服务设计 ——
> 让目标网站看到的永远是**你一个人在用**的住宅 / VPS 出口 IP，而不是几千人共享的机场节点。

## 为什么不用机场节点？

机场（Clash 订阅）是**万人共用 IP 池**：你今天拿到的 IP，昨天可能被别人用来刷号、注册、爬虫，早就进了 OpenAI / Anthropic / TikTok 的黑名单。结果就是：

- ChatGPT / Claude 一登录就要手机验证，甚至直接封号
- Codex / Claude Code 调 API 时反复被 429 / 403
- TikTok 刷几分钟就触发人机校验、视频加载不出来

Roo 的思路是**把"翻墙"和"落地"拆开**：机场只用来出境（前置跳板），真正被目标服务看到的出口 IP 是**你独享的住宅代理或自己的 VPS**。翻墙用公共池，落地用私人 IP，出口永远干净。

**Roo 会在本地启动：**
- HTTP / HTTPS CONNECT / SOCKS5 代理（同端口，默认 `127.0.0.1:9999`）
- Dashboard（默认 `127.0.0.1:10000`）

**Dashboard 单页搞定：**
- 系统代理接管（一键把 macOS 系统代理指到 Roo）
- 前置跳板（你的 VPN 端口）
- 出口节点池（住宅 IP / 落地机，支持 **到期时间 · 备注 · 购买官网**）
- 分流规则（支持搜索 + 类型/动作/出口筛选 + 分页）
- 网络诊断 + 访问日志 + 续费提醒

---

## 一键部署（macOS）

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

安装完成后：

```bash
roo status
```

打开 Dashboard：

```text
http://127.0.0.1:10000
```

---

## 后台常驻 · 登录自启（macOS，无需 sudo）

```bash
cd ~/.roo-proxy
bash scripts/install-autostart.sh
```

会在 `~/Library/LaunchAgents/com.rooproxy.agent.plist` 注册用户级 LaunchAgent：

- 开机登录后自动启动
- 进程崩溃 5 秒内自动拉起
- 日志写入 `logs/launchagent.{out,err}.log`

卸载自启动：

```bash
bash scripts/uninstall-autostart.sh
```

---

## 典型使用场景

你有一个只提供 `host:port` 的第三方 VPN 软件 + 一个按月购买的住宅 IP，
希望访问 claude.ai / chat.openai.com 时**始终走住宅 IP**、不被风控：

1. Dashboard → **前置跳板（环境代理）** 填 VPN 本地端口，比如 `http://127.0.0.1:6578`
2. Dashboard → **出口节点池** 添加住宅 IP，填上：
   - 到期时间（Dashboard 会在 7 / 30 天内自动提醒续费）
   - 备注（比如「美国住宅 · 10GB/月」）
   - 购买官网（一键跳转续费）
3. Dashboard → **分流规则** 添加 `claude.ai` / `openai.com` → 指向该出口
4. Dashboard → **系统代理接管** 开启，macOS 系统代理自动指向 Roo

浏览器不需要任何插件，直接访问即可。

---

## 三种流量模式

Dashboard 右上角可切换。**前置跳板只在走上游的模式下生效。**

| 模式 | 分流规则 | 走上游节点 | 经前置跳板 | 典型用途 |
|---|---|---|---|---|
| **规则**（默认） | ✅ 按规则表 | 只在命中 `proxy` 规则时 | 同左 | **日常**：国内直连，国外按规则走独享 IP |
| **全局** | ❌ 忽略 | ✅ 全部走 | ✅ 全部经过 | 临时把整机流量塞进落地 IP（刷 ChatGPT / TikTok / Claude） |
| **直连** | ❌ 忽略 | ❌ 从不 | ❌ 不经过 | 暂停代理但不停服（Dashboard 仍可用） |

**⚠️ 重要**：

- 如果你的上游节点是**境外地址**，**全局模式必须配前置跳板**，否则 Roo 会直接去 TCP 连境外 IP → 被墙 → 出现 `594 ECONNREFUSED` / `Socket closed` 错误。
- **规则模式**下"看起来一切正常"可能是假象：你访问的域名没命中规则 → 默认直连 → 完全没经过上游，上游坏了你察觉不到。真要验证上游健康，测一个**命中 proxy 规则的域名**。
- **直连模式**是"Roo 彻底不碰流量"，等价于临时卸下代理。想**彻底关掉 Roo 进程**请在终端执行 `roo down`。

---

## 日常命令

```bash
roo up          # 启动
roo down        # 停止
roo restart     # 重启
roo ps          # 进程状态
roo status      # 服务健康
roo show        # 当前配置
roo logs --n=50 # 最近日志
```

---

## 隐私与安全

- 不要把真实代理账号密码提交到 Git
- `.env` 已在 `.gitignore`；只在本机保存真实凭据
- 对外共享配置时使用占位符：`socks5://username:password@host:port`
- Dashboard 与 `/status` 会自动掩码上游凭据显示

---

## 配置来源

支持两种配置后端：
- `local`：本地 `data/roo-config.json`
- `gist`：GitHub Private Gist

Dashboard 的「应用配置」会按当前 `CONFIG_SOURCE` 自动写入对应后端。

---

## 测试

```bash
npm test
```

---

## 发布

```bash
npm run release:pack
```

产物位于 `release/`。
