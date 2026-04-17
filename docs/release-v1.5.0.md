# Roo v1.5.0 更新说明

## 4 个新能力一次到位

- **规则分组**：规则新增 `group` 字段，支持在弹窗里自由填（自动去重进下拉），过滤栏加分组筛选
- **规则启用/禁用开关**：规则新增 `enabled` 字段，表格每行一个小切换，禁用的规则自动变淡且不参与路由
- **粘贴 Clash 规则批量导入**：新「⇪ 批量导入」按钮，把 Clash 规则文本粘进去，自动解析 + target 映射 + 预览确认
- **未保存变更提示 + APPLY 扫光特效**：修改配置后底栏立刻标红「UNSAVED：xx 待保存」，APPLY 按钮亮起霓虹呼吸 + 白光从左扫到右，提示主人该点一下

## 1. 规则分组 + 启用/禁用

```
┌─── 分流规则 ──────────────────────────┐
│ # │启用│ 分组  │类型          │匹配值     │动作│出口        │
│ 1 │[✓] │ AI    │domain-suffix│claude.ai │proxy│美国-纽约   │
│ 2 │[✓] │ AI    │domain-suffix│openai.com│proxy│美国-纽约   │
│ 3 │[ ] │ 国内  │domain-suffix│alipay.com│direct│—          │←禁用变淡
│ 4 │[✓] │ 导入  │domain-exact │ping0.cc  │proxy│池选        │
└──────────────────────────────────────┘
```

过滤栏：`[搜索] [分组 ▾] [类型 ▾] [动作 ▾] [出口 ▾] [状态 ▾] [20/页 ▾] [重置]`

## 2. 粘贴 Clash 规则

顶部「⇪ 批量导入」按钮打开弹窗，粘贴任意 Clash 规则文本即可：

```clash
DOMAIN-SUFFIX,claude.ai,🛬 AI落地节点
DOMAIN-SUFFIX,alipay.com,DIRECT
DOMAIN,api.cursor.sh,🛬 AI落地节点
IP-CIDR,10.0.0.0/8,DIRECT
GEOIP,CN,DIRECT
PROCESS-NAME,Claude,🛬 AI落地节点   ← 自动跳过
```

### 支持的规则类型
- `DOMAIN` → `domain-exact`
- `DOMAIN-SUFFIX` → `domain-suffix`
- `DOMAIN-KEYWORD` → `domain-keyword`
- `IP-CIDR` → `ipv4-cidr` / `ipv6-cidr`（看值有没有 `:`）
- `IP-CIDR6` → `ipv6-cidr`
- `GEOIP` → `geo-country`

### 不支持（会跳过并列出原因）
- `PROCESS-NAME` / `PROCESS-PATH` —— Roo 是纯网络代理，看不到进程名
- `MATCH` / `FINAL` —— Roo 用 CHAIN tab 里的「默认路由」替代这个语义

### 自定义 target 映射
文本里出现的非标准 target（如 `🛬 AI落地节点`）会在弹窗里列出，每个让主人选：
- 走出口池（默认，按策略挑）
- 直连
- 跳过不导入
- 映射到已有出口（如 `美国-纽约`）—— 名字一致会自动预选

导入时可选「插入到最上方（优先命中）」或「追加末尾」，以及「导入到分组」名（默认 `导入`）。

## 3. 未保存提示 + APPLY 扫光

修改任何配置（改规则 / 切模式 / 改策略 / 加出口 / 粘贴导入），右下底栏立刻切到醒目的黄色警示态：

```
┌──────────────────────────────────────────────────────┐
│ [UNSAVED] 待保存：分流规则 (0→42) · 流量模式        │
│                                     [RESET] [✓ APPLY] │←扫光+呼吸
└──────────────────────────────────────────────────────┘
```

APPLY 按钮：
- 霓虹青色 1.8s 呼吸 halo
- 白光每 2.2s 从左扫到右
- 点击保存后立即回归普通态，toast 确认

## 4. 规则弹窗：加分组、启用开关、池选提示

出口节点 checkbox 区下方新增：
```
// 不勾选 = 从出口节点池按「负载均衡策略」挑（CHAIN tab 设置）
```

## 技术实现

- `server/config.js` `normalizeRule`：新增 `group`（默认 `默认`，最多 60 字）+ `enabled`（默认 true）
- `server/router.js` `resolveRoute`：跳过 `rule.enabled === false` 的规则
- `dashboard/index.js`:
  - `parseClashRules()` 字符串解析（支持引号 / 逗号结尾 / 注释 / no-resolve 参数）
  - `computeConfigDiff()` + `updateApplyBar()` 挂到所有配置变更入口
  - 开关 / 分组 / 过滤条 / 弹窗 UI 全套
- 测试：原有 23 + 新增 2（traffic_mode 短路 + Clash 解析实测）= 25，其中 21 pass（4 pre-existing 与此次无关）

## 升级

```bash
cd ~/.roo-proxy && git pull && bash scripts/install.sh --yes
```

## 兼容性

- 老配置 rules 里没 `group` / `enabled`：自动填 `默认` / `true`
- 老 dashboard（如有缓存）hard-refresh 即可
- API / CLI 向后兼容
