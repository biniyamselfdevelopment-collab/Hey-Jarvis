//! Message routing between the agent core, the voice sidecar and the pill UI.
//!
//! Pure logic (no I/O) so it can be unit-tested: every input returns the list of
//! messages to deliver. The pill's displayed state is a merge of what the core
//! is doing (thinking, working, asking) and what the voice is doing (listening,
//! speaking), since the two run independently.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Ui(Value),
    Core(Value),
    Voice(Value),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ear {
    Idle,
    Listening,
    Transcribing,
}

#[derive(Debug)]
pub struct Router {
    core_state: String,
    ear: Ear,
    speaking: bool,
    shown: String,
    next_id: u64,
}

impl Default for Router {
    fn default() -> Self {
        Self { core_state: "idle".into(), ear: Ear::Idle, speaking: false, shown: "idle".into(), next_id: 0 }
    }
}

impl Router {
    /// What the pill should show. An open question wins (its card must stay
    /// clickable while the mic listens for "yes"), then the user talking, then
    /// Jarvis talking, then whatever the core is doing.
    pub fn display(&self) -> &str {
        match (self.ear, self.core_state.as_str(), self.speaking) {
            (_, "confirm", _) => "confirm",
            (Ear::Listening, _, _) => "listening",
            (_, _, true) => "speaking",
            (Ear::Transcribing, _, _) => "thinking",
            (_, core, _) => core,
        }
    }

    fn state_change(&mut self) -> Option<Out> {
        let now = self.display().to_string();
        if now == self.shown {
            return None;
        }
        self.shown = now.clone();
        Some(Out::Ui(json!({ "type": "state", "state": now })))
    }

    pub fn on_core(&mut self, msg: Value) -> Vec<Out> {
        let mut out = Vec::new();
        match msg["type"].as_str().unwrap_or_default() {
            "state" => {
                self.core_state = msg["state"].as_str().unwrap_or("idle").to_string();
            }
            "speak" => {
                out.push(Out::Voice(json!({
                    "type": "speak",
                    "text": msg["text"],
                    "expectReply": msg["expectReply"].as_bool().unwrap_or(false),
                })));
                out.push(Out::Ui(msg));
            }
            "host_tool_call" => out.push(Out::Core(run_host_tool(&msg))),
            _ => out.push(Out::Ui(msg)),
        }
        out.extend(self.state_change());
        out
    }

    pub fn on_voice(&mut self, msg: Value) -> Vec<Out> {
        let mut out = Vec::new();
        match msg["type"].as_str().unwrap_or_default() {
            "wake" | "barge_in" | "listening" => self.ear = Ear::Listening,
            "transcribing" => self.ear = Ear::Transcribing,
            "no_speech" => self.ear = Ear::Idle,
            "utterance" => {
                self.ear = Ear::Idle;
                self.next_id += 1;
                let text = msg["text"].clone();
                out.push(Out::Ui(json!({ "type": "heard", "text": text })));
                out.push(Out::Core(json!({
                    "type": "utterance",
                    "id": format!("voice-{}", self.next_id),
                    "text": text,
                    "source": "voice",
                })));
            }
            "speaking" => self.speaking = msg["active"].as_bool().unwrap_or(false),
            "status" => out.push(Out::Ui(json!({
                "type": "voice_status",
                "stage": msg["stage"],
                "message": msg["message"],
            }))),
            _ => {}
        }
        out.extend(self.state_change());
        out
    }

    /// A message from the pill (typed request, confirm click, cancel).
    pub fn on_ui(&mut self, msg: Value) -> Vec<Out> {
        let mut out = Vec::new();
        // Cancelling, or typing a new request, interrupts whatever Jarvis is saying.
        if msg["type"] == "cancel" || msg["type"] == "utterance" {
            self.ear = Ear::Idle;
            out.push(Out::Voice(json!({ "type": "stop" })));
        }
        out.push(Out::Core(msg));
        out.extend(self.state_change());
        out
    }

    /// Hotkey or mic click: start listening without the wake word.
    pub fn listen(&mut self) -> Vec<Out> {
        vec![Out::Voice(json!({ "type": "listen" }))]
    }

    /// The voice sidecar died: don't leave the pill stuck in "listening"/"speaking".
    pub fn voice_gone(&mut self) -> Vec<Out> {
        self.ear = Ear::Idle;
        self.speaking = false;
        self.state_change().into_iter().collect()
    }
}

