"""Silero VAD (v4 ONNX, as shipped with openWakeWord) for end-of-speech detection."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort

FRAME = 512  # 32 ms at 16 kHz


class SileroVAD:
    def __init__(self, models: Path) -> None:
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self._session = ort.InferenceSession(str(models / "silero_vad.onnx"), opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(16000, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._h = np.zeros((2, 1, 64), dtype=np.float32)
        self._c = np.zeros((2, 1, 64), dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)

    def process(self, audio: np.ndarray) -> float:
        """Feed float32 audio at 16 kHz. Returns the highest speech probability seen."""
        self._pending = np.concatenate([self._pending, audio.astype(np.float32)])
        best = 0.0
        while len(self._pending) >= FRAME:
            frame, self._pending = self._pending[:FRAME], self._pending[FRAME:]
            out, self._h, self._c = self._session.run(
                None, {"input": frame[None, :], "sr": self._sr, "h": self._h, "c": self._c}
            )
            best = max(best, float(out.reshape(-1)[0]))
        return best
