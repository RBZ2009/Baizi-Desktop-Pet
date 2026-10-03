# 白子桌宠

透明置顶的 Electron / VRM 桌宠，保留拖动、点击反应、随机动作和表情。对话通过本地 gateway 调用兼容 Chat Completions 的大模型 API；聊天、会话摘要和长期记忆保存在本机 SQLite。

## 开始使用

### macOS 应用

打开打包后的 `白子桌宠.app`。应用自带 Electron、gateway 和数据库运行环境，不需要安装 Node.js、Python 或 PostgreSQL。

右键桌宠或点击托盘菜单，选择 **对话与记忆**：

1. 填写 API Base URL、模型名和 API Key，保存设置。
2. 点击 **测试模型连接**。此操作会发起一次真实 API 请求，使用已保存的设置。
3. 点击角色头部或按 **Ctrl + Enter** 打开聊天输入框，输入消息后按 Enter 发送，Shift + Enter 换行。
4. 再次点击头部关闭输入框。输入框中按 Escape 停止当前回复和播报并关闭输入框；发送新消息也会打断旧请求。

默认提供阿里云兼容接口地址和 `qwen-plus` 模型名称作为填写起点；API Key 需要用户自行提供。其他供应商需支持 `/chat/completions` 的 `messages`、`max_tokens` 和文字响应，流式 SSE 与普通 JSON 均可。

配置的上下文窗口不能超过模型真实上限。可选记忆提取模型也应支持相同接口，且窗口至少等于配置值。

### 从源码运行

需要 Node.js **22.12 或更新版本**：

```bash
git clone git@github.com:RBZ2009/Baizi-Desktop-Pet.git
cd Baizi-Desktop-Pet
npm ci
npm start
```

macOS 也可双击 `install-start.command` 准备依赖，之后双击 `start.command`。环境准备脚本位于 `scripts/`，Windows 对应 `scripts/setup-env.ps1`。
若已安装 Homebrew，安装脚本可自动安装缺失的 Node；否则会提示手动安装 Node。
当前聊天和系统语音不使用 Python。`archive/legacy-tts/` 中的旧 Python TTS 示例仅作历史参考，不被应用调用或打包。

下载的 `.command` 被 macOS 拦截时，可在项目目录执行：

```bash
chmod +x *.command
xattr -d com.apple.quarantine *.command
```

## 记忆与上下文

- **完整聊天**：按会话保存原文和状态，重启可恢复；失败、打断或达到输出上限的回复可查看，但不参与后续上下文和自动记忆。
- **短期上下文**：自动组合最近完整对话、较早历史摘要、相关长期记忆和当前输入。达到预算时压缩较早对话，原始聊天不会被删除。
- **长期记忆**：开启自动记忆后，每轮成功回复会触发后台提取，保存稳定事实、偏好、目标及明确要求记住的信息。无需用户逐条确认；提取失败会显示错误并有限重试。
- **手动管理**：在长期记忆页面添加、编辑、删除、查看原话来源和变更记录，必要时重试失败提取任务。
- **新会话**：重置短期上下文，保留长期记忆。历史页面可以切换回旧会话继续聊。
- **导出**：通过原生文件保存窗口导出聊天与记忆 JSON，不包含 API Key。

上下文采用保守的 UTF-8 字节预算，通常比供应商实际 token 数更大，因此可能较早触发摘要。摘要失败时使用有界的最近完整对话；原文仍在数据库中，并可在后续请求重试摘要。

记忆提取在后台完成，可能晚于文字回复。原话过长、API 不可用或返回格式无效时不会假报保存成功。删除记忆不会删除聊天原文，旧会话仍可能提及原话；新会话仅召回未删除的记忆。删除留下同主题的阻止标记，若希望重新记住，可在界面手动添加同主题记忆。

旧版最后 20 轮本地聊天会一次性导入独立的“旧版对话”会话，不自动提取为长期记忆。旧服务器数据库里的记忆需要另行导入，本项目不会连接旧 Coze 服务。

## 语音、人设与能力

对话与记忆设置中可开启 **macOS 系统语音**。默认中文声音为 `Tingting`，可调整声音和语速；系统已安装声音可在终端用 `say -v '?'` 查看。按完整句子排队播放，新请求和停止操作会中断旧播报。语音失败不影响已生成文字。实时双向语音的传输、临时凭据和回退设计见 [`docs/VOICE_ARCHITECTURE.md`](docs/VOICE_ARCHITECTURE.md)，当前版本默认不启用实时语音。

回复气泡是独立的置顶窗口，会根据角色窗口和当前显示器工作区自动计算位置；内容较长或角色靠近屏幕顶部时，会在角色下方显示并自动避开屏幕边界。气泡不会改变角色窗口的尺寸或拖动区域。

人设位于 `gateway/prompts/baizi.md`，结合寡言、行动派、重视伙伴和喜欢运动的原作基调，补充桌面陪伴者的生活方式。资料来源与原创扩展见 [`docs/PERSONA_SOURCES.md`](docs/PERSONA_SOURCES.md)。

