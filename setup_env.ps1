# 一键安装桌宠运行环境（Windows）
# 用法：以普通用户运行即可（需要联网）
# 若执行策略拦截，请用：powershell -ExecutionPolicy Bypass -File setup_env.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Test-Command($name) {
  $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($machine + ";" + $user)
}

function Ensure-Winget {
  if (Test-Command "winget") { return }
  Write-Err "未检测到 winget。请先从 Microsoft Store 安装 'App Installer'，然后重试。"
  throw "winget_missing"
}

function Install-WingetPackage($id, $name) {
  Write-Info "检查 $name..."
  $found = winget list --id $id -e 2>$null
  if ($LASTEXITCODE -eq 0 -and $found) {
    Write-Info "$name 已安装。"
    return
  }
  Write-Info "安装 $name..."
  winget install --id $id -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "install_failed_$id" }
}

function Get-PythonCommand {
  if (Test-Command "py") {
    try {
      $ver = & py -3.11 -V 2>$null
      if ($LASTEXITCODE -eq 0 -and $ver) { return "py -3.11" }
    } catch {}
  }
  if (Test-Command "python") { return "python" }
  return $null
}

Write-Info "开始检查环境..."

Ensure-Winget

# 安装 Python 3.11（优先）
$pyCmd = Get-PythonCommand
if (-not $pyCmd) {
  Install-WingetPackage "Python.Python.3.11" "Python 3.11"
  Refresh-Path
  $pyCmd = Get-PythonCommand
}
if (-not $pyCmd) { throw "python_install_failed" }

# 安装 Node.js LTS
if (-not (Test-Command "node")) {
  Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"
  Refresh-Path
}
if (-not (Test-Command "node")) { throw "node_install_failed" }
if (-not (Test-Command "npm")) { throw "npm_missing" }

Write-Info "创建并配置 Python 虚拟环境..."
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $projectRoot ".venv"

if (-not (Test-Path $venvPath)) {
  & $pyCmd -m venv $venvPath
}

$venvPython = Join-Path $venvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) { throw "venv_python_missing" }

& $venvPython -m pip install --upgrade pip

Write-Info "安装 Python 依赖..."
$reqFile = Join-Path $projectRoot "requirements.txt"
if (-not (Test-Path $reqFile)) { throw "requirements_missing" }

try {
  & $venvPython -m pip install -r $reqFile
} catch {
  Write-Warn "requirements 安装失败，尝试单独安装 PyAudio 的二进制包..."
  & $venvPython -m pip install --only-binary=:all: pyaudio
  & $venvPython -m pip install websockets==15.0.1
}

Write-Info "安装 Node 依赖..."
Push-Location $projectRoot
npm install
Pop-Location

# 自动创建桌面快捷方式（启动脚本）
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop '桌宠启动.lnk'
  $targetPath = Join-Path $projectRoot 'start_silent.vbs'

  if (Test-Path $targetPath) {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $targetPath
    $shortcut.WorkingDirectory = $projectRoot
    $iconPath = Join-Path $projectRoot 'icon.ico'
    if (Test-Path $iconPath) {
      $shortcut.IconLocation = $iconPath
    }
    $shortcut.Save()
    Write-Info "已创建桌面快捷方式：桌宠启动"
  } else {
    Write-Warn "未找到 start_silent.vbs，跳过创建桌面快捷方式。"
  }
} catch {
  Write-Warn "创建桌面快捷方式失败，可忽略：$($_.Exception.Message)"
}

Write-Info "完成。现在可以运行："
Write-Host "  1) 双击 start_silent.vbs 直接启动" -ForegroundColor Green
Write-Host "  2) 或在命令行执行 npm start" -ForegroundColor Green
Write-Host "如果需要一键安装并启动：双击 install_and_run.bat" -ForegroundColor Green
