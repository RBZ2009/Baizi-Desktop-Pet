#!/bin/bash
# Responsibility: Prepare the Node.js development runtime for the desktop pet.
# Implementation: 1. Reuse installed Node. 2. Install Node through Homebrew only if absent. 3. Restore locked dependencies.
set -e
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "请先安装 Node.js 22.12 或更新版本：https://nodejs.org/"
    exit 1
  fi
  brew install node
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) < 12)) { console.error("需要 Node.js 22.12 或更新版本"); process.exit(1); }'
npm ci
echo "环境准备完成。双击 start.command 启动，或运行 npm start。"
