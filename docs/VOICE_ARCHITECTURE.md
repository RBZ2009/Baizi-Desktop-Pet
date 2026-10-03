# Voice architecture

## Current state

文字对话仍然由本地 gateway 管理上下文、长期记忆和工具调用。语音输出由 `speech-service.js` 调用 macOS `say`，它不需要网络权限，也不会改变已经保存的聊天内容。语音失败只影响播报，不影响文字回复。

仓库中的 `archive/legacy-tts/` 是旧版 Qwen 文本转语音示例。它可以作为供应商协议参考，但当前 Electron 应用不会启动 Python、PyAudio 或旧的 WebSocket 客户端。

## Recommended realtime path

OpenAI 官方 Realtime 文档把 speech-to-speech 作为低首包延迟、自然轮替和可打断语音代理的路径。推荐的桌面应用结构如下：

1. 主进程使用安全存储中的长期 API Key，向供应商服务端创建一次性的 client secret；长期 Key 永远不进入 renderer 或浏览器 WebRTC SDP。
2. 独立的语音面板通过 WebRTC 发送麦克风音频并接收模型音频。Data channel 用于会话事件、文字转写、工具调用和中断状态。
3. gateway 继续拥有白子人设、工具注册、动作协议和记忆策略。Realtime 的函数调用事件转交 gateway 执行，工具结果再写回语音会话。
4. 用户打断时立即停止播放并取消当前 response；VAD/turn detection 负责判断发言边界，文本气泡和音频转写共用同一会话事件。
5. 用户关闭实时语音或供应商不可用时，退回现有“文字流式回复 + macOS say”，不丢失本地会话和长期记忆。

## Why this is separate from Chat Completions

兼容 `/chat/completions` 的接口只保证文本消息和可选的普通工具调用，不能假设它支持双向音频、VAD、barge-in 或 Realtime 事件。Realtime 模型、临时凭据、WebRTC/WebSocket 传输和事件名称需要单独的 provider adapter；不能仅把 API Base URL 改成 `/realtime`。

## Security and privacy boundaries

- renderer 只拿短期 client secret，不保存或回传长期 API Key。
- 麦克风默认关闭，首次启用时明确显示系统权限和网络传输提示。
- 音频默认不落盘；如果用户主动开启录音，保存路径和保留时间必须可见。
- Realtime 工具调用沿用 `gateway/tools/tool-registry.js` 的参数校验和 `gateway/actions/action-registry.js` 的动作白名单。
- 工具结果、转写文本和模型事件均按外部资料处理，不能改变系统提示或绕过命令权限。

## Implementation sequence

1. 增加独立的 `gateway/voice/` provider contract 和会话状态机，先用本地 fake event 测试中断、重连、工具调用和回退。
2. 在主进程增加一次性 client secret 代理；对话设置中增加“系统语音 / 实时语音”开关，默认仍为系统语音。
3. 在独立语音面板接入 WebRTC、输入电平和 VAD 状态；保持当前聊天输入框可用。
4. 接入一个明确支持 Realtime 的供应商并做费用、延迟、断网和权限验收；未配置时隐藏实时入口或显示不可用原因。

参考： [OpenAI Realtime API 官方指南](https://developers.openai.com/api/docs/guides/realtime/)。该指南说明了 speech-to-speech、WebRTC/WebSocket、工具调用、打断和临时 client secret 的组合方式。
