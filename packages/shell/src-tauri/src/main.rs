// Henry's native window. It owns no state and talks to nothing: it loads the page the
// daemon already serves and gives macOS a real menu, so ⌘N and ⌘1..9 reach the UI
// instead of being swallowed by the browser. Menu items arrive in the page as
// `henry:menu` CustomEvents (see packages/ui/src/shell.ts); there is no IPC surface,
// which is why loading a remote origin needs no extra capabilities.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn henry_url() -> String {
    if let Ok(url) = std::env::var("HENRY_URL") {
        return url;
    }
    let port = std::env::var("HENRY_PORT").unwrap_or_else(|_| "4711".into());
    format!("http://127.0.0.1:{port}")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url = henry_url().parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Henry")
                .inner_size(1440.0, 900.0)
                .min_inner_size(880.0, 540.0)
                // Tauri's OS drag-drop handler registers the whole window as a file drop
                // target, which eats the HTML5 drag events dockview needs to move panels.
                // Henry accepts no dropped files, so nothing is lost by turning it off.
                .disable_drag_drop_handler()
                .build()?;

            let new_session = MenuItem::with_id(app, "new-session", "New Session", true, Some("CmdOrCtrl+N"))?;
            let reset_layout = MenuItem::with_id(app, "reset-layout", "Reset Layout", true, Some("CmdOrCtrl+Shift+R"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;

            let menu = Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "Henry",
                        true,
                        &[
                            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::hide(app, None)?,
                            &PredefinedMenuItem::hide_others(app, None)?,
                            &PredefinedMenuItem::show_all(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::quit(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "File",
                        true,
                        &[&new_session, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::close_window(app, None)?],
                    )?,
                    // The Edit submenu is not decoration: without these roles WKWebView
                    // never delivers ⌘C/⌘V to xterm.
                    &Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app, None)?,
                            &PredefinedMenuItem::redo(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::cut(app, None)?,
                            &PredefinedMenuItem::copy(app, None)?,
                            &PredefinedMenuItem::paste(app, None)?,
                            &PredefinedMenuItem::select_all(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "View",
                        true,
                        &[&reset_layout, &reload, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::fullscreen(app, None)?],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Window",
                        true,
                        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
                    )?,
                ],
            )?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            // Ids are literals from this file, so quoting them straight into JS is safe.
            let js = match event.id().0.as_str() {
                "reload" => "location.reload()".to_string(),
                id => format!("window.dispatchEvent(new CustomEvent('henry:menu',{{detail:'{id}'}}))"),
            };
            let _ = window.eval(&js);
        })
        .run(tauri::generate_context!())
        .expect("henry shell failed to start");
}
