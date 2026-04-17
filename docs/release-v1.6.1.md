# Roo v1.6.1 更新说明

## 修复：前置跳板改动后也要 UNSAVED 扫光

主人反馈：v1.6.0 里 UNSAVED 提示 + APPLY 扫光只在 CONFIG 主区（流量模式 / 负载策略 / 出口节点 / 分流规则等）生效，但「前置跳板」有自己独立的 `保存前置跳板` 按钮，改动后没提示，容易漏保存。

### 现在的行为

- 前置跳板 4 个输入框（HTTP / HTTPS / ALL / NO）任一改动 →
  - `保存前置跳板` 按钮立即 **青色呼吸 halo + 白光扫动**（和 APPLY 同款效果）
  - 按钮左侧出现黄色 `UNSAVED` 徽章 + 「前置跳板未保存 — 点「保存前置跳板」生效」提示
  - 按钮文案从 `保存前置跳板` → `✓ 保存前置跳板`
- 点「⇔ 一键同步」/「清空全部」后同样立刻触发 UNSAVED 态
- 点「保存前置跳板」保存成功 / 点「重置」/ 输入框改回原值 → 自动回归普通态

### 技术实现

- 新增 `envDirty()`：对比 4 个输入框 vs `envSettings.effective` 四个环境变量值
- 新增 `updateEnvApplyState()`：dirty 时加 `has-changes` class（复用现成 apply 扫光样式）+ 显示 `#envUnsavedHint` 提示条
- 4 个输入框绑 `input` 事件 → 实时刷新状态
- `renderEnvSettings()` 末尾、同步/清空按钮、保存成功、重置按钮都会触发状态刷新

## 验证

- `npm test`：21 pass / 25（与 v1.6.0 基线一致）
- 渲染后 `<script>` 过 `node --check`：通过

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000`。

## 兼容性

- 纯前端交互改动，不影响任何 API / 配置 / 代理路径
