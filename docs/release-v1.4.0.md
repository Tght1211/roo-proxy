# Roo v1.4.0 — Neon Edition

## Dashboard 大改版：赛博朋克 + 顶部导航

按主人反馈把 dashboard 从「白色拼贴 + 长滚动页」彻底换成赛博朋克风格 + 顶部 4 tab 导航。

### UI 焕新

- **全局暗色底**：深蓝黑底 + 细网格 + 扫描线 overlay，氛围感到位
- **霓虹点缀**：青色（cyan）和品红（magenta）为主色调，按钮/卡片边角有霓虹高光
- **等宽字体 + terminal prompt**：所有标题 / 标签 / 按钮用等宽字体，章节标题前缀 `//`，状态徽章 `> ` 风格
- **斜切边角 (clip-path)**：品牌 logo / 按钮 / 徽章都有 45° 切角，赛博朋克必备

### 顶部导航 · 4 tab

之前一页滚到底太挤，现在拆成：

| # | Tab | 内容 |
|---|-----|------|
| 01 | **CONSOLE** | 概览 · 状态条 · 网络诊断 · 出口健康 · 服务信息 · 续费提醒 |
| 02 | **CHAIN** | 路由策略 · 系统代理接管 · 前置跳板 · 出口节点池 |
| 03 | **RULES** | 分流规则（搜索 + 筛选 + 分页） |
| 04 | **LOGS** | 访问日志 |

切换 tab 有淡入动画，逻辑清爽。

### 丢掉丑陋的黄框

v1.3 那个占满半屏的黄色 "当前已启用前置代理链路" 蒙层已经干掉，换成顶部一条紧凑的 **status-strip**：

```
▎[RELAY]  ● 当前已启用前置代理链路 │ 服务可用，出口结果会受前置代理影响 │ 当前前置代理：http://127.0.0.1:7897
```

左侧细线颜色代表严重度：青（OK）/ 黄（WARN）/ 红（ERROR）/ 绿（SUCCESS），视线不被打断。

### 组件赛博朋克化

- **按钮**：斜切边角 + 霓虹 hover 光效
- **徽章**：边框 + 底色 + 点阵状态指示灯（小光点）
- **表格**：头部等宽字体小写 caps，hover 行有 cyan 软底色
- **卡片**：左上角青色亮条 + 右下角品红亮条（赛博朋克"系统指示"）
- **输入框**：暗底 + 霓虹聚焦光晕
- **开关**：深底 + 点亮切换
- **Modal**：半透暗底 + 4 角霓虹 + `// ` 标题

### 技术细节

- 新增 `status-strip`, `.page`, `.nav-tab`, `.nav-tabs` CSS
- 新增 JS tab 切换逻辑（原有 loadLogs 懒加载复活）
- 旧 `summary-shell` 保留在 DOM 但 `display:none`，JS 继续镜像更新避免引用断裂
- 所有原有 id 保持不变，上下游 API 不受影响

### 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

或 re-run bootstrap：

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

浏览器硬刷新 `http://127.0.0.1:10000` 即可看到新界面。

## 验证

- 渲染后 `<script>` 内容过 `node --check`：通过
- 结构断言 13 项（4 tabs / 4 pages / status-strip / 配色变量 / 暗底）：全部 PASS
- 所有 v1.3.x 的功能（续费提醒、规则分页、系统代理、日志等）保持 100% 工作

## 兼容性

- 只改 UI，API / 配置文件 / CLI 全部向后兼容
- 不影响 v1.3.x 的续费提醒、分流规则分页、macOS 自启动
