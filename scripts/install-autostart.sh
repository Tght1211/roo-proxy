#!/usr/bin/env bash
# 安装 macOS LaunchAgent，使 Roo 在登录后自动后台启动，崩溃自动拉起。
# 不需要 sudo，装在 ~/Library/LaunchAgents/ 下。
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.rooproxy.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$ROOT_DIR/logs"
OUT_LOG="$LOG_DIR/launchagent.out.log"
ERR_LOG="$LOG_DIR/launchagent.err.log"

print_line() { printf '%s\n' "$1"; }

if [ "$(uname)" != "Darwin" ]; then
  print_line "[错误] 本脚本仅支持 macOS。"
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  print_line "[错误] 未找到 node，可执行：brew install node 或 nvm install --lts"
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_PATH")"

# 如果旧的 Agent 已加载，先卸载，避免 plist 更新后被旧内容拖住
if launchctl list "$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 \
    || launchctl unload "$PLIST_PATH" >/dev/null 2>&1 \
    || true
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ROOT_DIR}/server/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
PLIST

# 校验 plist 语法
if ! plutil -lint "$PLIST_PATH" >/dev/null; then
  print_line "[错误] 生成的 plist 校验失败：$PLIST_PATH"
  exit 1
fi

# 加载并启动
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null \
  || launchctl load -w "$PLIST_PATH"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true

print_line "========================================"
print_line "Roo 自启动已配置"
print_line "Label       : ${LABEL}"
print_line "plist       : ${PLIST_PATH}"
print_line "工作目录    : ${ROOT_DIR}"
print_line "Node        : ${NODE_BIN}"
print_line "输出日志    : ${OUT_LOG}"
print_line "错误日志    : ${ERR_LOG}"
print_line ""
print_line "服务会在你登录后自动启动；崩溃后 5 秒内自动拉起。"
print_line ""
print_line "常用命令："
print_line "  查看状态 : launchctl list | grep ${LABEL}"
print_line "  手动重启 : launchctl kickstart -k gui/\$UID/${LABEL}"
print_line "  卸载自启 : bash scripts/uninstall-autostart.sh"
print_line "========================================"
