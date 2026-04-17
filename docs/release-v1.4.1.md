# Roo v1.4.1 更新说明

## 新增：3 种流量模式切换（规则 / 全局代理 / 直连）

v1.4.0 及之前只有"规则模式"一档，想临时全局代理或临时全部直连都得改规则表，很别扭。
v1.4.1 参考 Clash 的设计，在 RULES tab 顶部加了 3-mode 切换：

| 模式 | 行为 | 下方规则表 |
|------|------|------------|
| **规则模式**（默认） | 命中规则 → 按规则；未命中 → 按「默认路由」 | ✅ 生效 |
| **全局代理** | 所有流量都走出口节点池（按负载策略） | ❌ 忽略 |
| **直连模式** | 所有流量直连，不走任何出口 | ❌ 忽略 |

切换后下方规则卡片会暗化 + 禁用交互，直观提示"规则暂时不起作用"。

### 这解决了什么问题

之前主人发现：

> 如果分流规则中没配置的域名，那除非开启全局代理模式，否则走规则模式其实和直连就是一样的效果

对，这是规则模式的正确行为（未命中就走默认 direct）。但之前没有**一键切全局代理**的入口，想临时让某次请求走代理就得手工加规则。现在直接点顶部按钮就行。

### UI

```
┌── TRAFFIC MODE · 流量模式 ──────────────────────────────┐
│ [▎规则模式  命中走规则]                                    │
│ [▎全局代理  所有都走出口]                                   │
│ [▎直连模式  所有都直连]                                     │
│ // 命中规则 → 按规则处理；未命中 → 按默认路由处理。       │
└──────────────────────────────────────────────────────────┘
```

每个模式色条不同：
- 规则模式 = 青色（cyan）
- 全局代理 = 品红（magenta）
- 直连模式 = 黄色（yellow）

## 技术实现

- **`server/config.js`**：新增 `traffic_mode` 字段（`'rule' | 'global' | 'direct'`，默认 `'rule'`），向后兼容
- **`server/router.js`**：`resolveRoute` 顶部短路判断
  - `direct` → `{source:'mode-direct', action:'direct', upstreams:[]}`
  - `global` → `{source:'mode-global', action:'proxy', upstreams:[]}`（空 upstreams 让 balancer 从全部健康节点挑）
- **dashboard**：RULES tab 顶部 3 按钮，切换即改 `cfg.traffic_mode`，点 APPLY 生效
- **test/router.test.js**：新增 2 个 traffic_mode 短路单测，全部绿

## 验证

- `npm test`：21 pass / 25（+2 vs v1.4.0；4 pre-existing fail 与本次无关）
- Dashboard 渲染 `<script>` 过 `node --check`：通过
- 7 项结构断言（mode-switch / mode-btn×3 / modeHint / rulesCard / MODE_HINTS）：全 PASS

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000`，进 `03 RULES` tab 就能看到 3-mode 切换器。

## 兼容性

- `traffic_mode` 可选，老配置自动视作 `'rule'`
- 规则 / 出口 / 默认路由等所有字段保持不变
- 不影响 v1.4.0 赛博朋克 UI
