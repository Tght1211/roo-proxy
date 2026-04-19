#!/usr/bin/env bash
# Roo 安装脚本：支持交互式（TTY）与一键非交互式（curl | bash / CI）两种模式。
# 非交互默认：CONFIG_SOURCE=local / LOCAL_PORT=9999 / DASHBOARD_PORT=10000
# 环境变量覆盖（脚本开头即可读）：
#   ROO_CONFIG_SOURCE=local|gist
#   ROO_LOCAL_PORT=9999
#   ROO_DASHBOARD_PORT=10000
#   ROO_GIST_ID / ROO_GITHUB_TOKEN
#   ROO_SKIP_AUTOSTART=1   禁用 macOS LaunchAgent 自启
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_ENV_FILE="$ROOT_DIR/.env.example"
LOCAL_CONFIG_PATH="data/roo-config.json"
GLOBAL_NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
GLOBAL_NPM_BIN="${GLOBAL_NPM_PREFIX:+$GLOBAL_NPM_PREFIX/bin}"

# ---- 解析参数 ----
NONINTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--noninteractive|--non-interactive)
      NONINTERACTIVE=1
      ;;
    -h|--help)
      cat <<'HELP'
用法: bash scripts/install.sh [选项]

选项:
  -y, --yes    非交互式安装，使用默认值或环境变量
  -h, --help   显示帮助

环境变量（任一模式均可用）:
  ROO_CONFIG_SOURCE      local (默认) 或 gist
  ROO_LOCAL_PORT         默认 9999
  ROO_DASHBOARD_PORT     默认 10000
  ROO_GIST_ID            gist 模式必填
  ROO_GITHUB_TOKEN       gist 模式必填
  ROO_SKIP_AUTOSTART=1   跳过 macOS LaunchAgent 自启注册
HELP
      exit 0
      ;;
  esac
done

# stdin 不是 tty 时自动进入非交互模式（curl | bash 场景）
if [ ! -t 0 ]; then
  NONINTERACTIVE=1
fi

print_line() { printf '%s\n' "$1"; }

prompt_default() {
  # prompt_default VAR "提示文案" "默认值"
  local __var="$1" __msg="$2" __default="$3" __input=""
  if [ "$NONINTERACTIVE" = "1" ]; then
    eval "$__var=\"\${${__var}:-$__default}\""
    return
  fi
  printf '%s (默认 %s): ' "$__msg" "$__default"
  read -r __input || __input=""
  eval "$__var=\"\${__input:-$__default}\""
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
  if [ -f "$config_path" ]; then
    print_line "检测到已有本地规则文件，已保留：$LOCAL_CONFIG_PATH"
    return 0
  fi
  mkdir -p "$(dirname "$config_path")"
  cat > "$config_path" <<'EOF'
{
  "balance_strategy": "round-robin",
  "default_route": { "action": "direct", "upstreams": [] },
  "upstreams": [],
  "rules": []
}
EOF
}

