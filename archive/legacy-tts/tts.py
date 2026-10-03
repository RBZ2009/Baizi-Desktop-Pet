def tts_aliyun(text_input,key):
    # 请安装 DashScope SDK 的最新版本
    import os
    import dashscope

    # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
    dashscope.base_http_api_url = 'https://dashscope.aliyuncs.com/api/v1'

    text = text_input
    # SpeechSynthesizer接口使用方法：dashscope.audio.qwen_tts.SpeechSynthesizer.call(...)
    response = dashscope.MultiModalConversation.call(
        # 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash
        model="qwen3-tts-flash",
        # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        # 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：api_key="sk-xxx"
        api_key=key,
        text=text,
        voice="Bella"
        # 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash
        # instructions='语速较快，带有明显的上扬语调，适合介绍时尚产品。',
        # optimize_instructions=True
    )
    return response["output"]["audio"]["url"]