在 **对话与记忆 → 模型设置** 中可以开关工具。当前提供时间、城市天气（Open-Meteo）、公开网页搜索（DuckDuckGo）、只读本地诊断和受限桌宠动作五类工具。查询内容会发送给对应服务，结果选入上下文后发送给模型。模型须支持标准 `tools/tool_calls`；不支持时自动退回文字回复。

工具回复与函数参数支持流式解析，一轮最多执行 6 次工具、1 次动作，再要求模型完成文字回答。参数、执行时间、网络返回大小和上下文占用均受限制；网页摘要不会被当作系统指令。搜索站点要求验证码或内容格式变化时会明确报错，不假报已搜索。

命令工具默认关闭，开启后仅允许 `pwd`、`date`、`whoami`、`uname`、`ls`、`git status`、`git log --oneline -5`。源码运行时工作目录为项目根目录，打包运行时为应用数据目录。它不执行任意 shell、项目脚本或 `npm test`，也不读取文件正文；命令结果会发送给模型。

模型可通过动作工具选择挥手、跳跃、跳舞、坐下和新增的点头、摇头、鞠躬、思考姿态。选择规则位于 `gateway/skills/pet-actions/SKILL.md`，由网关加载。动作在有限时长后恢复待机，用户拖动或暂停时用户交互优先。新增姿态由现有 VRM 骨骼生成，无需下载动作资源。

## 本地数据和凭据

数据放在 Electron `app.getPath('userData')/gateway/` 下，通常位于 macOS 的 `~/Library/Application Support/desktop-pet/gateway/`：

- `settings.json`：模型设置；API Key 使用 Electron `safeStorage` 和系统安全存储加密，界面只能写入新 Key 或清除，不能读取原 Key。
- `dialogue.sqlite`：完整会话、摘要、长期记忆、变更记录和后台任务。数据库本身不加密。

gateway 使用 Electron 独立进程，仅监听 `127.0.0.1` 的随机端口，全部请求需要启动时随机令牌，拒绝带浏览器 Origin 的请求。应用只允许一个实例持有数据库。

记忆存储在本机，但生成回复、摘要或提取记忆时，所选对话和资料会发送给你配置的 API 供应商。关闭自动记忆只停止提取，不删除已有记忆，也不关闭必要的短期上下文摘要。

## 开发、验证与打包

```bash
npm test                  # 本机模拟 API、SQLite、上下文和记忆测试
npm run test:electron     # 隔离用户数据的真实 Electron 界面集成测试
npm run pack:mac          # 生成 dist/mac-arm64/白子桌宠.app
npm run dist:mac          # 生成应用和 DMG
```

测试不消耗真实 API 额度。打包使用源码白名单，排除凭据脚本、日志、数据库、虚拟环境及其他开发文件；应用目前未进行开发者签名或公证。

主要结构：

```text
main.js / preload.js / renderer.js  桌宠窗口、交互与受控 IPC
 gateway-manager.js                gateway 生命周期和加密设置
 speech-service.js                 macOS 播报队列
 gateway/
   server.js                       本机 HTTP 接口与认证
   provider.js                     兼容模型接口和 SSE 解析
   chat-service.js                 对话串行执行、取消与状态保存
   tools/tool-registry.js          时间、天气、搜索、命令和动作工具注册
   actions/action-registry.js      模型可用的动作协议和参数校验
   skills/pet-actions/SKILL.md     网关加载的动作选择 skill
   context-manager.js              预算、摘要和相关记忆召回
   memory-service.js               后台提取与有限重试
   storage.js                      SQLite 事务和原子落盘
 prompts/baizi.md                 角色设定
 ui/                               输入框、回复气泡、对话设置与各自脚本
 scripts/                          Node 环境准备和启动辅助脚本
 tests/                            模拟服务及 Electron 集成验证
 archive/legacy-tts/              不参与运行的旧版 Python/Qwen TTS 示例
 archive/legacy-launch/           不参与运行的旧版 Windows 启动脚本
 archive/legacy-assets/           不再使用的旧图标
 docs/VOICE_ARCHITECTURE.md       实时语音接入边界和实施顺序
 docs/PERSONA_SOURCES.md          角色资料来源和原创桌宠设定
```

3D 模型放在 `assets/model.vrm`，缺失时回退到 `assets/pet.png`。页面实际引用的 `vendor/three/` 随源码和应用一起保留。

## 验收建议

本轮 UI、工具和动作的源码版验收步骤见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。退出旧应用后使用 `npm start` 或 `start.command`；`dist/` 中已有的 `.app` 未重新构建。

1. 配置自己的模型，测试连接后与白子聊天。
2. 告诉白子你的称呼和偏好，等待长期记忆页面出现记录，检查来源。
3. 开启新会话，询问称呼或相关偏好；退出重启后再确认。
4. 手动纠正或删除一条记忆，新会话确认使用更新后的资料。
5. 连续发送消息、点击停止，确认旧回复和声音不会覆盖新回复。
6. 增加对话长度，确认上下文摘要与历史原文；关闭语音或模拟 API 失败，确认文字和已有记录保留。
7. 导出 JSON，确认会话与记忆齐全且不包含凭据。
