"""State machine tests with scripted wake/VAD scores — no models needed."""

import numpy as np

from jarvis_voice.engine import CHUNK, Engine, EngineConfig, State


class Scripted:
    def __init__(self):
        self.next = 0.0
        self.resets = 0

    def process(self, _audio):
        return self.next

    def reset(self):
        self.resets += 1


def make(**cfg):
    wake, vad, events = Scripted(), Scripted(), []
    engine = Engine(wake, vad, events.append, EngineConfig(**cfg))
    return engine, wake, vad, events


def feed(engine, n=1):
    for _ in range(n):
        engine.feed(np.zeros(CHUNK, dtype=np.float32))


def types(events):
    return [e.type for e in events]


def test_wake_then_speech_then_silence_yields_utterance():
    engine, wake, vad, events = make(end_silence_ms=400)
    wake.next = 0.9
    feed(engine)
    assert types(events) == ["wake", "listening"]
    wake.next, vad.next = 0.0, 0.9
    feed(engine, 10)  # 800 ms of speech
    vad.next = 0.1
    feed(engine, 5)  # 400 ms of silence
    assert types(events)[-1] == "utterance_audio"
    assert len(events[-1].audio) >= 15 * CHUNK
    assert engine.state is State.DORMANT


def test_no_speech_after_wake_times_out():
    engine, wake, vad, events = make(start_timeout_ms=800)
    wake.next = 0.9
    feed(engine)
    wake.next = 0.0
    feed(engine, 10)
    assert types(events) == ["wake", "listening", "no_speech"]


def test_cooldown_prevents_immediate_retrigger():
    engine, wake, vad, events = make(start_timeout_ms=160, cooldown_ms=800)
    wake.next = 0.9
    feed(engine, 3)  # wake + 2-chunk timeout → no_speech
    assert types(events) == ["wake", "listening", "no_speech"]
    feed(engine, 5)  # still above threshold, but cooling down
    assert types(events).count("wake") == 1
    feed(engine, 10)
    assert types(events).count("wake") == 2


def test_while_speaking_only_a_strong_wake_barges_in():
    engine, wake, vad, events = make(barge_in_threshold=0.8)
    engine.set_speaking(True)
    wake.next = 0.6  # would wake normally, but Jarvis is talking
    feed(engine)
    assert events == []
    wake.next = 0.95
    feed(engine)
    assert types(events) == ["barge_in", "listening"]


def test_follow_up_listen_needs_no_wake_word():
    engine, wake, vad, events = make(end_silence_ms=160)
    engine.listen(timeout_ms=4000, follow_up=True)
    assert engine.state is State.FOLLOW_UP
    vad.next = 0.9
    feed(engine, 4)
    vad.next = 0.0
    feed(engine, 2)
    assert types(events) == ["listening", "utterance_audio"]


def test_capture_includes_pre_roll():
    engine, wake, vad, events = make(pre_roll_ms=240, end_silence_ms=80)
    feed(engine, 5)
    wake.next = 0.9
    feed(engine)
    wake.next, vad.next = 0.0, 0.9
    feed(engine)
    vad.next = 0.0
    feed(engine)
    audio = events[-1].audio
    # 3 pre-roll chunks (incl. the trigger chunk) + 2 captured chunks
    assert len(audio) == 5 * CHUNK


def test_listen_without_a_microphone_reports_no_speech():
    engine, wake, vad, events = make()
    engine.mic_ok = False
    engine.listen(follow_up=True)
    assert types(events) == ["no_speech"]
    assert engine.state is State.DORMANT
