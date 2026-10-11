"""Real-model tests: Kokoro speaks, the wake word and VAD listen."""

import numpy as np

from jarvis_voice.engine import CHUNK, Engine, EngineConfig
from jarvis_voice.vad import SileroVAD
from jarvis_voice.wake import WakeWord

SILENCE = np.zeros(16000, dtype=np.float32)


def chunks(audio):
    return [audio[i : i + CHUNK] for i in range(0, len(audio) - CHUNK + 1, CHUNK)]


def max_wake(models, audio):
    wake = WakeWord(models)
    return max(wake.process(c) for c in chunks(audio))


def test_wake_word_fires_on_hey_jarvis(models, say):
    for voice in ("af_heart", "am_michael"):
        assert max_wake(models, np.concatenate([SILENCE, say("Hey Jarvis.", voice), SILENCE])) > 0.5


def test_wake_word_ignores_other_speech(models, say):
    for text in ("Hello there, how are you doing today?", "Turn left at the next junction, then park."):
        assert max_wake(models, np.concatenate([SILENCE, say(text), SILENCE])) < 0.5


def test_full_pipeline_captures_the_request_after_the_wake_word(models, say):
    events = []
    engine = Engine(WakeWord(models), SileroVAD(models), events.append, EngineConfig())
    request = say("What's the weather like in Addis Ababa today?")
    audio = np.concatenate([SILENCE, say("Hey Jarvis."), np.zeros(4000, np.float32), request, SILENCE, SILENCE])
    for c in chunks(audio):
        engine.feed(c)
    kinds = [e.type for e in events]
    assert kinds[:2] == ["wake", "listening"]
    assert kinds[-1] == "utterance_audio"
    captured = events[-1].audio
    # Should hold roughly the request (plus trailing silence), not the whole stream.
    assert len(request) * 0.9 < len(captured) < len(request) + 2.5 * 16000
