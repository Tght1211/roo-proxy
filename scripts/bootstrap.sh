#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ROO_REPO_URL:-https://github.com/Tght1211/roo-proxy.git}"
REPO_REF="${ROO_REPO_REF:-main}"
INSTALL_DIR="${ROO_INSTALL_DIR:-$HOME/.roo-proxy}"

print_line() {
  printf '%s\n' "$1"
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi

  print_line "[错误] 缺少命令：$1"
  exit 1
}

require_command git
require_command bash

print_line "========================================"
print_line "Roo 一键部署脚本"
print_line "仓库地址：$REPO_URL"
print_line "目标目录：$INSTALL_DIR"
print_line "目标分支：$REPO_REF"
print_line "========================================"

if [ -d "$INSTALL_DIR/.git" ]; then
  print_line "检测到已有 Roo 工作目录，正在更新..."
  git -C "$INSTALL_DIR" fetch --all --tags
  git -C "$INSTALL_DIR" checkout "$REPO_REF"
  git -C "$INSTALL_DIR" pull --ff-only origin "$REPO_REF"
else
  if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
    print_line "[错误] 目标路径已存在且不是目录：$INSTALL_DIR"
    exit 1
  fi

  print_line "正在克隆 Roo 仓库..."
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
print_line "已进入目录：$INSTALL_DIR"

# curl | bash 场景下 stdin 是管道，install.sh 会自动走非交互模式；
# 本地直接执行 bootstrap.sh 时保持交互。显式传 --yes 兜底。
if [ -t 0 ]; then
  print_line "接下来将执行交互式安装脚本。"
  exec bash scripts/install.sh "$@"
else
  print_line "检测到管道环境，进入非交互一键安装模式。"
  exec bash scripts/install.sh --yes "$@"
fi
