use std::net::{SocketAddr, TcpStream};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;
use rfd::FileDialog;
use tauri::{Manager, RunEvent, WindowEvent};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn backend_online() -> bool {
  let addr: SocketAddr = match "127.0.0.1:8000".parse() {
    Ok(v) => v,
    Err(_) => return false,
  };
  TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn http_status(path: &str) -> Option<u16> {
  let addr: SocketAddr = "127.0.0.1:8000".parse().ok()?;
  let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
  stream.set_read_timeout(Some(Duration::from_millis(500))).ok()?;
  stream.set_write_timeout(Some(Duration::from_millis(500))).ok()?;

  let req = format!(
    "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    path
  );
  stream.write_all(req.as_bytes()).ok()?;

  let mut buf = [0u8; 256];
  let n = stream.read(&mut buf).ok()?;
  if n == 0 {
    return None;
  }
  let head = String::from_utf8_lossy(&buf[..n]);
  let mut parts = head.lines().next()?.split_whitespace();
  let _http = parts.next()?;
  let code = parts.next()?.parse::<u16>().ok()?;
  Some(code)
}

fn http_get_text(path: &str, max_bytes: usize) -> Option<String> {
  let addr: SocketAddr = "127.0.0.1:8000".parse().ok()?;
  let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
  stream.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
  stream.set_write_timeout(Some(Duration::from_millis(600))).ok()?;

  let req = format!(
    "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    path
  );
  stream.write_all(req.as_bytes()).ok()?;

  let mut out = Vec::with_capacity(max_bytes.min(16_384));
  let mut tmp = [0u8; 1024];
  while out.len() < max_bytes {
    let read_n = stream.read(&mut tmp).ok()?;
    if read_n == 0 {
      break;
    }
    let take = (max_bytes - out.len()).min(read_n);
    out.extend_from_slice(&tmp[..take]);
  }
  String::from_utf8(out).ok()
}

fn http_post(path: &str) -> Option<u16> {
  let addr: SocketAddr = "127.0.0.1:8000".parse().ok()?;
  let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
  stream.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
  stream.set_write_timeout(Some(Duration::from_millis(600))).ok()?;

  let req = format!(
    "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    path
  );
  stream.write_all(req.as_bytes()).ok()?;

  let mut buf = [0u8; 256];
  let n = stream.read(&mut buf).ok()?;
  if n == 0 {
    return None;
  }
  let head = String::from_utf8_lossy(&buf[..n]);
  let mut parts = head.lines().next()?.split_whitespace();
  let _http = parts.next()?;
  let code = parts.next()?.parse::<u16>().ok()?;
  Some(code)
}

fn stop_backend_blocking(timeout_ms: u64) {
  // Graceful shutdown first.
  let _ = http_post("/api/shutdown");
  let started = std::time::Instant::now();
  while started.elapsed() < Duration::from_millis(timeout_ms) {
    if !backend_online() {
      return;
    }
    std::thread::sleep(Duration::from_millis(150));
  }

  // Best-effort hard stop if still alive.
  #[cfg(target_os = "windows")]
  {
    let _ = Command::new("taskkill")
      .args(["/IM", "darts-backend.exe", "/F"])
      .spawn()
      .and_then(|mut child| child.wait());
    std::thread::sleep(Duration::from_millis(400));
  }
}

fn stop_backend_once(timeout_ms: u64) {
  // Idempotent by design: always attempt graceful shutdown, then hard-stop if needed.
  stop_backend_blocking(timeout_ms);
}

fn first_asset_path_from_index(index_response: &str) -> Option<String> {
  let body_start = index_response.find("\r\n\r\n").map(|i| i + 4)?;
  let body = &index_response[body_start..];
  let marker = "src=\"/assets/";
  let start = body.find(marker)? + 5; // include leading quote-less slash: /assets/...
  let tail = &body[start..];
  let end_quote = tail.find('"')?;
  Some(tail[..end_quote].to_string())
}

fn backend_candidates(resource_dir: &PathBuf) -> Vec<PathBuf> {
  let exe_dir = std::env::current_exe()
    .ok()
    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    .unwrap_or_else(|| resource_dir.clone());

  let names: [&str; 2] = if cfg!(target_os = "windows") {
    ["darts-backend.exe", "darts-backend"]
  } else {
    ["darts-backend", "darts-backend.exe"]
  };

  let roots = vec![
    resource_dir.join("backend").join("dist").join("darts-backend"),
    resource_dir.join("backend").join("dist"),
    resource_dir.clone(),
    resource_dir.join("_up_").join("_up_").join("backend").join("dist").join("darts-backend"),
    resource_dir.join("_up_").join("_up_").join("backend").join("dist"),
    resource_dir.join("_up_").join("_up_"),
    exe_dir.join("backend").join("dist").join("darts-backend"),
    exe_dir.join("backend").join("dist"),
    exe_dir.join("_up_").join("_up_").join("backend").join("dist").join("darts-backend"),
    exe_dir.join("_up_").join("_up_").join("backend").join("dist"),
    exe_dir.join("resources").join("backend").join("dist").join("darts-backend"),
    exe_dir.join("resources").join("backend").join("dist"),
    exe_dir.join("resources"),
  ];

  let mut out = Vec::with_capacity(roots.len() * names.len());
  for root in roots {
    for name in names {
      out.push(root.join(name));
    }
  }
  out
}

fn spawn_backend(resource_dir: &PathBuf) -> Result<Option<Child>, String> {
  if backend_online() {
    return Ok(None);
  }

  let exe_path = backend_candidates(resource_dir)
    .into_iter()
    .find(|p| p.exists())
    .ok_or_else(|| format!("darts-backend binary not found under resources: {}", resource_dir.display()))?;

  let mut cmd = Command::new(&exe_path);
  if let Some(value) = option_env!("MACHINE_DARTS_SCORING_CAMERA_COUNT") {
    cmd.env("MACHINE_DARTS_SCORING_CAMERA_COUNT", value);
  }
  if let Some(value) = option_env!("MACHINE_DARTS_CAMERA_SLOT_COUNT") {
    cmd.env("MACHINE_DARTS_CAMERA_SLOT_COUNT", value);
  }
  #[cfg(target_os = "windows")]
  {
    // CREATE_NO_WINDOW
    cmd.creation_flags(0x08000000);
  }

  cmd
    .spawn()
    .map(Some)
    .map_err(|e| format!("failed spawning backend '{}': {}", exe_path.display(), e))
}

#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    Command::new("cmd")
      .args(["/C", "start", "", &url])
      .spawn()
      .map_err(|e| format!("failed opening browser: {}", e))?;
    return Ok(());
  }

  #[cfg(target_os = "linux")]
  {
    Command::new("xdg-open")
      .arg(&url)
      .spawn()
      .map_err(|e| format!("failed opening browser: {}", e))?;
    return Ok(());
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(&url)
      .spawn()
      .map_err(|e| format!("failed opening browser: {}", e))?;
    return Ok(());
  }

  #[allow(unreachable_code)]
  Err("unsupported platform".to_string())
}

