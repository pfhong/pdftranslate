// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

/// 引擎是否已在监听 8765 端口
fn engine_running() -> bool {
    use std::net::SocketAddr;
    let addr: SocketAddr = "127.0.0.1:8765".parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 在后台拉起翻译引擎（uvicorn）。cwd 必须是包含 engine/ 的项目根目录；
/// Windows 下隐藏控制台窗口（CREATE_NO_WINDOW）。
fn spawn_engine() {
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = &exe_dir {
        // 打包版：<install>/engine
        candidates.push(dir.join("engine_root"));
        // 开发版：<root>/src-tauri/target/{debug,release}/ 向上三级
        candidates.push(dir.ancestors().nth(3).map(|p| p.to_path_buf()).unwrap_or_default());
        candidates.push(dir.ancestors().nth(2).map(|p| p.to_path_buf()).unwrap_or_default());
    }
    candidates.push(std::env::current_dir().unwrap_or_default());

    for root in candidates {
        if !root.join("engine").join("main.py").exists() {
            continue;
        }
        let mut cmd = Command::new("python");
        cmd.args([
            "-m",
            "uvicorn",
            "engine.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8765",
        ])
        .current_dir(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if cmd.spawn().is_ok() {
            println!("engine spawned from {}", root.display());
            return;
        }
    }
    println!("engine spawn failed: no engine/ root found");
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|_app| {
            // 引擎未运行时自动拉起（异步，不阻塞窗口创建）
            std::thread::spawn(|| {
                if !engine_running() {
                    spawn_engine();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
