"""Locating and downloading the on-device voice models (first run only)."""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path
from typing import Callable

OWW = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
KOKORO = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"

#: file name -> download URL. Whisper weights are fetched by faster-whisper itself.
MODEL_FILES = {
    "melspectrogram.onnx": OWW + "melspectrogram.onnx",
    "embedding_model.onnx": OWW + "embedding_model.onnx",
    "hey_jarvis_v0.1.onnx": OWW + "hey_jarvis_v0.1.onnx",
    "silero_vad.onnx": OWW + "silero_vad.onnx",
    "kokoro-v1.0.onnx": KOKORO + "kokoro-v1.0.onnx",
    "voices-v1.0.bin": KOKORO + "voices-v1.0.bin",
}


def jarvis_home() -> Path:
    return Path(os.environ.get("JARVIS_HOME", Path.home() / ".hey-jarvis"))


def models_dir() -> Path:
    return Path(os.environ.get("JARVIS_MODELS", jarvis_home() / "models"))


def ensure_models(on_progress: Callable[[str, float], None] = lambda name, frac: None) -> Path:
    """Download any missing model files. Returns the models directory."""
    root = models_dir()
    root.mkdir(parents=True, exist_ok=True)
    for name, url in MODEL_FILES.items():
        target = root / name
        if target.exists() and target.stat().st_size > 0:
            continue
        partial = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=60) as res, open(partial, "wb") as out:
            total = int(res.headers.get("content-length") or 0)
            done, last = 0, -1.0
            while chunk := res.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                frac = done / total if total else 0.0
                if frac - last >= 0.05:
                    on_progress(name, frac)
                    last = frac
        partial.replace(target)
    return root
