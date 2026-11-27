fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["read_work_map", "read_project_trends"]),
    ))
    .expect("Lite read command manifest build failed");
}
