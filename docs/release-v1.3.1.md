# Roo v1.3.1 更新说明

## 热修：`curl | bash` 一键部署真的能一键了

v1.3.0 的一键部署脚本在 `curl | bash` 管道下卡在第一处 `read` 就直接退出（EOF），导致安装半途中断。v1.3.1 修复这个问题，并把装完到跑起来变成零交互：

- **`install.sh` 新增非交互模式**
  - 检测到 stdin 不是 TTY 时自动启用
  - 也可显式 `bash scripts/install.sh --yes`
  - 所有提示都有合理默认值：`CONFIG_SOURCE=local` / `LOCAL_PORT=9999` / `DASHBOARD_PORT=10000`
  - 支持环境变量覆盖：`ROO_CONFIG_SOURCE` / `ROO_LOCAL_PORT` / `ROO_DASHBOARD_PORT` / `ROO_GIST_ID` / `ROO_GITHUB_TOKEN`
- **`bootstrap.sh` 自动切模式**
  - 管道场景（`curl | bash`）自动追加 `--yes`
  - 本地 TTY 执行时保持交互
- **`pm2` 自动安装**
  - 不再弹 y/N 提示，检测到缺失就直接 `npm install -g pm2`
- **安装结尾自动接入 macOS 登录自启**
  - 调用 `install-autostart.sh` 注册用户级 LaunchAgent（无需 sudo）
  - 可用 `ROO_SKIP_AUTOSTART=1` 跳过
- **默认端口对齐 README**
  - 之前 `install.sh` 默认 7890/7891，现统一为 9999/10000

## 验证过的 happy path

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

从零到：

1. 克隆到 `~/.roo-proxy`
2. `npm install` + 全局安装 `roo` CLI
3. 写入 `.env`（local / 9999 / 10000）
4. 生成空规则配置 `data/roo-config.json`
5. `pm2 start`
6. 注册 `~/Library/LaunchAgents/com.rooproxy.agent.plist`（macOS）
7. 打印 Dashboard 地址：`http://127.0.0.1:10000`

全程零交互，装完即用。

## 升级指南

v1.3.0 用户：

```bash
cd ~/.roo-proxy
git pull
bash scripts/install.sh --yes   # 或直接 curl | bash 一键覆盖
```

## 兼容性

- 配置文件字段无变化（仍沿用 v1.3.0 的 `expiresAt` / `note` / `vendorUrl`）
- 非 macOS 系统继续走 `pm2 startup` 逻辑
