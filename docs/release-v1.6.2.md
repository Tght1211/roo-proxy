# Roo v1.6.2 更新说明

## 底部 APPLY 条只在 CONFIG 页 + 有未保存改动时显示

主人反馈：只有 CONFIG 页可以编辑，所以底部 APPLY 条没必要常驻——放在 CONSOLE / LOGS 页看着也多余。

### 现在的行为

| 页面 | dirty | apply-bar |
|------|-------|-----------|
| CONSOLE | — | **隐藏** |
| LOGS | — | **隐藏** |
| CONFIG | 无改动 | **隐藏** |
| CONFIG | 有改动 | **显示**（UNSAVED 徽章 + 扫光 APPLY） |

### 触发时机

- 切 tab（CONSOLE ↔ CONFIG ↔ LOGS）→ 自动 show/hide
- 在 CONFIG 页改任何配置 → 立即 show
- 点 APPLY 保存 / RESET 还原 / 改回原值 → 立即 hide

## 技术实现

- `updateApplyBar()` 多加一个 `onConfigPage` 判定：只有 `nav-tab.active.data-page === 'config'` 且 `dirty` 才显示
- 其余情况 `display:none`，不占版面
- tab 切换事件末尾补一次 `updateApplyBar()`
- HTML 初始 `.apply-bar` 直接 `display:none`（默认进来在 CONSOLE 页，本就不该显示）

**注意**：前置跳板（v1.6.1 新加的 UNSAVED 扫光）不受影响，因为它是卡片内部的局部提示，不用底部 apply-bar。

## 验证

- `npm test`：21 pass / 25（与 v1.6.1 基线一致）
- 渲染后 `<script>` 过 `node --check`：通过

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000`。

## 兼容性

- 纯前端交互改动，不影响 API / 配置 / 代理路径
