#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_ENV_FILE="$ROOT_DIR/.env.example"
LOCAL_CONFIG_PATH="data/roo-config.json"
GLOBAL_NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
GLOBAL_NPM_BIN="${GLOBAL_NPM_PREFIX:+$GLOBAL_NPM_PREFIX/bin}"

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

write_local_config() {
  local config_path="$ROOT_DIR/$LOCAL_CONFIG_PATH"
  mkdir -p "$(dirname "$config_path")"
  cat > "$config_path" <<'EOF'
{
  "balance_strategy": "round-robin",
  "upstreams": [],
  "rules": [
    "example.com"
  ]
}
EOF
}

ensure_port_free() {
  local port="$1"
  local label="$2"
  local listeners
  listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"

  if [ -n "$listeners" ]; then
    print_line ""
    print_line "[错误] $label $port 已被其他进程占用，Roo 无法安全启动。"
    print_line "请先关闭占用该端口的进程，再重新运行安装脚本。"
    print_line "占用详情："
    print_line "$listeners"
    print_line ""
    print_line "常见原因："
    print_line "- 你之前手动运行过 node server/index.js"
    print_line "- 你之前启动过另一个 Roo 实例"
    print_line "- 其他代理程序占用了同一端口"
    exit 1
  fi
}

verify_roo_started() {
  local dashboard_port="$1"
  local retries=20

  while [ "$retries" -gt 0 ]; do
    if curl -fsS "http://127.0.0.1:${dashboard_port}/status" >/dev/null 2>&1; then
      return 0
    fi

    retries=$((retries - 1))
    sleep 1
  done

  print_line ""
  print_line "[错误] Roo 启动后未能在预期端口提供 dashboard 服务。"
  print_line "这通常意味着："
  print_line "- 选定端口被占用"
  print_line "- pm2 中旧的 Roo 进程没有正确释放端口"
  print_line "- Roo 进程启动后立即报错退出"
  print_line ""
  print_line "请先查看："
  print_line "- pm2 list"
  print_line "- pm2 logs roo --lines 50"
  exit 1
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

if ! require_command lsof; then
  print_line "未检测到 lsof，安装脚本需要它来检查端口占用。"
  exit 1
fi

if ! require_command curl; then
  print_line "未检测到 curl，安装脚本需要它来验证 Roo 是否真的启动成功。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  print_line "当前 Node.js 版本过低，请升级到 18 或更高版本。"
  exit 1
fi

print_line "开始安装项目依赖..."
npm install --prefix "$ROOT_DIR"

print_line "正在安装 roo CLI 命令..."
npm install -g "$ROOT_DIR"

if [ ! -f "$EXAMPLE_ENV_FILE" ]; then
  print_line ".env.example 不存在，安装脚本无法继续。"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_ENV_FILE" "$ENV_FILE"
fi

print_line "现在开始初始化 Roo 配置。"
print_line "推荐新手先使用 local 模式，先在本机跑通；以后再切到 gist 在线更新。"
printf '请选择配置模式（local/gist，默认 local）: '
read -r CONFIG_SOURCE
CONFIG_SOURCE="${CONFIG_SOURCE:-local}"

set_env_value "CONFIG_SOURCE" "$CONFIG_SOURCE"
set_env_value "LOCAL_CONFIG_PATH" "$LOCAL_CONFIG_PATH"

printf '本地代理端口（默认 7890）: '
read -r LOCAL_PORT
LOCAL_PORT="${LOCAL_PORT:-7890}"
set_env_value "LOCAL_PORT" "$LOCAL_PORT"

printf 'Dashboard 端口（默认 7891）: '
read -r DASHBOARD_PORT
DASHBOARD_PORT="${DASHBOARD_PORT:-7891}"
set_env_value "DASHBOARD_PORT" "$DASHBOARD_PORT"

if [ "$LOCAL_PORT" = "$DASHBOARD_PORT" ]; then
  print_line "本地代理端口和 Dashboard 端口不能相同，请重新运行安装脚本。"
  exit 1
fi

if [ "$CONFIG_SOURCE" = "gist" ]; then
  printf 'GitHub Private Gist ID: '
  read -r GIST_ID
  printf 'GitHub Token: '
  read -r GITHUB_TOKEN
  set_env_value "GIST_ID" "$GIST_ID"
  set_env_value "GITHUB_TOKEN" "$GITHUB_TOKEN"
  print_line "已写入 gist 模式配置。后续你可以用 roo add / roo upstream add 直接在线更新规则。"
else
  set_env_value "GIST_ID" ""
  set_env_value "GITHUB_TOKEN" ""
  write_local_config
  print_line "已生成本地规则文件：$LOCAL_CONFIG_PATH"
  print_line "默认已经写入一条示例规则 example.com，方便你立刻启动测试。"
fi

print_line "正在清理旧的 pm2 Roo 进程..."
pm2 delete roo >/dev/null 2>&1 || true

ensure_port_free "$LOCAL_PORT" "本地代理端口"
ensure_port_free "$DASHBOARD_PORT" "Dashboard 端口"

print_line "正在使用 pm2 启动 Roo 服务..."
pm2 start "$ROOT_DIR/server/ecosystem.config.js"
verify_roo_started "$DASHBOARD_PORT"

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
print_line ""
print_line "你现在可以这样开始使用："
print_line "1. 查看状态：roo status"
print_line "2. 查看完整配置：roo show"
print_line "3. 添加规则：roo add openai.com"
print_line "4. 添加 upstream：roo upstream add residential-01 socks5://user:pass@host:1080"
print_line "5. 手动重载配置：roo reload"
print_line "6. 打开面板：http://127.0.0.1:${DASHBOARD_PORT}"
print_line ""
print_line "浏览器代理设置："
print_line "- 地址：127.0.0.1"
print_line "- 端口：${LOCAL_PORT}"
print_line ""
if command -v roo >/dev/null 2>&1; then
  print_line "roo 命令已安装成功，可直接使用。"
else
  print_line "警告：roo 命令已安装，但当前 shell 可能还没刷新 PATH。"
  if [ -n "$GLOBAL_NPM_BIN" ]; then
    print_line "请确认以下目录在你的 PATH 中："
    print_line "- $GLOBAL_NPM_BIN"
    print_line "如果刚安装完成，可执行：hash -r"
    print_line "临时使用也可以直接执行：$GLOBAL_NPM_BIN/roo --help"
  else
    print_line "你也可以临时在项目目录中执行：node cli/index.js --help"
  fi
fi
print_line ""
print_line "重要：请确认你的浏览器 / 系统代理端口与上面显示的端口完全一致。"
print_line "如果你访问 ping0.cc 看到的还是旧出口，大概率是浏览器没有连到 Roo 当前监听端口。"
print_line ""
print_line "如果你是第一次使用，推荐接下来执行："
print_line "- roo add openai.com"
print_line "- roo upstream add residential-01 socks5://user:pass@host:1080"
print_line "- roo show"
print_line "========================================"
