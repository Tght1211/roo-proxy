# Roadmap

## v1 已完成

- [x] 本地 HTTP CONNECT 代理
- [x] GitHub Private Gist 配置拉取与刷新
- [x] 多 upstream 负载均衡
- [x] upstream 健康检查与恢复
- [x] CLI 管理命令
- [x] 本地 dashboard
- [x] 安装脚本与环境自检

## 后续计划

- [ ] 支持通配符规则与更细粒度分流
- [ ] 支持 upstream 延迟指标排序
- [ ] 支持 dashboard 页面更友好的表格展示
- [ ] 支持导出统计报表
- [ ] 支持配置变更审计日志

## 已知限制

- 当前配置源仅支持 GitHub Gist
- dashboard 仅监听本地，不提供鉴权与远程访问能力
- stats 目前为本地文件持久化，不适合多实例共享
- 浏览器代理设置截图暂未内置，需要后续补充实际图片资源
