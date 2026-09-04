// Henry's native window. It owns no state and talks to nothing: it loads the page the
// daemon already serves and gives the window a real menu, so ⌘N and ⌘1..9 reach the UI
// instead of being swallowed by the browser. Menu items arrive in the page as `henry:menu`
// CustomEvents (see packages/ui/src/shell.ts); there is no IPC surface, which is why
// loading a remote origin needs no extra capabilities.
//
// Windows gets no menu bar: it would take a row of the window for nothing, since wry turns
// WebView2's browser accelerators off and the page binds every Ctrl chord itself.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
#[cfg(not(target_os = "windows"))]
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(not(target_os = "windows"))]
use tauri::{App, Wry};
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
            #[cfg(not(target_os = "windows"))]
            app.set_menu(build_menu(app)?)?;
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

#[cfg(not(target_os = "windows"))]
fn build_menu(app: &App) -> tauri::Result<Menu<Wry>> {
    let new_session = MenuItem::with_id(app, "new-session", "New Session", true, Some("CmdOrCtrl+N"))?;
    // ⌘D on macOS; Ctrl+D is EOF in a terminal, so Windows and Linux get Ctrl+Shift+D (as the page does).
    #[cfg(target_os = "macos")]
    let duplicate_accel = "Cmd+D";
    #[cfg(not(target_os = "macos"))]
    let duplicate_accel = "Ctrl+Shift+D";
    let duplicate_session = MenuItem::with_id(app, "duplicate-session", "Duplicate Session", true, Some(duplicate_accel))?;
    let reset_layout = MenuItem::with_id(app, "reset-layout", "Reset Layout", true, Some("CmdOrCtrl+Shift+R"))?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;

    // The application menu (About, Hide, Quit) is a macOS convention; elsewhere the
    // menu bar starts at File, with Quit at its end.
    #[cfg(target_os = "macos")]
    let henry = Submenu::with_items(
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
    )?;
    #[cfg(target_os = "macos")]
    let file_tail: Vec<Box<dyn IsMenuItem<Wry>>> = vec![Box::new(PredefinedMenuItem::close_window(app, None)?)];
    #[cfg(not(target_os = "macos"))]
    let file_tail: Vec<Box<dyn IsMenuItem<Wry>>> = vec![Box::new(PredefinedMenuItem::close_window(app, None)?), Box::new(PredefinedMenuItem::quit(app, None)?)];
    let mut file_items: Vec<&dyn IsMenuItem<Wry>> = vec![&new_session, &duplicate_session];
    let file_sep = PredefinedMenuItem::separator(app)?;
    file_items.push(&file_sep);
    for item in &file_tail {
        file_items.push(item.as_ref());
    }
    let file = Submenu::with_items(app, "File", true, &file_items)?;
    // The Edit submenu is not decoration: without these roles WKWebView
    // never delivers ⌘C/⌘V to xterm.
    let edit = Submenu::with_items(
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
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&reset_layout, &reload, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    #[cfg(target_os = "macos")]
    items.push(&henry);
    items.extend([&file as &dyn IsMenuItem<Wry>, &edit, &view, &window]);
    Menu::with_items(app, &items)
}