#[tauri::command]
fn close_machine_darts(app_handle: tauri::AppHandle) -> Result<(), String> {
  // Best effort backend shutdown, then always exit launcher.
  stop_backend_once(5_000);
  app_handle.exit(0);
  Ok(())
}

#[tauri::command]
fn prepare_update_install() -> Result<(), String> {
  stop_backend_once(8_000);
  Ok(())
}

#[tauri::command]
fn pick_replay_folder(initial_path: Option<String>) -> Result<Option<String>, String> {
  let mut dialog = FileDialog::new();
  if let Some(path) = initial_path {
    let trimmed = path.trim();
    if !trimmed.is_empty() {
      dialog = dialog.set_directory(trimmed);
    }
  }
  let picked = dialog.pick_folder();
  Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

fn wait_for_backend(timeout_secs: u64) -> bool {
  let started = std::time::Instant::now();
  while started.elapsed() < Duration::from_secs(timeout_secs) {
    // Require API + index route + first frontend asset to respond.
    let health_ok = matches!(http_status("/api/health"), Some(200));
    let index_text = http_get_text("/", 16_384);
    let index_ok = index_text
      .as_ref()
      .map(|t| t.contains("<!doctype html>") || t.contains("<!DOCTYPE html>"))
      .unwrap_or(false);
    let asset_ok = index_text
      .as_ref()
      .and_then(|t| first_asset_path_from_index(t))
      .map(|asset| matches!(http_status(&asset), Some(200)))
      .unwrap_or(false);

    if health_ok && index_ok && asset_ok {
      // Settle a little longer to reduce first-load white page races.
      std::thread::sleep(Duration::from_millis(700));
      return true;
    }
    std::thread::sleep(Duration::from_millis(250));
  }
  false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("failed resolving resource dir: {}", e))?;

      std::thread::spawn(move || {
        let launch_url = || {
          let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
          format!("http://127.0.0.1:8000/?boot={}#/", ts_ms)
        };
        // Always relaunch the bundled backend for installed builds so we don't
        // accidentally attach to an older backend already listening on 127.0.0.1:8000.
        stop_backend_once(3_000);
        match spawn_backend(&resource_dir) {
          Ok(_child) => {
            let ready = wait_for_backend(180);
            let url = if ready { launch_url() } else { launch_url() };
            let _ = open_in_browser(url);
          }
          Err(err) => {
            eprintln!("[tauri] backend auto-start failed: {}", err);
            let _ = open_in_browser(launch_url());
          }
        }
      });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_in_browser, close_machine_darts, prepare_update_install, pick_replay_folder])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|_app, event| match event {
    RunEvent::WindowEvent {
      event: WindowEvent::CloseRequested { .. },
      ..
    } => {
      stop_backend_once(5_000);
    }
    RunEvent::ExitRequested { .. } | RunEvent::Exit => {
      stop_backend_once(5_000);
    }
    _ => {}
  });
}
