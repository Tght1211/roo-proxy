#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT_BRANCH="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || echo main)"

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
require_command npm
require_command node

if [ ! -d "$ROOT_DIR/.git" ]; then
  print_line "[错误] 当前目录不是 Git 仓库：$ROOT_DIR"
  exit 1
fi

if [ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)" ]; then
  print_line "[错误] 检测到未提交的代码改动。"
  print_line "请先提交或暂存这些改动，再执行更新脚本。"
  exit 1
fi

print_line "========================================"
print_line "Roo 更新脚本"
print_line "目录：$ROOT_DIR"
print_line "分支：$CURRENT_BRANCH"
print_line "========================================"

print_line "正在拉取最新代码..."
git -C "$ROOT_DIR" fetch --all --tags
git -C "$ROOT_DIR" checkout "$CURRENT_BRANCH"
git -C "$ROOT_DIR" pull --ff-only origin "$CURRENT_BRANCH"

print_line "正在安装依赖..."
npm install --prefix "$ROOT_DIR"

print_line "正在刷新全局 roo 命令..."
npm install -g "$ROOT_DIR"

print_line "正在重启 Roo..."
node "$ROOT_DIR/cli/index.js" restart

print_line "更新完成。"
print_line "你现在可以执行："
print_line "- node \"$ROOT_DIR/cli/index.js\" ps"
print_line "- node \"$ROOT_DIR/cli/index.js\" ip"
