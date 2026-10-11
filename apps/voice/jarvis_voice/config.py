"""Voice settings, read from the "voice" section of ~/.hey-jarvis/config.json."""

from __future__ import annotations

import json
from dataclasses import dataclass

from .models import jarvis_home
from .tts import DEFAULT_VOICE


@dataclass
class VoiceConfig:
    voice: str = DEFAULT_VOICE
    speed: float = 1.0
    #: faster-whisper model name: tiny.en, base.en, small.en (~1 GB VRAM), medium.en, distil-large-v3…
    whisper_model: str = "small.en"
    device: str = "auto"  # auto | cuda | cpu
    wake_threshold: float = 0.5
    end_silence_ms: int = 800
    #: Mic stays open this long for an answer after Jarvis asks a question.
    reply_window_ms: int = 8000
    #: Optional open-mic window after every answer (0 = require "Hey Jarvis" again).
    follow_up_ms: int = 0
    input_device: int | str | None = None


_KEYS = {
    "voice": "voice",
    "speed": "speed",
    "whisperModel": "whisper_model",
    "device": "device",
    "wakeThreshold": "wake_threshold",
    "endSilenceMs": "end_silence_ms",
    "replyWindowMs": "reply_window_ms",
    "followUpMs": "follow_up_ms",
    "inputDevice": "input_device",
}


def load_config() -> VoiceConfig:
    cfg = VoiceConfig()
    try:
        raw = json.loads((jarvis_home() / "config.json").read_text(encoding="utf-8")).get("voice", {})
    except (FileNotFoundError, json.JSONDecodeError, AttributeError):
        return cfg
    for key, attr in _KEYS.items():
        if key in raw:
            setattr(cfg, attr, raw[key])
    return cfg
