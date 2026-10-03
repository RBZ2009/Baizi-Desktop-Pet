import os
import sys
import json
import asyncio
import logging
import wave
import base64
from tts_realtime_client import TTSRealtimeClient, SessionMode
import pyaudio

# QwenTTS 服务配置
# 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime，并在tts_realtime_client.py中取消instructions的注释
# 以下是北京地域url，如果使用新加坡地域的模型，需要将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
DEFAULT_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime"
# 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
# 若没有配置环境变量，请用百炼API Key将下行替换为：API_KEY="sk-xxx"
DEFAULT_API_KEY = os.getenv("DASHSCOPE_API_KEY")

# 收集音频数据
_audio_chunks = []
# 实时播放相关
_AUDIO_SAMPLE_RATE = 24000
_audio_pyaudio = pyaudio.PyAudio()
_audio_stream = None  # 将在运行时打开


def _audio_callback(audio_bytes: bytes):
    """TTSRealtimeClient 音频回调: 实时播放并缓存"""
    global _audio_stream
    if _audio_stream is not None:
        try:
            _audio_stream.write(audio_bytes)
        except Exception as exc:
            logging.error(f"PyAudio playback error: {exc}")
    _audio_chunks.append(audio_bytes)
    logging.info(f"Received audio chunk: {len(audio_bytes)} bytes")


def _audio_callback_stdout(audio_bytes: bytes):
    """将音频以 base64 JSON 行输出，便于上层进程读取"""
    if not audio_bytes:
        return
    payload = {
        "type": "audio",
        "sample_rate": _AUDIO_SAMPLE_RATE,
        "data": base64.b64encode(audio_bytes).decode("utf-8")
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _save_audio_to_file(filename: str = "output.wav", sample_rate: int = 24000) -> bool:
    """将收集到的音频数据保存为 WAV 文件"""
    if not _audio_chunks:
        logging.warning("No audio data to save")
        return False

    try:
        audio_data = b"".join(_audio_chunks)
        with wave.open(filename, 'wb') as wav_file:
            wav_file.setnchannels(1)  # 单声道
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_data)
        logging.info(f"Audio saved to: {filename}")
        return True
    except Exception as exc:
        logging.error(f"Failed to save audio: {exc}")
        return False


async def _produce_text(client: TTSRealtimeClient):
    """向服务器发送文本片段"""
    text_fragments = [
        "阿里云的大模型服务平台百炼是一站式的大模型开发及应用构建平台。",
        "不论是开发者还是业务人员，都能深入参与大模型应用的设计和构建。",
        "您可以通过简单的界面操作，在5分钟内开发出一款大模型应用，",
        "或在几小时内训练出一个专属模型，从而将更多精力专注于应用创新。",
    ]

    logging.info("Sending text fragments…")
    for text in text_fragments:
        logging.info(f"Sending fragment: {text}")
        await client.append_text(text)
        await asyncio.sleep(0.1)  # 片段间稍作延时

    # 等待服务器完成内部处理后结束会话
    await asyncio.sleep(1.0)
    await client.finish_session()


async def _read_stdin_lines():
    """异步读取 stdin 行"""
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        yield line.rstrip("\n")


