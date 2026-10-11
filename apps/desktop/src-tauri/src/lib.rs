mod router;
mod sidecar;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use router::{Out, Router};
use serde_json::{json, Value};
use sidecar::Sidecar;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

/// Connects the agent core, the voice engine and the pill.
struct Hub {
    app: AppHandle,
    router: Mutex<Router>,
    core: OnceLock<Sidecar>,
    voice: OnceLock<Sidecar>,
}

impl Hub {
    fn deliver(&self, outs: Vec<Out>) {
        for out in outs {
            match out {
                Out::Ui(msg) => {
                    let _ = self.app.emit("core-message", msg);
                }
                Out::Core(msg) => match self.core.get() {
                    Some(core) => {
                        let _ = core.send(&msg);
                    }
                    None => eprintln!("[hub] core not running; dropped {msg}"),
                },
                Out::Voice(msg) => {
                    if let Some(voice) = self.voice.get() {
                        let _ = voice.send(&msg);
                    }
                }
            }
        }
    }

    fn route(&self, f: impl FnOnce(&mut Router) -> Vec<Out>) {
        let outs = f(&mut self.router.lock().expect("router poisoned"));
        self.deliver(outs);
    }

    /// Let the sidecars exit cleanly (the core stops OpenCode on its way out).
    fn shutdown(&self) {
        if let Some(voice) = self.voice.get() {
            voice.shutdown(Duration::from_millis(1500));
        }
        if let Some(core) = self.core.get() {
            core.shutdown(Duration::from_secs(4));
        }
    }

    fn ui_error(&self, message: String) {
        let _ = self.app.emit("core-message", json!({ "type": "error", "message": message }));
    }
}

/// Region of the window (CSS px) occupied by the pill; clicks elsewhere pass through.
#[derive(Default)]
struct HitRegion(Mutex<Option<(f64, f64, f64, f64)>>);

/// Forward a pill message (typed request, confirm click, cancel) to the agent core.
#[tauri::command]
fn send_to_core(message: Value, hub: State<'_, Arc<Hub>>) {
    hub.route(|r| r.on_ui(message));
}

/// Start listening without the wake word (mic button / hotkey).
#[tauri::command]
fn listen(hub: State<'_, Arc<Hub>>) {
    hub.route(|r| r.listen());
}

#[tauri::command]
fn set_hit_region(x: f64, y: f64, width: f64, height: f64, region: State<'_, HitRegion>) {
    *region.0.lock().expect("hit region poisoned") = Some((x, y, width, height));
}

/// Pin the pill to the top-center of the screen, under the notch on MacBooks.
fn place_top_center(win: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match win.current_monitor()? {
        Some(m) => Some(m),
        None => win.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let (screen, origin) = (monitor.size(), monitor.position());
        // Before the window is mapped some platforms report a 0 size; fall back to the configured width.
        let width = match win.outer_size()?.width {
            0 => {
                let configured = win.config().app.windows.iter().find(|w| w.label == win.label()).map_or(440.0, |w| w.width);
                (configured * monitor.scale_factor()) as u32
            }
            w => w,
        };
        let x = origin.x + (screen.width as i32 - width as i32) / 2;
        win.set_position(PhysicalPosition::new(x, origin.y))?;
    }
    Ok(())
}

/// The window is bigger than the pill (room to expand), so make the transparent
/// parts click-through by toggling cursor events as the mouse enters/leaves the pill.
fn watch_click_through(app: &AppHandle, win: WebviewWindow) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut inside_last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let region = *app.state::<HitRegion>().0.lock().expect("hit region poisoned");
            let (Ok(cursor), Ok(origin), Ok(scale)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) else {
                continue;
            };
            let inside = region.is_some_and(|(x, y, w, h)| {
                let (left, top) = (origin.x as f64 + x * scale, origin.y as f64 + y * scale);
                cursor.x >= left && cursor.x <= left + w * scale && cursor.y >= top && cursor.y <= top + h * scale
            });
            if inside_last != Some(inside) {
                let _ = win.set_ignore_cursor_events(!inside);
                inside_last = Some(inside);
            }
        }
    });
}

