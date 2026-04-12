# CLI 与 Dashboard API 简介

## CLI 示例

### 查看状态

```bash
roo status
```

### 查看规则

```bash
roo list
```

### 添加规则

```bash
roo add openai.com
```

### 添加 upstream

```bash
roo upstream add residential-01 socks5://user:pass@host1:1080 --weight 2
```

### 切换策略

```bash
roo strategy weighted
```

### 查看统计

```bash
roo stats
```

## Dashboard API

### `GET /status`

返回：
- 服务运行状态
- 当前配置摘要
- upstream 健康状态
- 当前环境摘要

### `GET /stats`

返回：
- 总请求数
- 今日请求数
- 域名命中次数
- 各 upstream 成功/失败/平均耗时

### `GET /logs?n=100`

返回最近 N 条日志。

### `POST /reload`

触发重新拉取远端配置。

## 建议用法

- 本地调试优先看 `/status`
- 排查异常先看 `roo doctor`
- 观察运行情况用 `roo logs` + `roo stats`
