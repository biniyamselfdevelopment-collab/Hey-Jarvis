"""Kokoro text-to-speech (local, CPU) and interruptible playback."""

from __future__ import annotations

import queue
import threading
from pathlib import Path

import numpy as np

DEFAULT_VOICE = "af_heart"  # American English; see voices-v1.0.bin for others (am_michael, af_bella, …)


class Synthesizer:
    def __init__(self, models: Path, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> None:
        from kokoro_onnx import Kokoro  # heavy import; keep it lazy

        self._kokoro = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
        self.voice = voice
        self.speed = speed

    def synth(self, text: str) -> tuple[np.ndarray, int]:
        samples, sample_rate = self._kokoro.create(text, voice=self.voice, speed=self.speed, lang="en-us")
        return np.asarray(samples, dtype=np.float32), int(sample_rate)


class Player:
    """Plays clips back to back on the default output device; `stop()` cuts off instantly."""

    def __init__(self) -> None:
        self._stop = threading.Event()

    def play(self, samples: np.ndarray, sample_rate: int) -> bool:
        """Blocking playback. Returns False if interrupted."""
        import sounddevice as sd

        self._stop.clear()
        blocks: queue.SimpleQueue[np.ndarray] = queue.SimpleQueue()
        block = sample_rate // 20
        for i in range(0, len(samples), block):
            blocks.put(samples[i : i + block])
        finished = threading.Event()

        def callback(outdata, frames, _time, _status):  # noqa: ANN001
            outdata.fill(0)
            if self._stop.is_set():
                raise sd.CallbackStop
            filled = 0
            while filled < frames:
                try:
                    chunk = blocks.get_nowait()
                except queue.Empty:
                    raise sd.CallbackStop from None
                take = min(frames - filled, len(chunk))
                outdata[filled : filled + take, 0] = chunk[:take]
                if take < len(chunk):
                    # Put the remainder back at the front by rebuilding the queue head.
                    rest = chunk[take:]
                    remaining = [rest]
                    while not blocks.empty():
                        remaining.append(blocks.get_nowait())
                    for r in remaining:
                        blocks.put(r)
                filled += take

        with sd.OutputStream(
            samplerate=sample_rate, channels=1, dtype="float32", callback=callback, finished_callback=finished.set
        ):
            finished.wait()
        return not self._stop.is_set()

    def stop(self) -> None:
        self._stop.set()
