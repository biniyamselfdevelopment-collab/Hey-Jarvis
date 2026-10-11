mod core_bridge;
mod voice;

use core_bridge::CoreBridge;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Manager, PhysicalPosition, State, WebviewWindow};

/// Forward a host message (typed utterance, confirm click, cancel) to the agent core.
#[tauri::command]
fn send_to_core(message: Value, bridge: State<'_, CoreBridge>) -> Result<(), String> {
    bridge.send(&message)
}

/// Pin the pill to the top-center of the screen, under the notch on MacBooks.
fn place_top_center(win: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match win.current_monitor()? {
        Some(m) => Some(m),
        None => win.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let (screen, origin, size) = (monitor.size(), monitor.position(), win.outer_size()?);
        let x = origin.x + (screen.width as i32 - size.width as i32) / 2;
        win.set_position(PhysicalPosition::new(x, origin.y))?;
    }
    Ok(())
}

fn build_tray(app: &App) -> tauri::Result<()> {
    // TODO(M1): Settings, Models, Accounts, Permissions, History entries.
    let quit = MenuItem::with_id(app, "quit", "Quit Hey Jarvis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("Hey Jarvis")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(win) = app.get_webview_window("pill") {
                place_top_center(&win)?;
            }
            build_tray(app)?;
            let handle = app.handle().clone();
            let bridge = tauri::async_runtime::block_on(async move { CoreBridge::spawn(handle) })?;
            app.manage(bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_to_core])
        .run(tauri::generate_context!())
        .expect("error while running Hey Jarvis");
}
