// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("[{}]", secs)
}

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

    let log_path = exe_dir
        .map(|d| d.join("engine-spawn.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("engine-spawn.log"));
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    for root in &candidates {
        if !root.join("engine").join("main.py").exists() {
            continue;
        }
        // 绿色版：包内自带嵌入式 Python（<exe_dir>/engine_root/python/python.exe），
        // 有就直接用，用户不必自己装 Python；没有才回退系统的 python / py
        let bundled = root.join("python").join("python.exe");
        let interpreters: Vec<(std::ffi::OsString, Vec<&str>)> = if bundled.is_file() {
            vec![(bundled.into_os_string(), Vec::new())]
        } else {
            vec![
                (std::ffi::OsString::from("python"), Vec::new()),
                (std::ffi::OsString::from("py"), vec!["-3"]),
            ]
        };
        for (py, pre_args) in interpreters {
            let mut cmd = Command::new(&py);
            cmd.args(&pre_args);
            cmd.args([
                "-m",
                "uvicorn",
                "engine.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                "8765",
            ])
            .current_dir(root)
            // 告知引擎"我是谁"：引擎据此守望，本应用退出（含被强杀）时它一并退出，
            // 不留孤儿进程，也保证下次启动用的是磁盘上这份代码
            .env("TR_PARENT_PID", std::process::id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            match cmd.spawn() {
                Ok(_) => {
                    let msg = format!(
                        "{}: spawned {} from {}
",
                        chrono_now(),
                        py.to_string_lossy(),
                        root.display()
                    );
                    if let Some(f) = log.as_mut() {
                        use std::io::Write;
                        let _ = f.write_all(msg.as_bytes());
                    }
                    return;
                }
                Err(e) => {
                    let msg = format!(
                        "{}: spawn {} from {} failed: {}
",
                        chrono_now(),
                        py.to_string_lossy(),
                        root.display(),
                        e
                    );
                    if let Some(f) = log.as_mut() {
                        use std::io::Write;
                        let _ = f.write_all(msg.as_bytes());
                    }
                }
            }
        }
    }

}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 按需拉起翻译引擎并等它就绪。
///
/// 引擎不随应用启动而常驻：只有真正要用（翻译 / 术语抽取 / 本地模型）时才拉起，
/// 由前端在动手之前调用。已经有一个引擎在跑就直接复用，不去动别人的进程。
/// 拉起后要等它 import fitz/OCR，冷启动通常数秒，这里最长等约 30 秒。
#[tauri::command]
async fn ensure_engine() -> Result<bool, String> {
    if engine_running() {
        return Ok(true);
    }
    spawn_engine();
    for _ in 0..120 {
        let waited = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(250));
        })
        .await;
        if waited.is_err() {
            break;
        }
        if engine_running() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 关注二维码素材与校验用的 SHA-256 指纹。
///
/// 图片以字节数组形式编译进本二进制，指纹常量也在这里；命令返回前会重新校验，
/// 对不上就不返回（前端据此不展示）。
const QR_ASSETS: &[(&str, &str, &str, &[u8])] = &[
    (
        "douyin-qr.png",
        "image/png",
        "f9174f3ac69fa2a51fc03b972eb72764c4102f72551cce3dde473d7ec8457ea5",
        include_bytes!("../assets/qr/douyin-qr.png"),
    ),
    (
        "wechat-qr.jpg",
        "image/jpeg",
        "917da796ad267e133c0ae287300ccb54c4605211611b69da14c602cc81b2ad51",
        include_bytes!("../assets/qr/wechat-qr.jpg"),
    ),
];

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[derive(serde::Serialize)]
pub struct QrAsset {
    pub key: String,
    pub mime: String,
    pub sha256: String,
    /// data URI，前端可直接放进 img.src
    pub data_uri: String,
}

/// 返回内置的关注二维码（data URI）。
///
/// 每个素材在返回前都会重新校验一次指纹，校验不过直接拒绝（返回 Err）。
#[tauri::command]
fn qr_assets() -> Result<Vec<QrAsset>, String> {
    use base64::Engine;
    let mut out = Vec::with_capacity(QR_ASSETS.len());
    for (key, mime, expected, bytes) in QR_ASSETS {
        let actual = sha256_hex(bytes);
        if actual != *expected {
            return Err(format!(
                "二维码素材 {key} 指纹不符（期望 {expected}，实际 {actual}），已拒绝提供"
            ));
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        out.push(QrAsset {
            key: (*key).to_string(),
            mime: (*mime).to_string(),
            sha256: actual,
            data_uri: format!("data:{mime};base64,{encoded}"),
        });
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![greet, ensure_engine, qr_assets])
        // 不在 setup 里预启动引擎：等前端真正要用时再 ensure_engine。
        // 引擎侧带 TR_PARENT_PID 守望，本应用退出时它自动退出。
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        // 标准测试向量：sha256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn embedded_qr_matches_pinned_hash() {
        for (key, _mime, expected, bytes) in QR_ASSETS {
            assert_eq!(&sha256_hex(bytes), expected, "{key} 的内置字节与指纹常量不一致");
        }
    }

    #[test]
    fn qr_command_returns_data_uris() {
        let assets = qr_assets().expect("内置二维码应通过校验");
        assert_eq!(assets.len(), QR_ASSETS.len());
        for a in assets {
            assert!(a.data_uri.starts_with("data:image/"));
            assert!(a.data_uri.contains(";base64,"));
        }
    }
}
