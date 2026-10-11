"""Microphone capture at 16 kHz mono, resampling if the device can't do 16 kHz natively."""

from __future__ import annotations

import queue
import threading
from typing import Callable

import numpy as np

RATE = 16000
CHUNK = 1280


class Resampler:
    """Streaming linear resampler (good enough for speech recognition)."""

    def __init__(self, src_rate: int, dst_rate: int = RATE) -> None:
        self.step = src_rate / dst_rate
        self._pos = 0.0
        self._tail = np.zeros(0, dtype=np.float32)

    def __call__(self, block: np.ndarray) -> np.ndarray:
        if self.step == 1.0:
            return block
        data = np.concatenate([self._tail, block])
        positions = np.arange(self._pos, len(data) - 1, self.step)
        out = np.interp(positions, np.arange(len(data)), data).astype(np.float32)
        next_pos = positions[-1] + self.step if len(positions) else self._pos
        keep_from = int(next_pos)
        self._tail = data[keep_from:]
        self._pos = next_pos - keep_from
        return out


class Microphone:
    """Delivers exact 1280-sample chunks to `on_chunk` from a worker thread."""

    def __init__(self, on_chunk: Callable[[np.ndarray], None], device: int | str | None = None) -> None:
        self._on_chunk = on_chunk
        self._device = device
        self._blocks: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=200)
        self._stream = None
        self._worker = threading.Thread(target=self._pump, name="mic-pump", daemon=True)

    def start(self) -> int:
        """Open the device. Returns the native sample rate in use."""
        import sounddevice as sd

        def callback(indata, _frames, _time, _status):  # noqa: ANN001
            try:
                self._blocks.put_nowait(indata[:, 0].copy())
            except queue.Full:
                pass  # drop audio rather than block the audio thread

        try:
            rate = RATE
            self._stream = sd.InputStream(
                samplerate=rate, channels=1, dtype="float32", blocksize=CHUNK, device=self._device, callback=callback
            )
        except Exception:  # noqa: BLE001 — device doesn't support 16 kHz; use its default and resample
            info = sd.query_devices(self._device, "input")
            rate = int(info["default_samplerate"])
            self._stream = sd.InputStream(
                samplerate=rate, channels=1, dtype="float32", device=self._device, callback=callback
            )
        self._resample = Resampler(rate)
        self._stream.start()
        self._worker.start()
        return rate

    def _pump(self) -> None:
        pending = np.zeros(0, dtype=np.float32)
        while (block := self._blocks.get()) is not None:
            pending = np.concatenate([pending, self._resample(block)])
            while len(pending) >= CHUNK:
                chunk, pending = pending[:CHUNK], pending[CHUNK:]
                self._on_chunk(chunk)

    def close(self) -> None:
        if self._stream is not None:
            self._stream.close()
        self._blocks.put(None)
