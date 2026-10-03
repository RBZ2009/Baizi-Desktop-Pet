#!/bin/bash
# Responsibility: Prepare dependencies and launch the desktop pet from source.
# Implementation: 1. Resolve the repository root. 2. Run Node setup. 3. Start Electron.
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

bash "$PROJECT_DIR/scripts/setup-env.command"

echo "[INFO] 正在启动桌宠..."
npm start
