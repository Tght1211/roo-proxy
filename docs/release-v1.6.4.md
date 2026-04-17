# Roo v1.6.4 更新说明

## 严重修复：访问明文 HTTP 站点经 SOCKS5 上游时 400 Bad Request

主人反馈把系统代理指到 `127.0.0.1:9999` 后，访问 `http://ping0.cc` 直接 400。HTTPS 站点正常。这是一个**长期存在**的 bug。

## 根因

Roo 的 9999 端口是多协议嗅探的（HTTP forward / HTTPS CONNECT / SOCKS5 同端口），但当 **上游是 SOCKS5** 时，内部会启一个 `ChainProxy` 本地桥把 SOCKS5 包装成 HTTP 上游给 proxy-chain 用。这个桥之前**只解析 CONNECT 请求**（`server/chain.js::_handle`）——碰到 HTTP forward（`GET http://ping0.cc/ HTTP/1.1`）就直接返回 400。

```js
// Before
const target = parseConnectRequest(data);
if (!target) {
  client.end('HTTP/1.1 400 Bad Request\r\n\r\n');  // ← 就是这里
  return;
}
```

## 修复

给 `ChainProxy._handle()` 补上 HTTP forward 分支：

1. 新增 `parseHttpForwardRequest(buf)`：解析 `METHOD http://host[:port][/path] HTTP/x.y` 形式的第一行
2. 拿到 target host/port 后走同样的 `createChainSocket` 建 SOCKS5 连接
3. **改写请求第一行**：absolute-URI → origin-form（`GET http://ping0.cc/ HTTP/1.1` → `GET / HTTP/1.1`），其余 headers / body 原样透传
4. 双向 pipe

CONNECT 隧道分支完全不动，不影响 HTTPS。

## 影响面

| 入口 | 上游 | 目标协议 | v1.6.3 之前 | v1.6.4 |
|------|------|----------|------|--------|
| HTTP forward | SOCKS5 | HTTP | ❌ 400 | ✅ 200 |
| HTTP CONNECT | SOCKS5 | HTTPS | ✅ 200 | ✅ 200 |
| SOCKS5 | SOCKS5 | HTTP/HTTPS | ✅ 200 | ✅ 200 |
| direct | — | HTTP/HTTPS | ✅ 200 | ✅ 200 |

## 验证

本地在测试端口 9998 起 Roo 实例，走生产出口「美国-纽约」（socks5://206.40.215.135）：

```
HTTP forward  ping0.cc    → 200 OK (body: 206.40.215.135) ✅
HTTP forward  example.com → 200 OK                          ✅
CONNECT       ping0.cc    → 200 OK (HTTP/2 握手成功)        ✅
CONNECT       github.com  → 200 OK (HTTP/2 握手成功)        ✅
SOCKS5        ping0.cc HTTP  → 200 OK                       ✅
SOCKS5        ping0.cc HTTPS → 200 OK                       ✅
```

- `npm test`：21 pass / 25（与 v1.6.3 基线一致）
- 渲染后 `<script>` 过 `node --check`：通过

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000`。

## 技术备注

- 这个 bug **历史悠久**——v1.4.x 之前就存在，只是平时大多数站点已经 HSTS 自动跳 HTTPS，用户感觉不到。ping0.cc 的默认 URL 是明文 HTTP 所以暴露了。
- 主人之前的 git stash 里有一版 `parseHttpForwardRequest` 方案，这次的实现在它基础上更进一步：显式 rewrite absolute-URI → origin-form（RFC 7230 §5.3.1 规定 origin server 接收 origin-form，而非 absolute-form）。

## 兼容性

- 服务端改动，API 和配置格式不变
- 任何前置跳板 / via 配置不受影响
