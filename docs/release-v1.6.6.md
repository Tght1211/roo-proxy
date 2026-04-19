# Roo v1.6.6 更新说明

## 三件事

1. **README 重写定位**：明确 Roo 是给 Claude Code / ChatGPT / Codex / TikTok 这类风控严格场景准备的"**独享出口 IP**"链式代理，区别于万人共享的机场节点
2. **README 新增「三种流量模式」章节**：把 `规则 / 全局 / 直连` 三种模式的边界、前置跳板作用范围、踩坑点讲清楚
3. **Dashboard 右上角 PROXY 开关的原生 `confirm()` 换成赛博朋克风 modal**：跟整体主题对齐
4. **install.sh 修"端口被占用"卡安装**：自动清理脱离 pm2 的僵尸 roo 进程

---

## 改动 1：README 重写定位

### 动机

主人反馈 README 第一屏没点明 Roo 的差异化价值。用户来这个项目，多半是因为：

- 用机场节点登 ChatGPT / Claude 一上来就要手机验证
- Claude Code / Codex 调 API 反复被 429 / 403
- TikTok 刷几分钟就触发人机校验

这些问题的共通根因是**机场 IP 是万人共享池**，早就进了各家风控黑名单。Roo 的核心思路是**把翻墙和落地拆开**：机场做前置跳板（只管出境），独享的住宅 / VPS IP 做落地（真正出现在目标服务面前），出口永远干净。

### 改动

新的开头 blockquote：

```markdown
> **把「前置 VPN + 独享落地 IP」串成一条稳定链路的本地代理管理器。**
> 专为 Claude Code / ChatGPT / Codex / TikTok 这类风控严格的服务设计 ——
> 让目标网站看到的永远是你一个人在用的住宅 / VPS 出口 IP，而不是几千人共享的机场节点。
```

并新增「**为什么不用机场节点？**」小节，列出三个典型痛点 + 讲清 Roo 的分层思路。

---

## 改动 2：README 新增「三种流量模式」章节

### 动机

主人自己踩了个坑：切到**全局模式**访问 `ping0.cc`，curl 报 `CONNECT tunnel failed, response 594` —— 实际根因是境外上游节点必须经**前置跳板**才能通，而全局模式强制所有流量走上游，前置跳板一掉就全崩；规则模式看起来正常只是因为大多数访问命中了 `default_route: direct` 没经过上游。

三种模式的边界在代码里清晰（`server/router.js:307-313`），但 README 一直没写，新用户只能踩完坑才明白。

### 改动

新增一节表格 + 三条⚠️：

| 模式 | 分流规则 | 走上游节点 | 经前置跳板 | 典型用途 |
|---|---|---|---|---|
| **规则**（默认） | ✅ 按规则表 | 只在命中 `proxy` 规则时 | 同左 | 日常 |
| **全局** | ❌ 忽略 | ✅ 全部走 | ✅ 全部经过 | 刷 ChatGPT / TikTok / Claude |
| **直连** | ❌ 忽略 | ❌ 从不 | ❌ 不经过 | 暂停代理但不停服 |

配套提醒：

- 境外上游 + 全局模式 → **必须**配前置跳板，否则 `594 ECONNREFUSED`
- 规则模式"看起来正常"可能是假象（没命中规则 → 默认直连 → 绕开上游），验证上游健康要测**命中 proxy 规则的域名**
- 直连模式 ≠ 关进程，想彻底停服用 `roo down`

---

## 改动 3：PROXY 开关换赛博朋克风 confirm

### 动机

主人截图反馈：右上角 `PROXY ON` 点了之后弹出的**浏览器原生** `confirm()`（白底蓝按钮的 Chrome 标准样式）跟 Dashboard 整体 cyberpunk 主题严重不搭。

### 改动

**新增可复用 helper `cyberConfirm()`**（`dashboard/index.js:1460`），返回 `Promise<boolean>`，支持：

