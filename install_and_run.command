#!/bin/bash
# macOS 一键安装并启动桌宠
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

bash "$PROJECT_DIR/setup_env.command"

echo "[INFO] 正在启动桌宠..."
npm start
