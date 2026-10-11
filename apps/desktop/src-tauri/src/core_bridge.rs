//! Spawns the TypeScript agent core and pipes the JSON-lines protocol
//! (see `packages/core/src/protocol.ts`) between it and the pill webview.

use std::process::Stdio;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

pub struct CoreBridge {
    tx: mpsc::UnboundedSender<String>,
}

impl CoreBridge {
    /// Must be called inside the async runtime (tokio process needs a reactor).
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let mut child = core_command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start the agent core: {e}"))?;

        let mut stdin = child.stdin.take().ok_or("core stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("core stdout unavailable")?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let replies = tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    eprintln!("[bridge] non-JSON line from core: {line}");
                    continue;
                };
                if msg["type"] == "host_tool_call" {
                    let reply = run_host_tool(&msg);
                    let _ = replies.send(format!("{reply}\n"));
                }
                let _ = app.emit("core-message", msg);
            }
            let status = child.wait().await;
            let _ = app.emit("core-message", json!({ "type": "error", "message": format!("agent core exited: {status:?}") }));
        });

        Ok(Self { tx })
    }

    pub fn send(&self, message: &Value) -> Result<(), String> {
        self.tx.send(format!("{message}\n")).map_err(|_| "agent core is not running".to_string())
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

/// `JARVIS_CORE_CMD` overrides the command (e.g. a compiled `jarvis-core` binary).
/// Otherwise run the TypeScript sources with tsx, which is what `pnpm dev` wants.
fn core_command() -> Command {
    if let Ok(custom) = std::env::var("JARVIS_CORE_CMD") {
        let mut parts = custom.split_whitespace();
        let mut cmd = Command::new(parts.next().unwrap_or("jarvis-core"));
        cmd.args(parts);
        return cmd;
    }
    // TODO(M1): ship the core as a Tauri sidecar (`bun build --compile`) for release builds.
    let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/core/src/main.ts");
    if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npx", "tsx", entry]);
        cmd
    } else {
        let mut cmd = Command::new("npx");
        cmd.args(["tsx", entry]);
        cmd
    }
}