- 标题带 `// ` 前缀，字体 mono，青/紫荧光角（复用已有 `.modal` 样式）
- `Esc` 取消 / `Enter` 确认 / 点遮罩取消
- 自定义按钮文案和样式类（`btn-danger` 用于破坏性操作）

**新增专用 modal DOM**（`dashboard/index.js:1417`）：

```html
<div class="modal-overlay" id="cyberConfirmModal">
  <div class="modal" style="width:460px">
    <div class="modal-title" id="cyberConfirmTitle">确认操作</div>
    <div id="cyberConfirmBody"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="cyberConfirmCancel">取消</button>
      <button class="btn btn-primary" id="cyberConfirmOk">确认</button>
    </div>
  </div>
</div>
```

**替换 PROXY 开关的原生 confirm**（`dashboard/index.js:1500`）：

```js
const ok = await cyberConfirm({
  title: '确认关闭代理功能',
  bodyHtml: '...红色▶警告项 + 青色▶安全项 + roo down 提示块...',
  confirmText: '关闭代理',
  confirmClass: 'btn-danger',
});
if (!ok) return;
```

主按钮改用 `btn-danger`（红色描边），更符合破坏性操作语义。

### 不改的地方

其它 4 处 `confirm()`（删出口 / 删规则 / 导入覆盖 / 重置配置）保持原生不动 —— helper 已经就位，后续想统一替换很简单。

---

## 改动 4：install.sh 自动清理僵尸 roo 进程

### 动机

主人重跑 `install.sh` 时遇到：

```
[错误] 本地代理端口 9999 已被其他进程占用，Roo 无法安全启动。
占用详情：node 47478 ... 127.0.0.1:9999 (LISTEN)
```

但 PID 47478 的 `PPID=1` —— 是**被 LaunchAgent 拉起来的 roo 进程**（`install-autostart.sh:60-61` 里 `KeepAlive: true`），脱离了 pm2 管理，`pm2 delete roo` 清不到。

### 修复

`scripts/install.sh` 新增 `cleanup_stale_roo_processes()`，在 `pm2 delete roo` 之后、`ensure_port_free` 之前执行：

```bash
# 1. 如果 LaunchAgent 在跑，先 bootout（否则 KeepAlive 会 5 秒内拉起）
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || \
  launchctl unload "$plist" 2>/dev/null || true

# 2. 精确匹配本项目路径的 node 进程
pids="$(pgrep -f "${ROOT_DIR}/server/index\.js")"

# 3. 先 SIGTERM，最多等 3 秒；顽固的再 SIGKILL
kill $pids
# ... 轮询，然后 kill -9 ...
```

**只清自家进程**（路径精确匹配 `$ROOT_DIR/server/index.js`），不会误伤第三方。后续 `install-autostart.sh` 会重新注册 LaunchAgent，保持幂等。

### 效果

```
正在清理旧的 pm2 Roo 进程...
检测到旧的 LaunchAgent 在运行，先临时卸载以释放端口...
正在使用 pm2 启动 Roo 服务...
[OK] Roo 已通过 pm2 启动。
```

之前会 `exit 1` 让用户手动改端口，现在自动修复。

---

## 验证

- `bash scripts/install.sh --yes`：成功清理旧进程，新进程正常接管 9999，Dashboard 返回 200 ✅
- `curl -x http://127.0.0.1:9999 https://ping0.cc/`（配好前置跳板后）：200 ✅
- `curl --socks5-hostname 127.0.0.1:9999 https://ifconfig.me`：返回上游 IP 206.40.215.135 ✅
- Dashboard 刷新后，点 `PROXY ON` 弹赛博朋克 confirm，样式与主题一致 ✅
- `node --check dashboard/index.js`：通过
- `bash -n scripts/install.sh`：通过

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000` 看到新的赛博朋克确认弹窗。

## 兼容性

- 纯文档（README）+ 前端（Dashboard UI）+ 安装脚本改动
- 配置格式、`/config` `/proxy-state` 等 API 行为、CLI 命令、持久化格式全部不变
- 无数据迁移
