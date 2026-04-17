# Roo v1.3.0 更新说明

## 本次版本重点

- **Dashboard 全面一页化**：干掉 sidebar 与多 tab 切换，全部功能收敛到单页，按「概览 → 链式编排 → 访问日志」顺序滚动即可，编辑动作走弹窗，简单不碎
- **住宅 IP 续费管理**：出口节点新增「到期时间 / 备注 / 购买官网」字段，概览页会在 7 / 30 天内到期时自动提醒续费，一键跳转购买页
- **分流规则大列表支持搜索 + 筛选 + 分页**：按匹配值模糊搜、按类型 / 动作 / 出口筛选，内置 20 / 50 / 100 每页分页
- **系统代理接管卡片精简**：只显示 HTTP / HTTPS / SOCKS 三个端点与接管状态，不再混合入口概念
- **macOS 登录自启（无需 sudo）**：新增 `scripts/install-autostart.sh` / `uninstall-autostart.sh`，用用户级 LaunchAgent 开机自启 + 崩溃自动拉起
- **清理日志噪声**：移除 `未配置 Gist 自动刷新` 启动刷屏提示

## 这次解决了什么问题

### 1. Dashboard 页面碎、信息散

之前需要在「概览 / 链式编排 / 访问日志」三个 tab 之间来回切。
现在单页呈现，按章节滚动就看完，少页少切换，功能不少。

### 2. 住宅 IP 到期没人提醒，经常忘了续费

现在每个出口节点可以填：

- **到期时间**：会显示剩余天数徽章（3 天 = 红色 / 7 天 = 红色 / 30 天 = 蓝色 / 过期 = 红色）
- **购买官网**：一键跳转续费
- **备注**：写清楚该 IP 是哪家厂商、套餐、用途

概览页顶部会根据最近到期节点自动弹出「续费提醒」卡片，7 天内到期会红色强调。

### 3. 分流规则一多就难找

支持：

- 搜索匹配值（域名 / CIDR / 国家码都能搜）
- 按类型 / 动作 / 出口节点筛选
- 分页（默认 20 条 / 页，可切 50 / 100）

### 4. 系统代理接管卡片信息太杂

现在只剩三行核心信息：

```
HTTP   127.0.0.1:9999
HTTPS  127.0.0.1:9999
SOCKS  127.0.0.1:9999
```

配合状态徽章和 4 个操作按钮（刷新 / 恢复 / 关闭 / 开启），所见即所得。

### 5. macOS 后台常驻 / 自启动

不依赖 sudo 也不依赖 pm2 startup（macOS 上常失败），通过用户级 LaunchAgent：

- 登录后自动启动 Roo
- 进程崩溃 5 秒内自动重启
- 日志写入 `logs/launchagent.{out,err}.log`

```bash
bash scripts/install-autostart.sh    # 安装自启
bash scripts/uninstall-autostart.sh  # 卸载自启
```

## 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

默认会：

- 克隆或更新仓库到 `~/.roo-proxy`
- 进入仓库目录
- 执行交互式安装脚本

装完如果要后台常驻：

```bash
cd ~/.roo-proxy
bash scripts/install-autostart.sh
```

## 本次发布包含

- Dashboard 一页化重构
- 出口节点续费管理字段（expiresAt / note / vendorUrl）
- 续费提醒卡片
- 分流规则搜索 / 筛选 / 分页
- 系统代理接管卡片精简
- macOS LaunchAgent 自启动脚本
- install.sh 在 pm2 startup 失败时引导到 LaunchAgent 方案
- 启动日志噪声清理

## 验证结果

- `npm test` 通过（19/23，与 v1.2.0 基线一致；4 个失败为 v1.2.0 起就存在的预发性问题）
- Dashboard 冒烟：30+ 断言全部 PASS（测试端口 `10001`，不影响生产 `9999/10000`）
- LaunchAgent plist 模板通过 `plutil -lint` 校验
- 沙盒 dry-run 验证 `install-autostart.sh` 生成的 plist 字段正确

## 升级指南

从 v1.2.0 升级：

```bash
cd ~/.roo-proxy
git pull
npm install
roo restart
```

如果要启用自启动：

```bash
bash scripts/install-autostart.sh
```

## 兼容性

- **配置文件向后兼容**：新增的 `expiresAt / note / vendorUrl` 字段均为可选，老配置无需改动即可使用
- **端口默认不变**：`9999` 代理 / `10000` Dashboard

## 打包方式

```bash
npm test
npm run release:pack
```

默认会在本地 `release/` 目录生成发布包。
