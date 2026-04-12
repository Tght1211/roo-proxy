#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_ENV_FILE="$ROOT_DIR/.env.example"

print_line() {
  printf '%s\n' "$1"
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    print_line "[OK] 已检测到 $1"
    return 0
  fi

  print_line "[缺失] 未检测到 $1"
  return 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines()
updated = False
for index, line in enumerate(lines):
    if line.startswith(key + '='):
        lines[index] = f"{key}={value}"
        updated = True
        break
if not updated:
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n")
PY
}

print_line "========================================"
print_line "欢迎使用 Roo 一键安装脚本"
print_line "========================================"

if ! require_command node; then
  print_line "请先安装 Node.js 18 或更高版本后再运行本脚本。"
  exit 1
fi

if ! require_command npm; then
  print_line "未检测到 npm，请先重新安装 Node.js。"
  exit 1
fi

if ! require_command python3; then
  print_line "未检测到 python3，安装脚本需要它来安全写入 .env。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  print_line "当前 Node.js 版本过低，请升级到 18 或更高版本。"
  exit 1
fi

if ! require_command pm2; then
  print_line "检测到你尚未安装 pm2。"
  printf '是否现在自动安装 pm2？(y/N): '
  read -r INSTALL_PM2
  if [ "$INSTALL_PM2" = "y" ] || [ "$INSTALL_PM2" = "Y" ]; then
    npm install -g pm2
  else
    print_line "已取消安装。请先执行 npm install -g pm2 后重新运行本脚本。"
    exit 1
  fi
fi

print_line "开始安装项目依赖..."
npm install --prefix "$ROOT_DIR"

if [ ! -f "$EXAMPLE_ENV_FILE" ]; then
  print_line ".env.example 不存在，安装脚本无法继续。"
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  print_line "检测到已有 .env 文件，将保留原配置。"
else
  cp "$EXAMPLE_ENV_FILE" "$ENV_FILE"
  print_line "即将生成 .env 文件，请输入以下信息。"
  printf 'Gist ID: '
  read -r GIST_ID
  printf 'GitHub Token: '
  read -r GITHUB_TOKEN

  set_env_value "GIST_ID" "$GIST_ID"
  set_env_value "GITHUB_TOKEN" "$GITHUB_TOKEN"
  print_line ".env 已生成完成。"
fi

print_line "正在使用 pm2 启动 Roo 服务..."
pm2 start "$ROOT_DIR/server/ecosystem.config.js"

print_line "正在尝试保存 pm2 开机自启配置..."
if pm2 save >/dev/null 2>&1; then
  print_line "pm2 save 已完成。"
else
  print_line "pm2 save 执行失败，可稍后手动执行。"
fi

if pm2 startup >/dev/null 2>&1; then
  print_line "pm2 startup 已完成。"
else
  print_line "pm2 startup 执行失败，通常是权限不足。你可以稍后手动执行 pm2 startup。"
fi

print_line "========================================"
print_line "Roo 安装完成"
print_line "本地代理：127.0.0.1:7890（默认）"
print_line "运维面板：http://127.0.0.1:7891"
print_line ""
print_line "浏览器代理设置方法："
print_line "1. Chrome：系统设置 -> 网络 -> 代理 -> 手动代理 -> HTTP/HTTPS 填 127.0.0.1:7890"
print_line "2. Safari：系统设置 -> 网络 -> 代理 -> 勾选 Web 代理(HTTP) 与安全 Web 代理(HTTPS)"
print_line "3. 如果你修改了 LOCAL_PORT，请改成你自己的端口。"
print_line ""
print_line "常用命令："
print_line "- npm run start"
print_line "- npm run stop"
print_line "- npm run restart"
print_line "- npm run logs"
print_line "- npm run doctor"
print_line "========================================"
