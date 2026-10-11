import numpy as np
import pytest

from jarvis_voice.audio import Resampler
from jarvis_voice.stt import clean_transcript


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Jarvis, what's the weather?", "what's the weather?"),
        ("Hey Jarvis open Spotify", "open Spotify"),
        ("  yes, go ahead  ", "yes, go ahead"),
        ("Thank you.", ""),
        ("you", ""),
        ("Jarvis.", ""),
        ("Tell Jarvis's story", "Tell Jarvis's story"),
    ],
)
def test_clean_transcript(raw, expected):
    assert clean_transcript(raw) == expected


@pytest.mark.parametrize("src", [16000, 44100, 48000])
def test_resampler_preserves_duration_across_blocks(src):
    resample = Resampler(src)
    total = sum(len(resample(np.zeros(src // 10, dtype=np.float32))) for _ in range(30))  # 3 s
    assert abs(total - 48000) <= 2
