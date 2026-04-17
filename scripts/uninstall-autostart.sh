#!/usr/bin/env bash
# 卸载 Roo 的 macOS LaunchAgent 自启动。
set -e

LABEL="com.rooproxy.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

print_line() { printf '%s\n' "$1"; }

if [ "$(uname)" != "Darwin" ]; then
  print_line "[错误] 本脚本仅支持 macOS。"
  exit 1
fi

if [ ! -f "$PLIST_PATH" ]; then
  print_line "未找到 ${PLIST_PATH}，似乎本来就没装自启动。"
  exit 0
fi

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 \
  || launchctl unload "$PLIST_PATH" >/dev/null 2>&1 \
  || true

rm -f "$PLIST_PATH"
print_line "Roo 自启动已卸载：${PLIST_PATH}"
print_line "注意：只是停止开机自启；如果你当前还在用 pm2 运行 Roo，请另外通过 pm2 控制。"
