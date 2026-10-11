"""Voice sidecar entry point.

Speaks JSON lines with the Tauri host:

  host → voice  {"type":"speak","text":"…","expectReply":false} | {"type":"stop"} | {"type":"listen"}
  voice → host  {"type":"status","stage":"downloading|loading|ready|error","message":"…"}
                {"type":"wake"} | {"type":"barge_in"} | {"type":"listening"} | {"type":"no_speech"}
                {"type":"transcribing"} | {"type":"utterance","text":"…"} | {"type":"speaking","active":bool}

Run `python -m jarvis_voice --download` once to fetch every model up front.
"""

from __future__ import annotations

import json
import queue
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from .config import VoiceConfig, load_config
from .engine import Engine, EngineConfig, Event
from .models import ensure_models

_out_lock = threading.Lock()


def emit(msg: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def log(text: str) -> None:
    print(f"[voice] {text}", file=sys.stderr, flush=True)


def status(stage: str, message: str = "", **extra: object) -> None:
    emit({"type": "status", "stage": stage, "message": message, **extra})


class SpeechQueue:
    """Synthesises the next sentence while the current one plays; interruptible."""

    def __init__(self, synth, player, engine: Engine, cfg: VoiceConfig) -> None:  # noqa: ANN001
        self._synth = synth
        self._player = player
        self._engine = engine
        self._cfg = cfg
        self._queue: queue.Queue[tuple[str, bool]] = queue.Queue()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")
        self._interrupted = threading.Event()
        threading.Thread(target=self._run, name="speech", daemon=True).start()

    def say(self, text: str, expect_reply: bool) -> None:
        if text.strip():
            self._queue.put((text.strip(), expect_reply))

    def interrupt(self) -> None:
        self._interrupted.set()
        self._player.stop()
        self._drain()

    def _drain(self) -> None:
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

    def _run(self) -> None:
        while True:
            text, expect_reply = self._queue.get()
            self._interrupted.clear()
            self._engine.set_speaking(True)
            emit({"type": "speaking", "active": True})
            future = self._pool.submit(self._synth.synth, text)
            while True:
                try:
                    samples, rate = future.result()
                except Exception as err:  # noqa: BLE001
                    log(f"TTS failed: {err}")
                    break
                upcoming = self._next(timeout=0)
                if upcoming:
                    future = self._pool.submit(self._synth.synth, upcoming[0])
                    expect_reply = expect_reply or upcoming[1]
                if not self._player.play(samples, rate) or self._interrupted.is_set():
                    self._drain()
                    break
                if upcoming is None:
                    # Give streamed sentences a moment to arrive before we call it done.
                    upcoming = self._next(timeout=0.25)
                    if upcoming is None:
                        break
                    future = self._pool.submit(self._synth.synth, upcoming[0])
                    expect_reply = expect_reply or upcoming[1]
            self._engine.set_speaking(False)
            emit({"type": "speaking", "active": False})
            if self._interrupted.is_set():
                continue
            if expect_reply:
                self._engine.listen(timeout_ms=self._cfg.reply_window_ms, follow_up=True)
            elif self._cfg.follow_up_ms > 0:
                self._engine.listen(timeout_ms=self._cfg.follow_up_ms, follow_up=True)

    def _next(self, timeout: float) -> tuple[str, bool] | None:
        try:
            return self._queue.get(timeout=timeout) if timeout else self._queue.get_nowait()
        except queue.Empty:
            return None


def main() -> int:
    cfg = load_config()

    def on_download(name: str, frac: float) -> None:
        status("downloading", f"Downloading voice models ({name})…", progress=round(frac, 2))

    try:
        models = ensure_models(on_download)
    except Exception as err:  # noqa: BLE001
        status("error", f"Couldn't download voice models: {err}")
        return 1

    from .stt import Transcriber
    from .tts import Player, Synthesizer
    from .vad import SileroVAD
    from .wake import WakeWord

    if "--download" in sys.argv:
        Transcriber(cfg.whisper_model, cfg.device, on_status=lambda m: status("loading", m))
        status("ready", "All models downloaded.")
        return 0

    status("loading", "Warming up my voice…")
    synth = Synthesizer(models, cfg.voice, cfg.speed)
    player = Player()
    transcriber: list[Transcriber] = []
    jobs: queue.Queue = queue.Queue()

    def on_event(event: Event) -> None:
        # Runs on the audio thread with the engine lock held: never call back into the engine here.
        if event.type == "barge_in":
            speech.interrupt()
        if event.type == "utterance_audio":
            emit({"type": "transcribing"})
            jobs.put(event.audio)
        else:
            emit({"type": event.type})

    engine = Engine(
        WakeWord(models),
        SileroVAD(models),
        on_event,
        EngineConfig(wake_threshold=cfg.wake_threshold, end_silence_ms=cfg.end_silence_ms),
    )
    speech = SpeechQueue(synth, player, engine, cfg)

    def transcribe_worker() -> None:
        try:
            transcriber.append(Transcriber(cfg.whisper_model, cfg.device, on_status=lambda m: status("loading", m)))
            status("ready", f"Ready — say \"Hey Jarvis\". (Whisper on {transcriber[0].device.upper()})")
        except Exception as err:  # noqa: BLE001
            status("error", f"Speech recognition failed to load: {err}")
            return
        while True:
            audio = jobs.get()
            try:
                text = transcriber[0].transcribe(audio)
            except Exception as err:  # noqa: BLE001
                log(f"transcription failed: {err}")
                text = ""
            emit({"type": "utterance", "text": text} if text else {"type": "no_speech"})

    threading.Thread(target=transcribe_worker, name="stt", daemon=True).start()

    from .audio import Microphone

    mic = Microphone(engine.feed, cfg.input_device)
    try:
        rate = mic.start()
        log(f"microphone open at {rate} Hz")
    except Exception as err:  # noqa: BLE001
        status("error", f"Couldn't open the microphone: {err}")

    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = msg.get("type")
        if kind == "speak":
            speech.say(str(msg.get("text", "")), bool(msg.get("expectReply")))
        elif kind == "stop":
            speech.interrupt()
            engine.cancel()
        elif kind == "listen":
            speech.interrupt()
            engine.listen()
    mic.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
