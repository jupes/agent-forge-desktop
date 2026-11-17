use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

/// Native-only controls. No renderer IPC or action authority is exposed.
pub fn install(
    app: &tauri::AppHandle,
    reveal: Arc<AtomicU64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let keep = CheckMenuItem::with_id(
        app,
        "keep-window",
        "Keep running when window closes (this launch)",
        true,
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open-window", "Open Agent Forge", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit-app", "Quit Agent Forge", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &keep, &quit])?;
    let keep_running = Arc::new(AtomicBool::new(false));
    let quitting = Arc::new(AtomicBool::new(false));
    let keep_choice = keep_running.clone();
    let menu_quitting = quitting.clone();
    TrayIconBuilder::with_id("agent-forge")
        .icon(
            app.default_window_icon()
                .ok_or("tray icon unavailable")?
                .clone(),
        )
        .tooltip("Agent Forge — open for current project status")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "keep-window" => {
                // An unreadable choice must never silently opt in to background work.
                keep_choice.store(keep.is_checked().unwrap_or(false), Ordering::SeqCst);
            }
            "open-window" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.show().is_ok() && window.unminimize().is_ok() {
                        let _ = window.set_focus();
                        reveal.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
            "quit-app" => request_quit(app, &menu_quitting),
            _ => {}
        })
        .build(app)?;
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let close_window = window.clone();
    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Keep the same WebView and its explicit notification opt-in alive.
            api.prevent_close();
            if keep_running.load(Ordering::SeqCst) {
                let _ = close_window.hide();
            } else {
                request_quit(&close_app, &quitting);
            }
        }
    });
    Ok(())
}

fn request_quit(app: &tauri::AppHandle, pending: &AtomicBool) {
    if pending.swap(true, Ordering::SeqCst) {
        return;
    }
    // Existing Exit handler owns shutdown of the app and its exact owned host.
    app.exit(0);
}

/// Close exits through the existing shutdown handler without creating a tray icon.
pub fn install_foreground_close(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let close_app = app.clone();
    let pending = AtomicBool::new(false);
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            request_quit(&close_app, &pending);
        }
    });
    Ok(())
}
