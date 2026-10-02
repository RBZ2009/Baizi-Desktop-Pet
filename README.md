# 桌宠（3D VRM 版）

这个项目是一个透明置顶的桌面宠物（Electron），支持：

- 拖动移动位置（鼠标左键拖拽）
- 点击反应（表情 + 头部动作 + 粒子）
- 随机眨眼（通过 VRM 表情，不会抖整张图）
- 右键菜单关闭、按 `Esc` 关闭

## Git 仓库

远程仓库：[RBZ2009/Baizi-Desktop-Pet](https://github.com/RBZ2009/Baizi-Desktop-Pet)，主分支为 `main`。

```bash
git clone git@github.com:RBZ2009/Baizi-Desktop-Pet.git
cd Baizi-Desktop-Pet
npm ci
npm start
```

上述克隆方式需要项目代码已推送到远程。语音功能还需按下文安装 Python 依赖，并在应用设置中配置自己的服务凭据。

版本管理包含源码、依赖锁文件、`assets/` 和页面实际引用的 `vendor/three/`。
`node_modules/`、`.venv/`、`dist/`、日志和本机配置由 `.gitignore` 排除。
本地旧测试脚本 `tts_probe.py`、`tts_probe_haha.py`、`白子语言.py` 含有硬编码凭据，
因此不纳入仓库；如需共享，先改为从环境变量读取凭据。请勿将 API Key、Token 或密码提交到 Git。

## 运行（推荐给普通用户）

### 第一次使用（最简单）

在 mac 上直接双击：

- `双击_第一次安装并启动.command`

它会自动：

1. 安装所需运行环境（Homebrew / Python / Node.js / 依赖）
2. 自动启动桌宠

### 之后再次启动

直接双击：

- `双击_启动桌宠.command`

### macOS 无法双击启动时

如果脚本是从飞书、浏览器或压缩包下载来的，macOS 可能会拦截 `.command` 文件。可以在项目目录执行：

```bash
chmod +x *.command
xattr -d com.apple.quarantine *.command
```

首次安装脚本会自动检查 Homebrew、Python、Node.js/npm、PortAudio、Python 依赖和 Node 依赖。

### 进阶方式（命令行）

在项目目录执行：

```bash
npm install
npm start
```

### 打包成 macOS 应用（启动时不显示命令行）

依赖安装完成后，在项目目录执行：

```bash
npm run dist:mac
```

打包完成后，打开 `dist` 目录里的：

- `白子桌宠-*.dmg`：安装到“应用程序”
- `mac-*/白子桌宠.app`：直接运行应用

以后直接双击 `白子桌宠.app` 即可启动，不会打开终端窗口。第一次安装仍建议使用
`双击_第一次安装并启动.command`，因为它负责准备 Homebrew、Node.js、Python 和相关依赖。

## 3D 模型放哪里？

把你的 VRM 模型文件放到：

- `assets/model.vrm`

然后重启应用即可加载 3D 人物。

如果没有 `assets/model.vrm`，会自动回退显示 `assets/pet.png`（2D 图片）。

## 如何获得 VRM（推荐两种方式）

- **VRoid Studio（最省事）**：用 VRoid 捏人并导出 VRM，然后替换为 `assets/model.vrm`。
- **Blender**：使用 VRM 插件/流程制作或转换模型，导出 VRM。

## 骨骼权重（Weight）怎么调整？

权重问题（例如挥手时手臂“塌陷”、裙子跟着腿一起扭、膝盖折成尖角）**需要在建模软件里修**，运行时只能暴露问题、不能真正改权重数据。

推荐用 Blender 修正后再重新导出 VRM：

- **准备**：安装 Blender + VRM 插件（常用是 VRM Add-on for Blender）
- **导入**：把 `model.vrm` 导入 Blender
- **定位问题骨骼**：比如右臂变形，就检查 `rightUpperArm/rightLowerArm/rightHand` 相关权重
- **Weight Paint 修正**：
  - 打开 **Weight Paint**，选中网格（身体/衣服/头发）
  - 开启 **Auto Normalize**（自动归一化）
  - 用 **Blur/Smooth** 平滑过渡，用 **Add/Subtract** 修正错分配
  - 对裙子/围巾/头发这种软体，避免被手臂/腿骨影响（清掉错误骨骼的权重）
  - 可使用 **Weights → Clean / Normalize All / Limit Total（4）**
- **导出**：重新导出 VRM，替换回 `assets/model.vrm`

小技巧：本项目里按键 `2/3/4`（挥手/走路/坐下）就是为了快速触发“最容易暴露权重问题”的姿态。
