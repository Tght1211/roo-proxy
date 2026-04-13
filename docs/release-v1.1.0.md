# Roo v1.1.0 更新说明

## 本次版本重点

- 支持更贴近真实使用场景的双层代理链路
  - 默认流量可保持直连 / 系统路由
  - 命中规则的流量可单独切到静态住宅出口
- CLI 运维能力大幅简化
  - 新增 `roo up/down/restart/ps/ip/check`
- 规则能力升级为多类型匹配
  - `domain-suffix`
  - `domain-exact`
  - `domain-keyword`
  - `ipv4-cidr`
  - `ipv6-cidr`
  - `geo-country`
  - `geo-region`
- 补充真实可复制的一键部署入口
  - 新增 `scripts/bootstrap.sh`
  - README 支持远程一行命令安装
- 增加自动化测试基线
  - 配置归一化测试
  - 路由匹配测试
  - 代理链路集成测试

## 这次解决了什么问题

### 1. 现有 VPN 与 Roo 端口冲突

现在支持让：

- VPN 保持监听原有本地端口
- Roo 改为监听独立端口
- 浏览器只连 Roo
- Roo 再按规则决定是否切住宅出口

### 2. 之前规则模型太单一

此前项目只适合“域名后缀匹配”。  
现在已经可以覆盖：

- 精确域名
- 域名关键词
- IPv4 / IPv6 网段
- 国家 / 地区

### 3. 运维命令太碎

之前很多操作要混用 `npm run ...`、`curl`、`roo status`。  
现在收敛成：

```bash
roo up
roo down
roo restart
roo ps
roo ip
roo check https://checkip.amazonaws.com
```

## 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/Tght1211/roo-proxy/main/scripts/bootstrap.sh | bash
```

默认会：

- 克隆或更新仓库
- 进入仓库目录
- 执行交互式安装脚本

## 本次发布包含

- 多类型规则匹配引擎
- 更清晰的默认出口 / 指定出口模型
- 更易用的 CLI 运维命令
- 一键部署脚本
- 更新后的 README 与 API 文档
- 新增测试与回归验证

## 验证结果

本次已完成以下验证：

- `npm test`
- `roo up`
- `roo down`
- `roo restart`
- `roo ps`
- `roo ip`

并已确认：

- `checkip.amazonaws.com` 命中规则后，出口为指定住宅 IP
- 重复启动 Roo 时会提示“已在运行”，不再误导用户
- 服务可以通过 `pm2` 方式稳定托管

## 打包方式

```bash
npm test
npm run release:pack
```

默认会在本地 `release/` 目录生成发布包。
