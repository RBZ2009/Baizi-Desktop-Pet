#!/bin/bash
# Responsibility: Start the maintained macOS installation entry point.
# Implementation: 1. Resolve the repository root. 2. Delegate setup and launch to scripts/.
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
bash "$PROJECT_DIR/scripts/install-and-run.command"
