"""Streaming "Hey Jarvis" detection.

A dependency-free re-implementation of openWakeWord's inference pipeline
(melspectrogram -> speech embedding -> wake word head) on onnxruntime, so we
avoid openwakeword's Linux-only tflite and scikit-learn dependencies.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort

CHUNK = 1280  # 80 ms at 16 kHz — one embedding step
_MEL_CONTEXT = 160 * 3  # extra samples openWakeWord prepends to each chunk
_MEL_WINDOW = 76  # mel frames per embedding
_FEATURES = 16  # embeddings per wake word prediction


def _session(path: Path) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


class WakeWord:
    def __init__(self, models: Path, model_name: str = "hey_jarvis_v0.1.onnx") -> None:
        self._mel = _session(models / "melspectrogram.onnx")
        self._emb = _session(models / "embedding_model.onnx")
        self._head = _session(models / model_name)
        self._head_input = self._head.get_inputs()[0].name
        self.reset()

    def reset(self) -> None:
        self._raw = np.zeros(0, dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)
        self._mels = np.ones((_MEL_WINDOW, 32), dtype=np.float32)
        self._features = np.zeros((_FEATURES, 96), dtype=np.float32)
        # Prime the buffers with low noise like openWakeWord does, so the first
        # real predictions aren't computed on an artificial all-zero history.
        rng = np.random.default_rng(0)
        for _ in range(_FEATURES + 4):
            self._step(rng.integers(-1000, 1000, CHUNK).astype(np.float32))

    def process(self, audio: np.ndarray) -> float:
        """Feed float32 audio in [-1, 1] at 16 kHz. Returns the highest score seen."""
        self._pending = np.concatenate([self._pending, audio.astype(np.float32) * 32767.0])
        best = 0.0
        while len(self._pending) >= CHUNK:
            chunk, self._pending = self._pending[:CHUNK], self._pending[CHUNK:]
            best = max(best, self._step(chunk))
        return best

    def _step(self, chunk: np.ndarray) -> float:
        self._raw = np.concatenate([self._raw, chunk])[-(CHUNK + _MEL_CONTEXT) :]
        mel = self._mel.run(None, {"input": self._raw[None, :]})[0]
        mel = np.squeeze(mel, axis=(1,)).reshape(-1, 32) / 10.0 + 2.0
        self._mels = np.vstack([self._mels, mel])[-(_MEL_WINDOW + 16) :]
        window = self._mels[-_MEL_WINDOW:][None, :, :, None].astype(np.float32)
        embedding = self._emb.run(None, {"input_1": window})[0].reshape(96)
        self._features = np.vstack([self._features, embedding])[-_FEATURES:]
        score = self._head.run(None, {self._head_input: self._features[None].astype(np.float32)})[0]
        return float(score.reshape(-1)[0])