fn build_tray(app: &App) -> tauri::Result<()> {
    // TODO(M2): Settings, Models, Accounts, Permissions, History entries.
    let listen = MenuItem::with_id(app, "listen", "Listen (Ctrl+Shift+J)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hey Jarvis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&listen, &quit])?;
    let mut tray = TrayIconBuilder::new().tooltip("Hey Jarvis").menu(&menu).on_menu_event(|app, event| {
        match event.id.as_ref() {
            "quit" => app.exit(0),
            "listen" => app.state::<Arc<Hub>>().route(|r| r.listen()),
            _ => {}
        }
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn start_sidecars(hub: &Arc<Hub>) {
    let (h_msg, h_exit) = (hub.clone(), hub.clone());
    match Sidecar::spawn(
        sidecar::core_command(),
        "core",
        move |msg| h_msg.route(|r| r.on_core(msg)),
        move |why| h_exit.ui_error(format!("The agent core stopped ({why}).")),
    ) {
        Ok(core) => {
            let _ = hub.core.set(core);
        }
        Err(e) => hub.ui_error(e),
    }

    let (h_msg, h_exit) = (hub.clone(), hub.clone());
    match Sidecar::spawn(
        sidecar::voice_command(),
        "voice",
        move |msg| h_msg.route(|r| r.on_voice(msg)),
        move |why| {
            h_exit.route(|r| r.voice_gone());
            h_exit.ui_error(format!("Voice stopped ({why}). Typed requests still work."));
        },
    ) {
        Ok(voice) => {
            let _ = hub.voice.set(voice);
        }
        Err(e) => hub.ui_error(format!(
            "{e}. Voice needs uv — install it with `winget install astral-sh.uv`, then restart Jarvis."
        )),
    }
}

/// Windows: put Jarvis in a job object that kills every child process (core,
/// OpenCode, the voice engine) when Jarvis exits — even if it crashes.
#[cfg(windows)]
fn kill_children_with_app() {
    use win32job::{ExtendedLimitInfo, Job};
    let mut info = ExtendedLimitInfo::new();
    info.limit_kill_on_job_close();
    match Job::create_with_limit_info(&info).and_then(|job| job.assign_current_process().map(|_| job)) {
        // Keep the job handle open for the life of the process.
        Ok(job) => std::mem::forget(job),
        Err(e) => eprintln!("[jarvis] couldn't create job object: {e:?}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    kill_children_with_app();

    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(["ctrl+shift+j", "ctrl+shift+k"])
        .expect("valid shortcuts")
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let hub = app.state::<Arc<Hub>>();
            if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyJ) {
                hub.route(|r| r.listen());
            } else if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyK) {
                if let Some(win) = app.get_webview_window("pill") {
                    let _ = win.set_ignore_cursor_events(false);
                    let _ = win.set_focus();
                }
                let _ = app.emit("core-message", json!({ "type": "focus_input" }));
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(shortcuts)
        .manage(HitRegion::default())
        .setup(|app| {
            let hub = Arc::new(Hub {
                app: app.handle().clone(),
                router: Mutex::new(Router::default()),
                core: OnceLock::new(),
                voice: OnceLock::new(),
            });
            app.manage(hub.clone());
            if let Some(win) = app.get_webview_window("pill") {
                place_top_center(&win)?;
                watch_click_through(app.handle(), win);
            }
            build_tray(app)?;
            tauri::async_runtime::block_on(async { start_sidecars(&hub) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_to_core, listen, set_hit_region])
        .build(tauri::generate_context!())
        .expect("error while building Hey Jarvis")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Arc<Hub>>().shutdown();
            }
        });
}
