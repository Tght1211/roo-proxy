# Roo v1.0.0 首发说明

## 亮点

- 本地 HTTP CONNECT 代理
- GitHub Private Gist 规则配置
- 多 upstream 负载均衡
- upstream 健康检查与自动恢复
- 本地 dashboard 面板
- `roo` CLI 管理命令
- 一键安装与环境自检

## 适合谁

- 需要个人代理路由管理的开发者
- 想把特定域名流量走住宅 IP 的用户
- 希望通过 Gist 远程维护规则、又不想搭建复杂控制面的使用者

## 本次发布包含

- 核心代理服务
- CLI 管理工具
- Dashboard 运维面板
- 安装脚本与 doctor 自检
- 开源 README / docs / License / CI

## 快速开始

```bash
npm install
cp .env.example .env
npm run serve
```

配置好 `GIST_ID` 和 `GITHUB_TOKEN` 后即可使用。

## 相关文档

- README：项目总览与快速开始
- docs/development.md：开发说明
- docs/api-overview.md：CLI 与 dashboard 简介
- docs/roadmap.md：后续计划
- examples/roo-config.example.json：示例 Gist 配置模板
