# Roo v1.3.3 更新说明

## 热修：Dashboard 打开后卡在"加载中"

v1.3.0 引入「购买官网」输入校验 regex `/^https?:\/\//i` 写在 `renderHtml()` 的模板字面量里，JS 把 `\/` 解析成 `/`，渲染到浏览器的就变成了 `/^https?:///i` —— 双斜杠被识别成单行注释起点，整个 `<script>` 解析失败。

结果：

- 概览卡片全部停在 `-`
- "网络状态 / 出口节点健康状态 / 服务信息"永远"加载中..."
- 前置跳板 / 分流规则 / 日志 相关按钮全部失灵
- 服务端 `/status`、`/network-diagnostics` 其实完全正常

## 修复

- `dashboard/index.js` 里的 regex 双转义为 `\\/\\/`，模板字面量输出回合法的 `/\//\//`（JS 引擎再解析成正则 `/\//\//` → `//`）
- 增加了"渲染后 JS 再做一次 `node --check`"的自动验证，避免以后再犯同类错误

## 验证

- 本地从 `renderHtml()` 提取 `<script>` 内容 → `node --check` 通过
- Node 启动实例 + curl `/` 抓 HTML → 解析出的 inline JS 语法合法

## 主人只需执行

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

或重来一次：

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

刷新浏览器 Dashboard（`http://127.0.0.1:10000`）即可恢复。

## 兼容性

- 仅 JS 字面量层面的修复，不影响任何数据 / 配置 / API
- 不影响 v1.3.0 ~ v1.3.2 已引入的能力
