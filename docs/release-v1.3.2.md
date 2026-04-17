# Roo v1.3.2 更新说明

## 热修：自循环代理变量不再阻止 Roo 启动

当用户把 Roo 当作系统代理后，往往会在 shell 里 `export ALL_PROXY=socks5://127.0.0.1:9999`（或类似）。
v1.3.1 及之前版本的 `pm2 start`/`node server/index.js` 会继承这个环境变量，Roo 检测到"自己指向自己"就直接抛错退出。

v1.3.2 修复：

- **服务端**：`server/index.js` 启动时若检测到 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（及其小写同名变量）指向 Roo 自身的 `LOCAL_PORT`，自动清除并打印 warning，不再抛错
- **install.sh**：在 `pm2 start` 前预先清理指向自身端口的代理变量，同时加 `--update-env` 确保新值覆盖 pm2 daemon 缓存
- **双重兜底**：任何一层都能独立保证不再因为自循环变量导致启动失败

## 端到端验证

三种场景全部通过（测试端口 9998/10001）：

1. ✅ 无自循环 env：正常启动
2. ✅ `ALL_PROXY=socks5://127.0.0.1:<本端口>` + `HTTP_PROXY` 指向别处：自动清掉自循环项，`HTTP_PROXY` 保留做前置，服务正常启动
3. ✅ `bash scripts/install.sh --yes` 非交互一键装：完整跑通，Dashboard 按时响应

## 主人只需执行

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

或已有老目录：

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

## 兼容性

- `.env` 行为不变：若你显式在 `.env` 里配置了 `HTTP_PROXY=...` 指向其他端口的前置跳板，**不会**被清除（只清指向自身端口的才被清）
- Dashboard "前置跳板" 面板仍按原方式工作
- 不影响 v1.3.0 / v1.3.1 引入的新字段（`expiresAt` / `note` / `vendorUrl`）
