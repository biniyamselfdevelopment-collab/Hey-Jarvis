import os
from pathlib import Path

import numpy as np
import pytest

MODELS = Path(os.environ.get("JARVIS_MODELS", Path.home() / ".hey-jarvis" / "models"))


def to_16k(audio: np.ndarray, rate: int) -> np.ndarray:
    n = int(len(audio) * 16000 / rate)
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


@pytest.fixture(scope="session")
def models() -> Path:
    if not (MODELS / "hey_jarvis_v0.1.onnx").exists() or not (MODELS / "kokoro-v1.0.onnx").exists():
        pytest.skip("voice models not downloaded (run: uv run python -m jarvis_voice --download)")
    return MODELS


@pytest.fixture(scope="session")
def say(models):
    """Synthesise speech with Kokoro and return it as 16 kHz audio."""
    from jarvis_voice.tts import Synthesizer

    synth = Synthesizer(models)

    def _say(text: str, voice: str = "af_heart") -> np.ndarray:
        synth.voice = voice
        audio, rate = synth.synth(text)
        return to_16k(audio, rate)

    return _say
