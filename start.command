#!/bin/bash
# Responsibility: Launch the desktop pet from source by double-clicking this file.
# Implementation: 1. Resolve the repository root. 2. Load the installed Node path. 3. Run Electron.
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
if [[ -x "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x "/usr/local/bin/brew" ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
npm start