cleanup_stale_roo_processes() {
  # 场景：上一次通过 LaunchAgent 启动的 Roo 已脱离 pm2，pm2 delete 清不到；
  # 且 LaunchAgent 的 KeepAlive=true 会在 5 秒内自动拉起，必须先 bootout 再 kill。
  local label="com.rooproxy.agent"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  if [ -f "$plist" ] && launchctl list "$label" >/dev/null 2>&1; then
    print_line "检测到旧的 LaunchAgent 在运行，先临时卸载以释放端口..."
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 \
      || launchctl unload "$plist" >/dev/null 2>&1 \
      || true
  fi

  local pids
  pids="$(pgrep -f "${ROOT_DIR}/server/index\.js" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  print_line "发现脱管的旧 Roo 进程 (PID: $(echo $pids))，正在清理..."
  kill $pids 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 6 ]; do
    pids="$(pgrep -f "${ROOT_DIR}/server/index\.js" 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  pids="$(pgrep -f "${ROOT_DIR}/server/index\.js" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    print_line "[清理] SIGTERM 超时，发送 SIGKILL..."
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

ensure_port_free() {
  local port="$1"
  local label="$2"
  local listeners
  listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$listeners" ]; then
    print_line ""
    print_line "[错误] $label $port 已被其他进程占用，Roo 无法安全启动。"
    print_line "占用详情：$listeners"
    print_line ""
    print_line "解决办法二选一："
    print_line "  1) 关闭占用该端口的进程后重跑本脚本"
    print_line "  2) 用环境变量改端口再跑："
    print_line "     ROO_LOCAL_PORT=9998 ROO_DASHBOARD_PORT=10001 bash scripts/install.sh --yes"
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
  print_line "请执行： pm2 list 和 pm2 logs roo --lines 50 查看原因。"
  exit 1
}

print_line "========================================"
print_line "Roo 一键安装脚本 ($([ "$NONINTERACTIVE" = "1" ] && echo '非交互模式' || echo '交互模式'))"
print_line "========================================"

# ---- 环境检查 ----
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

if ! command -v pm2 >/dev/null 2>&1; then
  print_line "未检测到 pm2，自动安装中..."
  npm install -g pm2
  if ! command -v pm2 >/dev/null 2>&1; then
    print_line "[错误] pm2 自动安装失败，请手动执行：npm install -g pm2"
    exit 1
  fi
  print_line "[OK] pm2 已安装"
else
  print_line "[OK] 已检测到 pm2"
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
  print_line "当前 Node.js 版本过低（需 >= 18）。"
  exit 1
fi

# ---- 安装依赖 ----
print_line ""
print_line "正在安装项目依赖..."
npm install --prefix "$ROOT_DIR" --no-audit --no-fund

print_line "正在安装 roo CLI 命令..."
npm install -g "$ROOT_DIR" --no-audit --no-fund

if [ ! -f "$EXAMPLE_ENV_FILE" ]; then
  print_line ".env.example 不存在，安装脚本无法继续。"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_ENV_FILE" "$ENV_FILE"
fi

# ---- 配置收集 ----
print_line ""
print_line "正在初始化 Roo 配置..."

prompt_default CONFIG_SOURCE "配置模式 local/gist" "${ROO_CONFIG_SOURCE:-local}"
if [ "$CONFIG_SOURCE" != "local" ] && [ "$CONFIG_SOURCE" != "gist" ]; then
  print_line "[错误] 不支持的配置模式：$CONFIG_SOURCE（应为 local 或 gist）"
  exit 1
fi

prompt_default LOCAL_PORT "本地代理端口" "${ROO_LOCAL_PORT:-9999}"
prompt_default DASHBOARD_PORT "Dashboard 端口" "${ROO_DASHBOARD_PORT:-10000}"

if [ "$LOCAL_PORT" = "$DASHBOARD_PORT" ]; then
  print_line "[错误] 本地代理端口与 Dashboard 端口不能相同。"
  exit 1
fi

set_env_value "CONFIG_SOURCE" "$CONFIG_SOURCE"
set_env_value "LOCAL_CONFIG_PATH" "$LOCAL_CONFIG_PATH"
set_env_value "LOCAL_PORT" "$LOCAL_PORT"
set_env_value "DASHBOARD_PORT" "$DASHBOARD_PORT"

if [ "$CONFIG_SOURCE" = "gist" ]; then
  if [ -z "${ROO_GIST_ID:-}" ]; then
    prompt_default GIST_ID "GitHub Private Gist ID" ""
  else
    GIST_ID="$ROO_GIST_ID"
  fi
  if [ -z "${ROO_GITHUB_TOKEN:-}" ]; then
    prompt_default GITHUB_TOKEN "GitHub Token" ""
  else
    GITHUB_TOKEN="$ROO_GITHUB_TOKEN"
  fi
  if [ -z "$GIST_ID" ] || [ -z "$GITHUB_TOKEN" ]; then
    print_line "[警告] gist 模式但缺少 GIST_ID / GITHUB_TOKEN。请装完后在 .env 补齐，否则会自动回退到 local。"
  fi
  set_env_value "GIST_ID" "$GIST_ID"
  set_env_value "GITHUB_TOKEN" "$GITHUB_TOKEN"
  print_line "已写入 gist 模式配置。"
else
  set_env_value "GIST_ID" ""
  set_env_value "GITHUB_TOKEN" ""
  write_local_config
  print_line "已生成本地规则文件：$LOCAL_CONFIG_PATH"
fi

# ---- 启动服务 ----
print_line ""
print_line "正在清理旧的 pm2 Roo 进程..."
pm2 delete roo >/dev/null 2>&1 || true

cleanup_stale_roo_processes

ensure_port_free "$LOCAL_PORT" "本地代理端口"
ensure_port_free "$DASHBOARD_PORT" "Dashboard 端口"

# 如果用户 shell 里 export 了 ALL_PROXY=socks5://127.0.0.1:$LOCAL_PORT 之类（把 Roo 当系统代理），
# 这些会被 pm2 继承到 Roo 子进程，导致 Roo 自循环。启动前临时清掉指向自身端口的代理环境变量。
for __pv in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
  __val="$(eval echo "\${$__pv:-}")"
  if [ -n "$__val" ] && printf '%s' "$__val" | grep -qE "://(127\.0\.0\.1|localhost):${LOCAL_PORT}(/|$)"; then
    print_line "[清理] 临时清除自循环代理变量 $__pv=$__val"
    unset "$__pv"
  fi
done

print_line "正在使用 pm2 启动 Roo 服务..."
pm2 start "$ROOT_DIR/server/ecosystem.config.js" --silent --update-env
verify_roo_started "$DASHBOARD_PORT"
pm2 save >/dev/null 2>&1 || true
print_line "[OK] Roo 已通过 pm2 启动。"

# ---- 自启动（macOS 优先 LaunchAgent，无需 sudo） ----
if [ "${ROO_SKIP_AUTOSTART:-0}" = "1" ]; then
  print_line "跳过自启动配置（ROO_SKIP_AUTOSTART=1）。"
elif [ "$(uname)" = "Darwin" ]; then
  print_line "正在配置 macOS 登录自启（LaunchAgent，无需 sudo）..."
  if bash "$ROOT_DIR/scripts/install-autostart.sh" >/dev/null 2>&1; then
    print_line "[OK] 已注册 LaunchAgent，开机登录后 Roo 自动启动，崩溃 5 秒内自动拉起。"
  else
    print_line "[警告] LaunchAgent 注册失败，稍后可手动执行：bash $ROOT_DIR/scripts/install-autostart.sh"
  fi
else
  print_line "检测到非 macOS 系统，尝试使用 pm2 startup 注册开机自启（可能需要 sudo）..."
  pm2 startup >/dev/null 2>&1 || print_line "[提示] pm2 startup 需要 sudo 才能生效，请按其输出手动执行。"
fi

# ---- 完成提示 ----
print_line ""
print_line "========================================"
print_line "  ✅ Roo 安装完成！"
print_line "========================================"
print_line ""
print_line "  Dashboard : http://127.0.0.1:${DASHBOARD_PORT}"
print_line "  本地代理  : 127.0.0.1:${LOCAL_PORT}  (HTTP / HTTPS / SOCKS5 同端口)"
print_line ""
print_line "  常用命令  : roo status / roo show / roo logs --n=50"
print_line "  卸载自启  : bash $ROOT_DIR/scripts/uninstall-autostart.sh"
print_line ""

if ! command -v roo >/dev/null 2>&1; then
  print_line "  ⚠️  当前 shell 未刷新 PATH；执行 hash -r 或重新开终端即可使用 roo 命令。"
  if [ -n "$GLOBAL_NPM_BIN" ]; then
    print_line "     临时可用：$GLOBAL_NPM_BIN/roo --help"
  fi
fi

print_line "========================================"
