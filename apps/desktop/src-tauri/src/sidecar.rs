//! Child processes that speak JSON lines on stdio: the agent core (Node) and
//! the voice engine (Python via uv).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

#[derive(Default)]
struct Life {
    /// We asked it to stop, so its exit is not a crash.
    stopping: bool,
    exited: bool,
}

pub struct Sidecar {
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    life: Arc<(Mutex<Life>, Condvar)>,
}

impl Sidecar {
    /// Must be called inside the async runtime (tokio process needs a reactor).
    pub fn spawn(
        mut command: Command,
        name: &'static str,
        on_message: impl Fn(Value) + Send + 'static,
        on_exit: impl FnOnce(String) + Send + 'static,
    ) -> Result<Self, String> {
        #[cfg(windows)]
        {
            // Don't flash a console window for each sidecar.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start {name}: {e}"))?;

        let mut stdin = child.stdin.take().ok_or("stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("stdout unavailable")?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let life = Arc::new((Mutex::new(Life::default()), Condvar::new()));
        let life_reader = life.clone();

        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            // Sender dropped (shutdown): stdin closes here, which tells the sidecar to exit.
        });

        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Value>(&line) {
                    Ok(msg) => on_message(msg),
                    Err(_) => eprintln!("[{name}] {line}"),
                }
            }
            let status = child.wait().await;
            let (lock, cvar) = &*life_reader;
            let stopping = {
                let mut life = lock.lock().expect("sidecar state poisoned");
                life.exited = true;
                life.stopping
            };
            cvar.notify_all();
            if !stopping {
                on_exit(format!("{name} exited: {status:?}"));
            }
        });

        Ok(Self { tx: Mutex::new(Some(tx)), life })
    }

    pub fn send(&self, message: &Value) -> Result<(), String> {
        match &*self.tx.lock().expect("sidecar poisoned") {
            Some(tx) => tx.send(format!("{message}\n")).map_err(|_| "sidecar is not running".to_string()),
            None => Err("sidecar is shutting down".to_string()),
        }
    }

    /// Close stdin so the sidecar can clean up (e.g. stop OpenCode), and wait up to
    /// `timeout` for it to exit. Anything still running is killed when its handle drops.
    pub fn shutdown(&self, timeout: Duration) {
        let (lock, cvar) = &*self.life;
        lock.lock().expect("sidecar state poisoned").stopping = true;
        drop(self.tx.lock().expect("sidecar poisoned").take());
        let life = lock.lock().expect("sidecar state poisoned");
        let _ = cvar.wait_timeout_while(life, timeout, |life| !life.exited);
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
}

/// Build a command from an env override like `JARVIS_CORE_CMD="node dist/main.js"`.
fn from_env(var: &str) -> Option<Command> {
    let custom = std::env::var(var).ok()?;
    let mut parts = custom.split_whitespace();
    let mut cmd = Command::new(parts.next()?);
    cmd.args(parts);
    Some(cmd)
}

/// The agent core. Dev: TypeScript sources via tsx.
pub fn core_command() -> Command {
    if let Some(cmd) = from_env("JARVIS_CORE_CMD") {
        return cmd;
    }
    // TODO(M6): ship the core as a compiled sidecar (`bun build --compile`) for release builds.
    let entry = repo_root().join("packages/core/src/main.ts");
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "npx", "tsx"]);
        c
    } else {
        let mut c = Command::new("npx");
        c.arg("tsx");
        c
    };
    cmd.arg(entry).current_dir(repo_root().join("packages/core"));
    cmd
}

/// The voice engine: `uv run` keeps its Python environment in sync automatically.
pub fn voice_command() -> Command {
    if let Some(cmd) = from_env("JARVIS_VOICE_CMD") {
        return cmd;
    }
    let project = repo_root().join("apps/voice");
    let mut cmd = Command::new("uv");
    cmd.arg("run").arg("--project").arg(&project);
    if !cfg!(target_os = "macos") {
        // CUDA runtime libraries for Whisper on NVIDIA GPUs (falls back to CPU without one).
        cmd.args(["--extra", "cuda"]);
    }
    cmd.args(["python", "-m", "jarvis_voice"]).current_dir(&project);
    cmd
}
