"""Whisper speech-to-text via faster-whisper: CUDA when available, CPU otherwise."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Callable

import numpy as np

# Whisper's classic hallucinations on near-silent audio.
_HALLUCINATIONS = {"", "you", "thank you", "thanks for watching", "thank you for watching", "bye", "uh", "um"}
_WAKE_PREFIX = re.compile(r"^\s*(hey|hi|okay|ok)?[\s,.]*jarvis\b[\s,.!?]*", re.IGNORECASE)


def clean_transcript(text: str) -> str:
    """Strip the wake phrase if it leaked into the capture and drop known hallucinations."""
    text = _WAKE_PREFIX.sub("", text.strip()).strip()
    if re.sub(r"[^a-z ]", "", text.lower()).strip() in _HALLUCINATIONS:
        return ""
    return text


def _add_cuda_dll_dirs() -> None:
    """On Windows, make pip-installed CUDA libraries (the `cuda` extra) visible to CTranslate2."""
    if sys.platform != "win32":
        return
    try:
        import nvidia  # type: ignore[import-not-found]
    except ImportError:
        return
    for base in getattr(nvidia, "__path__", []):
        for lib in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            bin_dir = Path(base) / lib / "bin"
            if bin_dir.is_dir():
                os.add_dll_directory(str(bin_dir))
                os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"


class Transcriber:
    def __init__(
        self,
        model: str = "small.en",
        device: str = "auto",
        on_status: Callable[[str], None] = lambda _msg: None,
    ) -> None:
        from faster_whisper import WhisperModel

        _add_cuda_dll_dirs()
        attempts = [("cuda", "float16"), ("cpu", "int8")] if device in ("auto", "cuda") else [("cpu", "int8")]
        last_error: Exception | None = None
        for dev, compute in attempts:
            try:
                on_status(f"Loading Whisper {model} on {dev.upper()}…")
                self._model = WhisperModel(model, device=dev, compute_type=compute)
                # CUDA/cuDNN problems often only surface on the first decode, so warm up now.
                self._decode(np.zeros(16000, dtype=np.float32))
                self.device = dev
                return
            except Exception as err:  # noqa: BLE001 — fall back to the next device
                last_error = err
                if device == "cuda":
                    break
        raise RuntimeError(f"could not load Whisper: {last_error}")

    def _decode(self, audio: np.ndarray) -> str:
        segments, _info = self._model.transcribe(
            audio,
            language="en",
            beam_size=1,
            condition_on_previous_text=False,
            without_timestamps=True,
            vad_filter=False,
        )
        return " ".join(s.text.strip() for s in segments)

    def transcribe(self, audio: np.ndarray) -> str:
        return clean_transcript(self._decode(audio.astype(np.float32)))