/// Native tools the core can ask for (screenshots, clicks, keychain…).
fn run_host_tool(call: &Value) -> Value {
    let name = call["name"].as_str().unwrap_or_default();
    // TODO(M3): screenshot (xcap), point_at overlay, click/type (enigo), read_ui (a11y tree), keychain.
    json!({
        "type": "host_tool_result",
        "callId": call["callId"],
        "ok": false,
        "result": format!("host tool `{name}` is not implemented yet"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states(out: &[Out]) -> Vec<String> {
        out.iter()
            .filter_map(|o| match o {
                Out::Ui(v) if v["type"] == "state" => v["state"].as_str().map(String::from),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn full_voice_turn_shows_the_right_states() {
        let mut r = Router::default();
        assert_eq!(states(&r.on_voice(json!({"type": "wake"}))), ["listening"]);
        assert_eq!(states(&r.on_voice(json!({"type": "listening"}))), Vec::<String>::new());
        assert_eq!(states(&r.on_voice(json!({"type": "transcribing"}))), ["thinking"]);

        let out = r.on_voice(json!({"type": "utterance", "text": "what's the weather"}));
        assert!(out.contains(&Out::Core(json!({
            "type": "utterance", "id": "voice-1", "text": "what's the weather", "source": "voice"
        }))));
        assert!(out.contains(&Out::Ui(json!({"type": "heard", "text": "what's the weather"}))));
        assert_eq!(states(&out), ["idle"]);

        assert_eq!(states(&r.on_core(json!({"type": "state", "state": "thinking"}))), ["thinking"]);
        let out = r.on_core(json!({"type": "speak", "text": "It's sunny."}));
        assert!(out.contains(&Out::Voice(json!({"type": "speak", "text": "It's sunny.", "expectReply": false}))));
        assert_eq!(states(&r.on_voice(json!({"type": "speaking", "active": true}))), ["speaking"]);
        // The core finishes before the voice does: keep showing "speaking".
        assert_eq!(states(&r.on_core(json!({"type": "state", "state": "idle"}))), Vec::<String>::new());
        assert_eq!(states(&r.on_voice(json!({"type": "speaking", "active": false}))), ["idle"]);
    }

    #[test]
    fn confirmation_question_beats_speaking_and_reply_flag_reaches_voice() {
        let mut r = Router::default();
        r.on_core(json!({"type": "state", "state": "confirm"}));
        let out = r.on_core(json!({"type": "speak", "text": "Post it?", "expectReply": true}));
        assert!(out.contains(&Out::Voice(json!({"type": "speak", "text": "Post it?", "expectReply": true}))));
        r.on_voice(json!({"type": "speaking", "active": true}));
        assert_eq!(r.display(), "confirm");
        // While the mic listens for the answer, the card stays up.
        r.on_voice(json!({"type": "speaking", "active": false}));
        r.on_voice(json!({"type": "listening"}));
        assert_eq!(r.display(), "confirm");
        r.on_core(json!({"type": "state", "state": "working"}));
        assert_eq!(r.display(), "listening");
    }

    #[test]
    fn cancel_stops_the_voice_too() {
        let mut r = Router::default();
        r.on_voice(json!({"type": "wake"}));
        let out = r.on_ui(json!({"type": "cancel"}));
        assert!(out.contains(&Out::Voice(json!({"type": "stop"}))));
        assert!(out.contains(&Out::Core(json!({"type": "cancel"}))));
        assert_eq!(states(&out), ["idle"]);
    }

    #[test]
    fn typing_a_request_interrupts_speech() {
        let mut r = Router::default();
        let out = r.on_ui(json!({"type": "utterance", "id": "t1", "text": "never mind, open Spotify", "source": "typed"}));
        assert_eq!(out[0], Out::Voice(json!({"type": "stop"})));
        assert!(matches!(&out[1], Out::Core(v) if v["text"] == "never mind, open Spotify"));
    }

    #[test]
    fn host_tool_calls_are_answered_to_the_core() {
        let mut r = Router::default();
        let out = r.on_core(json!({"type": "host_tool_call", "callId": "c1", "name": "screenshot", "args": {}}));
        match &out[0] {
            Out::Core(v) => {
                assert_eq!(v["type"], "host_tool_result");
                assert_eq!(v["callId"], "c1");
                assert_eq!(v["ok"], false);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn voice_crash_resets_listening() {
        let mut r = Router::default();
        r.on_voice(json!({"type": "wake"}));
        assert_eq!(states(&r.voice_gone()), ["idle"]);
    }
}
