# Responsibility: Install the Node.js development runtime on Windows.
# Implementation: 1. Reuse Node when present. 2. Install through winget when needed. 3. Restore locked dependencies without Python.
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $projectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "请安装 Node.js 22.12 或更新版本：https://nodejs.org/" }
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Node.js 安装失败" }
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = ($machinePath + ";" + $userPath)
}
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12)){console.error("需要 Node.js 22.12 或更新版本");process.exit(1)}'
if ($LASTEXITCODE -ne 0) { throw "Node.js 版本过低" }
npm ci
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }
Write-Host "环境准备完成。运行 npm start 启动。系统语音目前仅支持 macOS。"
