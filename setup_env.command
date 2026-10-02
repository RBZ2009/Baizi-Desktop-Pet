#!/bin/bash
# macOS 一键安装桌宠运行环境
set -e

say_info() { echo "[INFO] $1"; }
say_warn() { echo "[WARN] $1"; }
say_err()  { echo "[ERROR] $1"; }

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if [[ -x "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x "/usr/local/bin/brew" ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

say_info "开始检查环境..."

# 1) 检查 Homebrew
if ! command -v brew >/dev/null 2>&1; then
  say_warn "未检测到 Homebrew，开始自动安装（可能需要输入系统密码）..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

if ! command -v brew >/dev/null 2>&1; then
  say_err "Homebrew 安装失败，请手动安装后重试。"
  exit 1
fi

# 2) 安装 Python 3.11（优先）
if ! command -v python3.11 >/dev/null 2>&1; then
  say_info "安装 Python 3.11..."
  brew install python@3.11
fi

PYTHON_BIN="$(command -v python3.11 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON_BIN" ]]; then
  say_err "未找到可用 Python。"
  exit 1
fi

# 3) 安装 PyAudio 需要的系统依赖
if ! brew list --versions portaudio >/dev/null 2>&1; then
  say_info "安装 PortAudio（PyAudio 需要）..."
  brew install portaudio
fi

# 4) 安装 Node.js LTS，并确保 npm 可用
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  say_info "安装 Node.js LTS..."
  brew install node

  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  say_err "Node.js/npm 安装失败。"
  exit 1
fi

# 5) 配置 Python 虚拟环境
say_info "创建并配置 Python 虚拟环境..."
VENV_DIR="$PROJECT_DIR/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
if [[ ! -x "$VENV_PYTHON" ]]; then
  say_err "虚拟环境创建失败。"
  exit 1
fi

"$VENV_PYTHON" -m pip install --upgrade pip

# 6) 安装 Python 依赖
if [[ ! -f "$PROJECT_DIR/requirements.txt" ]]; then
  say_err "缺少 requirements.txt"
  exit 1
fi

say_info "安装 Python 依赖..."
if ! "$VENV_PYTHON" -m pip install -r "$PROJECT_DIR/requirements.txt"; then
  say_warn "requirements 安装失败，尝试分步安装..."
  "$VENV_PYTHON" -m pip install websockets==15.0.1
  "$VENV_PYTHON" -m pip install pyaudio || say_warn "PyAudio 失败（若你不使用语音输入可忽略）"
fi

# 7) 安装 Node 依赖
say_info "安装 Node 依赖..."
npm install

# 8) 创建双击启动脚本
RUN_SCRIPT="$PROJECT_DIR/双击_启动桌宠.command"
cat > "$RUN_SCRIPT" << 'EOF'
#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
if [[ -x "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x "/usr/local/bin/brew" ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
npm start
EOF
chmod +x "$RUN_SCRIPT"

say_info "完成。"
echo "------------------------------------------"
echo "首次运行：双击  install_and_run.command"
echo "后续运行：双击  双击_启动桌宠.command"
echo "------------------------------------------"
if [[ -t 0 ]]; then
  read -n 1 -s -r -p "按任意键退出..."
  echo
fi
