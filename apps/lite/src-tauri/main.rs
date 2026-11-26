#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod workspace;

use serde_json::Value;
use std::{
    env,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(20);

struct LiteWorkspace {
    root: PathBuf,
    reader: PathBuf,
    reading_map: Arc<AtomicBool>,
    reading_trends: Arc<AtomicBool>,
}

fn project_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("project-") else {
        return false;
    };
    let bytes = uuid.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            14 => *b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

fn snapshot(reader: &Path, root: &Path, project: Option<&str>) -> Result<Value, String> {
    let mut command = Command::new(reader);
    command
        .arg(if project.is_some() {
            "project-trends"
        } else {
            "work-map"
        })
        .arg(root);
    if let Some(id) = project {
        if !project_id(id) {
            return Err("Invalid project.".into());
        }
        command.arg(id);
    }
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "The Lite reader could not start.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("The Lite reader did not answer.")?;
    let read = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    let deadline = Instant::now() + DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The Lite reader did not finish in time.".into());
            }
        }
    };
    if !status.success() {
        return Err("The requested workspace observation is unavailable.".into());
    }
    let bytes = read
        .join()
        .map_err(|_| "The Lite reader stopped.")?
        .map_err(|_| "The Lite observation could not be read.")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("The Lite observation exceeded the read limit.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Lite observation.".into())
}

async fn read(state: State<'_, LiteWorkspace>, project: Option<String>) -> Result<Value, String> {
    if project.as_deref().is_some_and(|v| !project_id(v)) {
        return Err("Invalid project.".into());
    }
    let root = state.root.clone();
    let reader = state.reader.clone();
    let busy = if project.is_some() {
        &state.reading_trends
    } else {
        &state.reading_map
    }
    .clone();
    if busy.swap(true, Ordering::AcqRel) {
        return Err("A Lite read is already in progress.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = snapshot(&reader, &root, project.as_deref());
        busy.store(false, Ordering::Release);
        result
    })
    .await
    .map_err(|_| "The Lite reader task stopped.".to_string())?
}

#[tauri::command]
async fn read_work_map(state: State<'_, LiteWorkspace>) -> Result<Value, String> {
    read(state, None).await
}

#[tauri::command]
async fn read_project_trends(
    project_id: String,
    state: State<'_, LiteWorkspace>,
) -> Result<Value, String> {
    read(state, Some(project_id)).await
}

fn main() {
    let run = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_work_map, read_project_trends])
        .setup(|app| {
            let args: Vec<_> = env::args_os().skip(1).collect();
            if args
                .first()
                .is_some_and(|arg| arg == OsStr::new("--from-login"))
            {
                return Err("Unexpected Lite arguments.".into());
            }
            let Some(root) = workspace::select_root(
                &args,
                &env::current_dir()?,
                workspace::choose_folder,
                || false,
            )?
            else {
                app.handle().exit(0);
                return Ok(());
            };
            let exe = env::current_exe()?;
            app.manage(LiteWorkspace {
                reader: exe
                    .parent()
                    .ok_or("Lite application directory unavailable.")?
                    .join("desktop-host.exe"),
                root,
                reading_map: Arc::new(AtomicBool::new(false)),
                reading_trends: Arc::new(AtomicBool::new(false)),
            });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agent Forge Lite")
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost")
                            && url.port().is_none())
                })
                .inner_size(1240.0, 820.0)
                .min_inner_size(360.0, 420.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if run.is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::project_id;

    #[test]
    fn project_ids_require_the_catalog_shape() {
        assert!(project_id("project-12345678-abcd-40ef-a111-123456789abc"));
        for id in [
            "",
            "../project",
            "project-12345678-abcd-40ef-1111-123456789abc",
            "project-12345678-abcd-40ef-a111-123456789abc/overview",
        ] {
            assert!(!project_id(id));
        }
    }
}
