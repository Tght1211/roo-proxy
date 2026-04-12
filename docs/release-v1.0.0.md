# Roo v1.0.0 首发说明

## 亮点

- 本地 HTTP CONNECT 代理
- 同时支持 `local` / `gist` 双配置模式
- GitHub Private Gist 规则配置与在线更新
- 多 upstream 负载均衡
- upstream 健康检查与自动恢复
- 本地 dashboard 面板
- `roo` CLI 管理命令
- 一键安装、引导式初始化与环境自检

## 适合谁

- 需要个人代理路由管理的开发者
- 想把特定域名流量走住宅 IP 的用户
- 希望通过 Gist 远程维护规则、又不想搭建复杂控制面的使用者
- 想先在本地快速跑通，再逐步切换到远程配置模式的用户

## 本次发布包含

- 核心代理服务
- CLI 管理工具
- Dashboard 运维面板
- 一键安装脚本与 `roo init` 引导式初始化
- `local` / `gist` 双配置后端
- CLI 修改配置后自动同步运行中的服务
- 开源 README / docs / License / CI

## 近期关键修复

- 修复 `bash scripts/install.sh` 后 `roo` 命令不可用的问题
- 修复 CLI 改完规则 / upstream 后，运行中的服务与 dashboard 不同步的问题
- 完整实测了 local 模式首次使用路径
- 完整实测了 gist 模式在线更新路径

## 快速开始

### 最简单方式

```bash
bash scripts/install.sh
```

脚本会：

- 安装依赖
- 安装全局 `roo` 命令
- 引导你选择 `local` 或 `gist`
- 自动写 `.env`
- 自动启动服务

### 手动方式

```bash
npm install
npm install -g .
roo init
npm run serve
```

## 相关文档

- README：项目总览、首次使用路径、local/gist 两种模式说明
- docs/development.md：开发说明
- docs/api-overview.md：CLI 与 dashboard 简介
- docs/roadmap.md：后续计划
- examples/roo-config.example.json：示例 Gist 配置模板

## 验证结果

本项目已完成以下真实链路验证：

### local 模式

```bash
bash scripts/install.sh
roo add openai.com
roo upstream add residential-01 socks5://user:pass@127.0.0.1:1080
roo show
roo status
```

### gist 模式

```bash
roo init
# 选择 gist
roo add example-gist-test.com
roo upstream add gist-node socks5://user:pass@127.0.0.1:3080
roo show
roo status
```

两种模式下都已确认：

- 配置写入成功
- 运行中的服务自动 reload
- `roo show` 与 `roo status` 保持一致
