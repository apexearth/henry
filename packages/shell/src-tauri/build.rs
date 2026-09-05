fn main() {
    // tauri-build watches tauri.conf.json but not the icon files it points at, so redrawing
    // an icon leaves the old bytes compiled into the binary. It matters most in dev on macOS:
    // there is no .app bundle, and the Dock icon is icons/icon.png embedded by
    // generate_context!, so without this the window keeps yesterday's face until a clean build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
