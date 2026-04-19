# Roo v1.6.5 更新说明

## 两件事

1. **修复**：系统代理接管面板报错 `spawn networksetup ENOENT`
2. **新功能**：右上角加了 `PROXY ON / OFF` 开关，一键暂停/恢复代理功能（不关程序）

---

## 修复 1：networksetup ENOENT

主人反馈 CONFIG → 系统代理接管（macOS） 面板显示「读取失败: spawn networksetup ENOENT」。

### 根因

macOS 的 `networksetup` 在 `/usr/sbin/networksetup`，但 pm2 / launchd 继承的 PATH 被剥得很干净：

```
/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
              ^^ 没有 /usr/sbin
```

`execFileAsync('networksetup', ...)` 依赖 PATH 解析，所以找不到。

### 修复

`server/system-proxy.js` 里改用绝对路径：

```js
const NETWORKSETUP_BIN = '/usr/sbin/networksetup';
const ROUTE_BIN = '/sbin/route';
```

系统级命令在 macOS 上位置固定（`/usr/sbin/networksetup` 自 Tiger 以来没挪过），绝对路径比依赖 PATH 更稳。

`/sbin/route` 同样顺手修了（原来也走 PATH，在某些精简环境下会 ENOENT）。

---

## 新功能 2：右上角 PROXY ON/OFF 开关

### 动机

主人提了个很合理的需求：

> 右上角可以配置成关掉/开启，关掉则关掉代理功能不关掉程序！然后说明如果想要关掉程序，就 roo down 命令吧

### 交互

右上角从左到右：`ONLINE` 状态 → `PROXY ON/OFF` 开关 → `SYNC` 按钮。

- **默认**：绿色 `PROXY ON`，带呼吸点
- **点击** → 弹确认框（列出影响），确认后变红色 `PROXY OFF`
- **再点** → 立即恢复

### 暂停时行为

| 入口 | 行为 |
|------|------|
| HTTP forward (`GET http://...`) | 回 `503 Service Unavailable`，body 明文说明 |
| HTTPS CONNECT | 回 `503 Service Unavailable`（curl 看到 "CONNECT tunnel failed, response 503"） |
| SOCKS5（首字节 0x05） | 直接 destroy 连接（SOCKS5 没有人类可读 body） |
| Dashboard (10000) | **正常** |
| `/config` / `/logs` / `/stats` API | **正常** |
| 配置刷新 / 健康检查 / 统计持久化 | **正常** |

503 body 原文：

```
Roo proxy is paused. Re-enable from dashboard, or run `roo down` to stop the program.
```

### 和 `roo down` 的区别

| 操作 | 效果 |
|------|------|
| 右上角 `PROXY OFF` | 暂停代理功能，进程仍在，Dashboard 可用，随时可一键恢复 |
| `roo down` | 彻底关闭 Roo 进程（包括 Dashboard） |

开关的 tooltip / 确认框都会提示：「要彻底关闭 Roo 进程请执行：roo down」

### 为什么不直接 close 监听

考虑过 `multiplexer.close()`（停止 accept 新连接）然后重新 `listen()`，但：

1. `close()` 只阻止新连接，已建立的 socket 不受影响 —— 不够干净
2. 暂停期间再 `listen()` 可能遇到 TIME_WAIT 导致 EADDRINUSE 抖动
3. 用一个标志位在 `'connection'` 回调里分流更简单、可预测，还能给 HTTP 客户端回明文 503

选了 KISS 方案：布尔标志 + 连接回调里分流。

### 技术实现

**`server/index.js`**：

```js
const proxyState = { paused: false };  // 引用共享给 dashboard

const multiplexer = net.createServer((socket) => {
  socket.once('data', (firstChunk) => {
    if (proxyState.paused) {
      if (firstChunk[0] === 0x05) socket.destroy();
      else socket.end('HTTP/1.1 503 ...\r\n\r\n...');
      return;
    }
    // 原有 SOCKS5 / HTTP 分流逻辑不变
  });
});
```

**`dashboard/index.js`**：

- `GET /proxy-state` → `{ paused: bool }`
- `POST /proxy-state` `{ paused: bool }` → 同步更新共享对象
- `getStatus()` 响应里带 `proxyPaused` 字段，跟随 15s 轮询
- 右上角按钮：CSS `.proxy-toggle` + `.proxy-toggle.paused`，样式跟 cyberpunk 主题对齐

## 验证

本地测试实例（LOCAL_PORT=9998 / DASHBOARD_PORT=10001）：

```
POST /proxy-state {paused:true}  → {"paused":true}
HTTP  forward  → 503 Service Unavailable + 明文 body     ✅
HTTPS CONNECT  → 503 (curl: 56 CONNECT tunnel failed)    ✅
SOCKS5         → connection closed (curl: 97)             ✅
POST /proxy-state {paused:false} → {"paused":false}
HTTP / HTTPS / SOCKS5 全部 200 恢复正常                    ✅
GET /system-proxy → 返回 service=Ethernet（不再 ENOENT）   ✅
```

- `npm test`：21 pass / 25（与 v1.6.4 基线一致，无新失败）
- 渲染后 `<script>` 过 `node --check`：通过

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000`，右上角会看到新的 `PROXY ON` 开关。

## 兼容性

- 新增字段 `proxyPaused`（status 响应）/ 新增端点 `/proxy-state`，老客户端忽略即可
- 默认 `paused=false`，重启后状态**不保留**（故意的：重启后默认恢复代理）
- 配置格式、规则路径、CLI 行为全部不变