async def _run_bridge():
    """从 stdin 接收文本片段并输出音频数据"""
    import builtins
    original_print = builtins.print
    def _print_to_stderr(*args, **kwargs):
        kwargs.setdefault("file", sys.stderr)
        return original_print(*args, **kwargs)
    builtins.print = _print_to_stderr

    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise ValueError("Please set DASHSCOPE_API_KEY environment variable")

    base_url = os.getenv("TTS_REALTIME_URL") or DEFAULT_URL
    voice = "Bella"
    play_local = os.getenv("TTS_PLAY_LOCAL") == "1"

    global _audio_stream
    if play_local:
        _audio_stream = _audio_pyaudio.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=_AUDIO_SAMPLE_RATE,
            output=True,
            frames_per_buffer=1024
        )
        audio_callback = _audio_callback
    else:
        audio_callback = _audio_callback_stdout

    client = TTSRealtimeClient(
        base_url=base_url,
        api_key=api_key,
        voice=voice,
        mode=SessionMode.COMMIT,
        audio_callback=audio_callback
    )

    await client.connect()

    consumer_task = asyncio.create_task(client.handle_messages())

    buffer_text = ""

    async for text in _read_stdin_lines():
        if not text:
            continue
        if text == "__END__":
            if buffer_text.strip():
                await client.append_text(buffer_text)
                await client.commit_text_buffer()
                await client.clear_text_buffer()
                buffer_text = ""
            await client.finish_session()
            break

        buffer_text += text
        should_commit = False
        if len(buffer_text) >= 12:
            should_commit = True
        if buffer_text and buffer_text[-1] in "。！？!?；;，,\n":
            should_commit = True

        if should_commit:
            await client.append_text(buffer_text)
            await client.commit_text_buffer()
            await client.clear_text_buffer()
            buffer_text = ""

    await client.wait_for_response_done()
    await client.close()
    consumer_task.cancel()

    if play_local and _audio_stream is not None:
        _audio_stream.stop_stream()
        _audio_stream.close()
        _audio_pyaudio.terminate()

    sys.stdout.write(json.dumps({"type": "done"}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _run_demo():
    """运行完整 Demo"""
    global _audio_stream
    # 打开 PyAudio 输出流
    _audio_stream = _audio_pyaudio.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=_AUDIO_SAMPLE_RATE,
        output=True,
        frames_per_buffer=1024
    )

    client = TTSRealtimeClient(
        base_url=DEFAULT_URL,
        api_key=DEFAULT_API_KEY,
        voice="Bella",
        mode=SessionMode.SERVER_COMMIT,
        audio_callback=_audio_callback
    )

    async def _inner():
        await client.connect()
        consumer_task = asyncio.create_task(client.handle_messages())
        producer_task = asyncio.create_task(_produce_text(client))

        await producer_task  # 等待文本发送完成
        await client.wait_for_response_done()

        await client.close()
        consumer_task.cancel()

        if _audio_stream is not None:
            _audio_stream.stop_stream()
            _audio_stream.close()
        _audio_pyaudio.terminate()

        os.makedirs("outputs", exist_ok=True)
        _save_audio_to_file(os.path.join("outputs", "qwen_tts_output.wav"))

    asyncio.run(_inner())


def _run_list(text_list):
    """同步入口：接收列表并按两句提交"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    async def _inner():
        api_key = os.getenv("DASHSCOPE_API_KEY") or DEFAULT_API_KEY
        if not api_key:
            raise ValueError("Please set DASHSCOPE_API_KEY environment variable")

        base_url = os.getenv("TTS_REALTIME_URL") or DEFAULT_URL
        voice = "Bella"
        play_local = os.getenv("TTS_PLAY_LOCAL") == "1"

        global _audio_stream
        if play_local:
            _audio_stream = _audio_pyaudio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=_AUDIO_SAMPLE_RATE,
                output=True,
                frames_per_buffer=1024
            )
            audio_callback = _audio_callback
        else:
            audio_callback = _audio_callback_stdout

        client = TTSRealtimeClient(
            base_url=base_url,
            api_key=api_key,
            voice=voice,
            mode=SessionMode.COMMIT,
            audio_callback=audio_callback
        )

        await client.connect()
        consumer_task = asyncio.create_task(client.handle_messages())

        # 两句一组提交
        buf = []
        for item in text_list or []:
            if not item:
                continue
            buf.append(str(item))
            if len(buf) >= 2:
                payload = " ".join(buf)
                await client.append_text(payload)
                await client.commit_text_buffer()
                await client.clear_text_buffer()
                buf = []

        if buf:
            payload = " ".join(buf)
            await client.append_text(payload)
            await client.commit_text_buffer()
            await client.clear_text_buffer()

        await client.wait_for_response_done()
        await client.close()
        consumer_task.cancel()

        if play_local and _audio_stream is not None:
            _audio_stream.stop_stream()
            _audio_stream.close()
            _audio_pyaudio.terminate()

    asyncio.run(_inner())


def main(text_list=None):
    """同步入口"""
    if text_list is not None:
        _run_list(text_list)
        return

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    if "--stdin" in sys.argv:
        asyncio.run(_run_bridge())
        return

    if len(sys.argv) > 1 and sys.argv[1].startswith("["):
        try:
            payload = json.loads(sys.argv[1])
        except Exception:
            payload = []
        _run_list(payload if isinstance(payload, list) else [])
        return

    logging.info("Starting QwenTTS Realtime Client demo…")
    if not DEFAULT_API_KEY:
        raise ValueError("Please set DASHSCOPE_API_KEY environment variable")
    _run_demo()


if __name__ == "__main__":
    main()
