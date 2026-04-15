# Roo

> 本地启动即用的代理管理器：默认跑起来后，直接在 Web 页面完成配置。

Roo 会在本地启动：
- HTTP CONNECT 代理（默认 `127.0.0.1:9999`）
- Dashboard（默认 `127.0.0.1:10000`）

你可以在 Dashboard 里管理：
- upstream（支持可选 via 入口代理）
- 路由规则（domain / cidr / geo）
- Roo 进程环境代理（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`）
- 网络诊断（直连出口、环境代理出口、经 Roo 出口 + 地区/ISP）

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

## 日常命令

```bash
roo up
roo down
roo restart
roo ps
roo status
roo show
roo logs --n=50
```

---

## 推荐使用方式（KISS）

1. 先 `roo up` 启动。
2. 打开 Dashboard。
3. 在 **配置管理** 页添加 upstream / rules。
4. 需要时在 **Roo 环境代理** 区块配置环境代理。
5. 观察 **概览 -> 网络诊断** 是否符合预期出口。

---

## 隐私与安全

- 不要把真实代理账号密码提交到 Git。
- `.env` 已被 `.gitignore` 忽略，请只在本机保存真实凭据。
- 对外共享配置时，使用占位符：
  - `socks5://username:password@host:port`
- Dashboard 与 `/status` 会自动掩码上游凭据显示。

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
