# Roo v1.6.3 更新说明

## 前置跳板改动也触发底部 APPLY 条，一键统一保存

主人反馈：v1.6.1 给前置跳板加了卡片内的 UNSAVED 扫光，但**底部那条全局 APPLY 条**不触发——看不直观。现在统一起来：**CONFIG 页上任何改动都会让底部 APPLY 条出现**，点一次 APPLY 就把所有改动一起保存生效。

## 现在的行为

| 改动类型 | 底部 APPLY 条文案 |
|---------|-----------------|
| 只改流量模式 / 策略 / 路由 / 出口 / 规则 | `UNSAVED 待保存：流量模式 · 出口节点...` |
| 只改前置跳板 | `UNSAVED 待保存：前置跳板` |
| 两者都改 | `UNSAVED 待保存：流量模式 · 前置跳板` |

### 点底部 APPLY 会发生什么

- 如果 cfg 改了 → POST `/config`
- 如果前置跳板改了 → POST `/env-settings`
- 两者都改 → 两个 API 都调用
- 都没改 → toast 提示"没有待保存的改动"

### 点底部 RESET

- 把 cfg 还原到上次保存状态
- **前置跳板**也一起还原到上次生效值（确认弹窗里明确提到）

### 卡片内的「保存前置跳板」按钮保留

作为**细粒度操作**——只想单独保存前置跳板而不动其他改动时可用。UNSAVED 徽章/扫光仍然在。

## 技术实现

- `updateApplyBar()` 加入 `envDirty()` 判定，任一 dirty 就显示
- `applyConfigBtn` click 改为分别检查 cfgDirty / envDirty，按需调两个 API
- `resetConfigBtn` 同时触发 `renderEnvSettings()` 还原前置跳板
- `updateEnvApplyState()` 末尾调 `updateApplyBar()` 让底部条实时刷新

## 验证

- `npm test`：21 pass / 25（与 v1.6.2 基线一致）
- 渲染后 `<script>` 过 `node --check`：通过

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

浏览器硬刷新 `http://127.0.0.1:10000`。

## 兼容性

- 纯前端改动，API / 配置 / 代理路径不变
- `/config` 和 `/env-settings` 两个端点都没变
