"""The listening state machine: wake word → capture until silence → hand off audio.

Pure logic over 80 ms audio chunks so it can be tested without a microphone.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Protocol

import numpy as np

CHUNK = 1280
CHUNK_MS = 80


class Scorer(Protocol):
    def process(self, audio: np.ndarray) -> float: ...
    def reset(self) -> None: ...


class State(Enum):
    DORMANT = "dormant"  # only the wake word runs
    CAPTURING = "capturing"  # recording a request after "Hey Jarvis" or a hotkey
    FOLLOW_UP = "follow_up"  # mic open without the wake word (e.g. answering "should I go ahead?")


@dataclass
class EngineConfig:
    wake_threshold: float = 0.5
    #: Higher bar while Jarvis is talking, so its own voice can't trigger it.
    barge_in_threshold: float = 0.8
    vad_threshold: float = 0.5
    end_silence_ms: int = 800
    #: How long to wait for speech to start after the wake word.
    start_timeout_ms: int = 5000
    max_utterance_ms: int = 20000
    #: Keep this much audio from before the trigger so the first word isn't clipped.
    pre_roll_ms: int = 240
    #: Ignore the wake word for this long after a capture ends.
    cooldown_ms: int = 1200


@dataclass
class Event:
    type: str  # "wake" | "barge_in" | "listening" | "utterance_audio" | "no_speech"
    audio: np.ndarray | None = None


class Engine:
    def __init__(self, wake: Scorer, vad: Scorer, emit: Callable[[Event], None], config: EngineConfig | None = None):
        self.wake = wake
        self.vad = vad
        self.emit = emit
        self.cfg = config or EngineConfig()
        self.state = State.DORMANT
        self.speaking = False
        #: False when no microphone could be opened: never claim to be listening.
        self.mic_ok = True
        self._lock = threading.Lock()
        self._history: list[np.ndarray] = []  # recent chunks for pre-roll
        self._buffer: list[np.ndarray] = []
        self._elapsed_ms = 0
        self._silence_ms = 0
        self._heard_speech = False
        self._timeout_ms = self.cfg.start_timeout_ms
        self._cooldown_ms = 0

    # ---- control (called from other threads) ----

    def listen(self, timeout_ms: int | None = None, follow_up: bool = False) -> None:
        """Start capturing without the wake word (hotkey, or a follow-up answer)."""
        with self._lock:
            if not self.mic_ok:
                self.emit(Event("no_speech"))
                return
            self._start_capture(State.FOLLOW_UP if follow_up else State.CAPTURING, timeout_ms)

    def set_speaking(self, speaking: bool) -> None:
        with self._lock:
            self.speaking = speaking

    def cancel(self) -> None:
        with self._lock:
            self.state = State.DORMANT
            self._buffer = []

    # ---- audio ----

    def feed(self, chunk: np.ndarray) -> None:
        with self._lock:
            self._feed(chunk)

    def _feed(self, chunk: np.ndarray) -> None:
        score = self.wake.process(chunk)  # always run so its rolling buffers stay continuous
        self._history = (self._history + [chunk])[-max(1, self.cfg.pre_roll_ms // CHUNK_MS) :]
        if self._cooldown_ms > 0:
            self._cooldown_ms -= CHUNK_MS

        if self.state is State.DORMANT:
            if self._cooldown_ms > 0:
                return
            if self.speaking and score >= self.cfg.barge_in_threshold:
                self.emit(Event("barge_in"))
                self._start_capture(State.CAPTURING, None)
            elif not self.speaking and score >= self.cfg.wake_threshold:
                self.emit(Event("wake"))
                self._start_capture(State.CAPTURING, None)
            return

        prob = self.vad.process(chunk)
        self._buffer.append(chunk)
        self._elapsed_ms += CHUNK_MS
        if prob >= self.cfg.vad_threshold:
            self._heard_speech = True
            self._silence_ms = 0
        else:
            self._silence_ms += CHUNK_MS

        if self._heard_speech and (
            self._silence_ms >= self.cfg.end_silence_ms or self._elapsed_ms >= self.cfg.max_utterance_ms
        ):
            self._finish(Event("utterance_audio", np.concatenate(self._buffer)))
        elif not self._heard_speech and self._elapsed_ms >= self._timeout_ms:
            self._finish(Event("no_speech"))

    def _start_capture(self, state: State, timeout_ms: int | None) -> None:
        self.state = state
        self.vad.reset()
        self._buffer = list(self._history)
        self._elapsed_ms = 0
        self._silence_ms = 0
        self._heard_speech = False
        self._timeout_ms = timeout_ms or self.cfg.start_timeout_ms
        self.emit(Event("listening"))

    def _finish(self, event: Event) -> None:
        self.state = State.DORMANT
        self._buffer = []
        self._cooldown_ms = self.cfg.cooldown_ms
        self.wake.reset()
        self.emit(event)
