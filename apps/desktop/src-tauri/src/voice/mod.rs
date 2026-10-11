//! Voice engine — wake word → VAD → Whisper → (core) → Kokoro.
//!
//! Interfaces only for now; implementations land in M1 (see docs/SPEC.md §4):
//! - `WakeWord`:  openWakeWord's pretrained `hey_jarvis` model on ONNX Runtime (`ort`), CPU.
//! - `SpeechToText`: whisper.cpp via `whisper-rs` (`cuda` feature), `small.en` ≈ 1 GB VRAM.
//! - `TextToSpeech`: Kokoro-82M ONNX, streamed sentence by sentence; Piper as fallback.
//!
//! Flow: mic frames (16 kHz mono f32, 80 ms) feed `WakeWord`. On trigger the engine
//! records until ~700 ms of VAD silence, transcribes, and sends an `utterance` to the
//! core. After Jarvis speaks, the mic stays open ~6 s without the wake word so the
//! user can answer follow-ups and confirmations ("yes, go ahead").
#![allow(dead_code)]

pub const SAMPLE_RATE: u32 = 16_000;
/// openWakeWord consumes 1280-sample (80 ms) chunks.
pub const FRAME_SAMPLES: usize = 1_280;
pub const FOLLOW_UP_WINDOW_MS: u64 = 6_000;

pub trait WakeWord: Send {
    /// Feed one frame; returns true when "Hey Jarvis" was heard.
    fn process(&mut self, frame: &[f32]) -> bool;
}

pub trait SpeechToText: Send {
    fn transcribe(&mut self, pcm: &[f32]) -> Result<String, String>;
}

pub trait TextToSpeech: Send {
    /// Speak `text`, blocking until playback ends or `stop` is called.
    fn speak(&mut self, text: &str) -> Result<(), String>;
    /// Barge-in: cut playback immediately.
    fn stop(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceState {
    /// Only the wake-word model is running.
    Dormant,
    /// Recording an utterance until VAD detects silence.
    Capturing,
    /// Utterance sent to the core; waiting for a reply.
    Waiting,
    /// TTS playing; the wake word still listens for barge-in.
    Speaking,
    /// Mic open without the wake word for a follow-up answer.
    FollowUp,
}

impl VoiceState {
    /// Whether the full pipeline (VAD + STT) should consume mic audio in this state.
    pub fn transcribing(self) -> bool {
        matches!(self, VoiceState::Capturing | VoiceState::FollowUp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcribes_only_while_capturing_or_following_up() {
        assert!(VoiceState::Capturing.transcribing());
        assert!(VoiceState::FollowUp.transcribing());
        assert!(!VoiceState::Dormant.transcribing());
        assert!(!VoiceState::Speaking.transcribing());
    }
}
