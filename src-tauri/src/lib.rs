mod connectors;
mod wps_sync;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use chrono::{DateTime, Local};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
use walkdir::WalkDir;

const ROOT: &str = r"D:\自动归档";
const APP_DIR: &str = "归档助手-app";
const INSTALLED_APP_DIR: &str = "归档助手";
struct AppState {
    root: PathBuf,
    db: Mutex<Connection>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
    relative_path: String,
    modified_at: u64,
    item_count: usize,
    size: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    relative_path: String,
    absolute_path: String,
    is_directory: bool,
    extension: String,
    size: u64,
    modified_at: u64,
    favorite: bool,
    ocr_indexed: bool,
    tags: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteCategory {
    id: String,
    name: String,
    color: String,
    position: i64,
    count: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteLink {
    id: String,
    category_id: String,
    relative_path: String,
    display_name: String,
    missing: bool,
    created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanTask {
    id: String,
    title: String,
    plan_scope: String,
    due_date: String,
    remind_at: Option<String>,
    priority: String,
    repeat_rule: String,
    note: String,
    completed: bool,
    completed_at: Option<u64>,
    created_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInput {
    id: Option<String>,
    title: String,
    plan_scope: Option<String>,
    due_date: Option<String>,
    remind_at: Option<String>,
    priority: Option<String>,
    repeat_rule: Option<String>,
    note: Option<String>,
    completed: Option<bool>,
    completed_at: Option<u64>,
    created_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    storage_root: String,
    theme: String,
    start_on_login: bool,
    notifications: bool,
    ocr_auto_workspaces: Vec<String>,
    model_base_url: String,
    model_name: String,
    model_key_saved: bool,
    quiet_hours: bool,
    quiet_start: String,
    quiet_end: String,
    mobile_enabled: bool,
    wps_sync_dir: Option<String>,
    wps_sync_workspaces: Vec<String>,
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            storage_root: ROOT.into(),
            theme: "light".into(),
            start_on_login: true,
            notifications: true,
            ocr_auto_workspaces: vec![],
            model_base_url: "https://api.deepseek.com".into(),
            model_name: "deepseek-chat".into(),
            model_key_saved: keyring::Entry::new("BEN Archive Assistant", "model-api-key")
                .and_then(|e| e.get_password())
                .is_ok(),
            quiet_hours: false,
            quiet_start: "22:00".into(),
            quiet_end: "07:30".into(),
            mobile_enabled: false,
            wps_sync_dir: None,
            wps_sync_workspaces: vec![],
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorStatus {
    id: String,
    name: String,
    description: String,
    state: String,
    enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapData {
    workspaces: Vec<Workspace>,
    favorite_categories: Vec<FavoriteCategory>,
    favorites: Vec<FavoriteLink>,
    tasks: Vec<PlanTask>,
    settings: AppSettings,
    connectors: Vec<ConnectorStatus>,
    recent_files: Vec<FileEntry>,
    passwords: Vec<PasswordEntry>,
    all_tags: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordEntry {
    id: String,
    title: String,
    url: String,
    username: String,
    notes: String,
    group_tag: String,
    created_at: u64,
    updated_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult {
    success: bool,
    message: String,
    affected: Vec<String>,
    skipped: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcrResult {
    relative_path: String,
    text: String,
    confidence: f64,
    pages: usize,
    languages: Vec<String>,
    cached: bool,
    fingerprint: Option<String>,
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn db(s: &AppState) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    s.db.lock().map_err(|_| "本地数据库暂时不可用".into())
}
fn init_db(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(r#"PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS favorite_categories(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,color TEXT NOT NULL,position INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS favorites(id TEXT PRIMARY KEY,category_id TEXT NOT NULL,relative_path TEXT NOT NULL,display_name TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(category_id,relative_path),FOREIGN KEY(category_id) REFERENCES favorite_categories(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,due_date TEXT NOT NULL,remind_at TEXT,priority TEXT NOT NULL,repeat_rule TEXT NOT NULL,note TEXT NOT NULL,completed INTEGER NOT NULL,completed_at INTEGER,created_at INTEGER NOT NULL,plan_scope TEXT NOT NULL DEFAULT 'daily');
 CREATE TABLE IF NOT EXISTS ocr_results(relative_path TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,text TEXT NOT NULL,confidence REAL NOT NULL,pages INTEGER NOT NULL,languages TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS ocr_search USING fts5(relative_path UNINDEXED,text,tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,operation TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sync_bindings(id TEXT PRIMARY KEY,local_path TEXT NOT NULL,provider TEXT NOT NULL,drive_id TEXT,remote_file_id TEXT,direction TEXT NOT NULL,schedule TEXT,enabled INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,binding_id TEXT,state TEXT NOT NULL,detail TEXT,retries INTEGER DEFAULT 0,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS remote_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL,permissions TEXT NOT NULL,revoked INTEGER DEFAULT 0,last_seen INTEGER);
 CREATE TABLE IF NOT EXISTS ai_jobs(id TEXT PRIMARY KEY,provider TEXT NOT NULL,task_type TEXT NOT NULL,relative_path TEXT,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS password_entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',username TEXT NOT NULL DEFAULT '',password_enc TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',group_tag TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS file_tags(relative_path TEXT NOT NULL,tag TEXT NOT NULL,UNIQUE(relative_path,tag));"#)?;
    let has_plan_scope = c
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == "plan_scope");
    if !has_plan_scope {
        c.execute(
            "ALTER TABLE tasks ADD COLUMN plan_scope TEXT NOT NULL DEFAULT 'daily'",
            [],
        )?;
    }
    for (id, n, color, pos) in [
        ("notice", "通知类", "#315bdb", 0),
        ("speech", "讲稿类", "#b7791f", 1),
        ("board", "看板类", "#19806a", 2),
        ("slides", "宣讲 PPT", "#a14f7a", 3),
    ] {
        c.execute(
            "INSERT OR IGNORE INTO favorite_categories VALUES(?1,?2,?3,?4)",
            params![id, n, color, pos],
        )?;
    }
    // Clean favorites rows stored with Windows verbatim path prefixes (\\?\D:\...).
    let polluted: Vec<(String, String)> = c
        .prepare("SELECT id, relative_path FROM favorites")?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .filter(|(_, p)| p.starts_with(r"\\?\"))
        .map(|(id, p)| (id, p.trim_start_matches(r"\\?\").replace('/', "\\")))
        .collect();
    for (id, clean) in polluted {
        c.execute(
            "UPDATE favorites SET relative_path=?1 WHERE id=?2",
            params![clean, id],
        )?;
    }
    Ok(())
}
fn valid_name(n: &str) -> Result<(), String> {
    let trimmed = n.trim();
    if trimmed != n {
        return Err("名称首尾不能包含空格".into());
    }
    let n = trimmed;
    if n.is_empty() || n.chars().count() > 120 {
        return Err("名称需为 1–120 个字符".into());
    }
    if n.chars().any(|c| "<>:\"/\\|?*".contains(c)) || n.ends_with('.') || n.ends_with(' ') {
        return Err("名称包含 Windows 不允许的字符".into());
    }
    let u = n.to_ascii_uppercase();
    let b = u.split('.').next().unwrap_or("");
    if matches!(
        b,
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("该名称是 Windows 保留名称".into());
    }
    Ok(())
}
fn reserved(p: &Path) -> bool {
    p.file_name()
        .and_then(|v| v.to_str())
        .map(|n| {
            n == APP_DIR
                || n.starts_with('.')
                || (n == INSTALLED_APP_DIR
                    && (p.join("archive-assistant.exe").exists()
                        || p.join("uninstall.exe").exists()))
        })
        .unwrap_or(false)
}
fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
}
fn relative(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('/', "\\")
}
pub(crate) fn simplify(p: PathBuf) -> PathBuf {
    // Windows canonicalize() returns verbatim paths (\\?\D:\...) which leak into
    // stored relative paths and break strip_prefix comparisons; strip the prefix.
    let s = p.as_os_str().to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest.to_string()),
        None => p,
    }
}
fn safe(s: &AppState, r: &str) -> Result<PathBuf, String> {
    let p = Path::new(r);
    if !p.is_absolute()
        && p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("检测到不安全的文件路径".into());
    }
    let root = s
        .root
        .canonicalize()
        .map_err(|e| format!("无法访问存储目录：{e}"))?;
    let unresolved = if p.is_absolute() {
        p.to_path_buf()
    } else {
        s.root.join(p)
    };
    let candidate = unresolved
        .canonicalize()
        .map_err(|_| "文件或文件夹不存在".to_string())?;
    if !candidate.starts_with(&root) {
        return Err("目标不在归档目录内".into());
    }
    let top = candidate
        .strip_prefix(&root)
        .ok()
        .and_then(|relative| relative.components().next())
        .map(|component| root.join(component.as_os_str()));
    if top.as_deref().is_some_and(reserved) {
        return Err("应用程序目录不能作为工作区访问".into());
    }
    Ok(simplify(candidate))
}
pub(crate) fn hash(p: &Path) -> Result<String, String> {
    let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&b[..n])
    }
    Ok(format!("{:x}", h.finalize()))
}
const VAULT_SERVICE: &str = "BEN Archive Assistant";
const VAULT_ENTRY: &str = "vault-key";
fn vault_key() -> Result<[u8; 32], String> {
    use rand::RngCore;
    let entry = keyring::Entry::new(VAULT_SERVICE, VAULT_ENTRY).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(v.trim())
                .map_err(|_| "密码本主密钥格式无效，请重新设置".to_string())?;
            bytes
                .try_into()
                .map_err(|_| "密码本主密钥长度无效，请重新设置".to_string())
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&base64::engine::general_purpose::STANDARD.encode(key))
                .map_err(|e| format!("无法写入 Windows 凭据管理器：{e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("无法读取 Windows 凭据管理器：{e}")),
    }
}
fn encrypt_password(key: &[u8; 32], plain: &str) -> Result<String, String> {
    use rand::RngCore;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ct);
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}
fn decrypt_password(key: &[u8; 32], blob: &str) -> Result<String, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(blob.trim())
        .map_err(|_| "密码密文格式无效".to_string())?;
    if data.len() < 13 {
        return Err("密码密文不完整".into());
    }
    let (nonce_bytes, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "密码解密失败".to_string())?;
    String::from_utf8(plain).map_err(|_| "密码解码失败".to_string())
}

#[tauri::command]
fn open_file(app: AppHandle, state: State<AppState>, relative_path: String) -> Result<(), String> {
    let path = safe(&state, &relative_path)?;
    if !path.is_file() {
        return Err("只能使用系统软件打开文件".into());
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("无法使用默认软件打开文件：{error}"))
}

#[tauri::command]
fn open_file_with(state: State<AppState>, relative_path: String) -> Result<(), String> {
    let path = safe(&state, &relative_path)?;
    if !path.is_file() {
        return Err("只能为文件选择打开方式".into());
    }
    std::process::Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLLW")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法显示 Windows 打开方式：{error}"))
}

#[tauri::command]
fn reveal_in_explorer(
    app: AppHandle,
    state: State<AppState>,
    relative_path: String,
) -> Result<(), String> {
    let path = safe(&state, &relative_path)?;
    if !path.exists() {
        return Err("文件或文件夹不存在".into());
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| format!("无法在资源管理器中定位：{error}"))
}
fn is_favorite(c: &Connection, p: &str) -> bool {
    c.query_row(
        "SELECT 1 FROM favorites WHERE relative_path=?1 LIMIT 1",
        [p],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}
fn is_indexed(c: &Connection, p: &str) -> bool {
    c.query_row(
        "SELECT 1 FROM ocr_results WHERE relative_path=?1 LIMIT 1",
        [p],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}
fn entry(s: &AppState, c: &Connection, p: &Path, tags: &[String]) -> Result<FileEntry, String> {
    let m = p.metadata().map_err(|e| e.to_string())?;
    let r = relative(&s.root, p);
    Ok(FileEntry {
        name: p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        relative_path: r.clone(),
        absolute_path: p.to_string_lossy().to_string(),
        is_directory: m.is_dir(),
        extension: p
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase(),
        size: if m.is_file() { m.len() } else { 0 },
        modified_at: m.modified().map(ms).unwrap_or_default(),
        favorite: is_favorite(c, &r),
        ocr_indexed: is_indexed(c, &r),
        tags: tags.to_vec(),
    })
}
fn tag_map(c: &Connection) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = c.prepare("SELECT relative_path, tag FROM file_tags ORDER BY tag") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for (p, t) in rows.filter_map(Result::ok) {
                out.entry(p).or_default().push(t);
            }
        }
    }
    out
}
fn all_workspaces(s: &AppState) -> Result<Vec<Workspace>, String> {
    let mut out = vec![];
    for x in fs::read_dir(&s.root).map_err(|e| e.to_string())? {
        let x = x.map_err(|e| e.to_string())?;
        let p = x.path();
        if !p.is_dir() || reserved(&p) || is_link(&p) {
            continue;
        }
        let mut count = 0;
        let mut size = 0;
        for y in WalkDir::new(&p).into_iter().filter_map(Result::ok).skip(1) {
            count += 1;
            if y.file_type().is_file() {
                size += y.metadata().map(|m| m.len()).unwrap_or(0)
            }
        }
        let m = x.metadata().map_err(|e| e.to_string())?;
        let n = x.file_name().to_string_lossy().to_string();
        out.push(Workspace {
            id: n.clone(),
            name: n.clone(),
            relative_path: n,
            modified_at: m.modified().map(ms).unwrap_or_default(),
            item_count: count,
            size,
        })
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
fn cats(c: &Connection) -> Result<Vec<FavoriteCategory>, String> {
    let mut q=c.prepare("SELECT c.id,c.name,c.color,c.position,COUNT(f.id) FROM favorite_categories c LEFT JOIN favorites f ON f.category_id=c.id GROUP BY c.id ORDER BY c.position,c.name").map_err(|e|e.to_string())?;
    let result = q
        .query_map([], |r| {
            Ok(FavoriteCategory {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                position: r.get(3)?,
                count: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}
fn favs(s: &AppState, c: &Connection) -> Result<Vec<FavoriteLink>, String> {
    let mut q=c.prepare("SELECT id,category_id,relative_path,display_name,created_at FROM favorites ORDER BY created_at DESC").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .map(
            |(id, category_id, relative_path, display_name, created_at)| FavoriteLink {
                missing: !s.root.join(&relative_path).exists(),
                id,
                category_id,
                relative_path,
                display_name,
                created_at,
            },
        )
        .collect())
}
fn plans(c: &Connection) -> Result<Vec<PlanTask>, String> {
    let mut q=c.prepare("SELECT id,title,due_date,remind_at,priority,repeat_rule,note,completed,completed_at,created_at,plan_scope FROM tasks ORDER BY due_date,COALESCE(remind_at,'23:59'),created_at").map_err(|e|e.to_string())?;
    let result = q
        .query_map([], |r| {
            Ok(PlanTask {
                id: r.get(0)?,
                title: r.get(1)?,
                plan_scope: r.get(10)?,
                due_date: r.get(2)?,
                remind_at: r.get(3)?,
                priority: r.get(4)?,
                repeat_rule: r.get(5)?,
                note: r.get(6)?,
                completed: r.get(7)?,
                completed_at: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}
fn load_settings(c: &Connection) -> AppSettings {
    c.query_row("SELECT value FROM settings WHERE key='app'", [], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .and_then(|v| serde_json::from_str(&v).ok())
    .unwrap_or_default()
}
fn statuses(s: &AppSettings) -> Vec<ConnectorStatus> {
    vec![
        ConnectorStatus {
            id: "ocr".into(),
            name: "离线 OCR".into(),
            description: "中英文图片与扫描 PDF".into(),
            state: "ready".into(),
            enabled: true,
        },
        ConnectorStatus {
            id: "model".into(),
            name: "大模型".into(),
            description: "摘要、分类与命名建议".into(),
            state: if s.model_key_saved {
                "ready"
            } else {
                "reserved"
            }
            .into(),
            enabled: s.model_key_saved,
        },
        ConnectorStatus {
            id: "wps".into(),
            name: "WPS 云文档".into(),
            description: "归档文件同步到 WPS 云盘".into(),
            state: if s.wps_sync_dir.is_some()
                && !s.wps_sync_workspaces.is_empty()
            {
                "ready"
            } else {
                "reserved"
            }
            .into(),
            enabled: s.wps_sync_dir.is_some() && !s.wps_sync_workspaces.is_empty(),
        },
        ConnectorStatus {
            id: "wechat".into(),
            name: "微信提醒".into(),
            description: "合规消息连接器".into(),
            state: "reserved".into(),
            enabled: false,
        },
        ConnectorStatus {
            id: "mobile".into(),
            name: "手机访问".into(),
            description: "局域网配对与只读访问".into(),
            state: "reserved".into(),
            enabled: s.mobile_enabled,
        },
    ]
}
fn recent(s: &AppState, c: &Connection) -> Vec<FileEntry> {
    let tags = tag_map(c);
    let mut out: Vec<_> = WalkDir::new(&s.root)
        .max_depth(12)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !reserved(e.path()))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && !is_link(e.path()))
        .filter_map(|e| {
            let r = relative(&s.root, e.path());
            entry(s, c, e.path(), tags.get(&r).map(|v| v.as_slice()).unwrap_or(&[])).ok()
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.modified_at));
    out.truncate(20);
    out
}
#[tauri::command]
fn get_bootstrap(state: State<'_, AppState>) -> Result<BootstrapData, String> {
    let c = db(&state)?;
    let s = load_settings(&c);
    Ok(BootstrapData {
        workspaces: all_workspaces(&state)?,
        favorite_categories: cats(&c)?,
        favorites: favs(&state, &c)?,
        tasks: plans(&c)?,
        connectors: statuses(&s),
        recent_files: recent(&state, &c),
        passwords: password_list(&c)?,
        all_tags: {
            let mut stmt = c
                .prepare("SELECT DISTINCT tag FROM file_tags ORDER BY tag")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        },
        settings: s,
    })
}
#[tauri::command]
fn list_directory(
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<Vec<FileEntry>, String> {
    let dir = safe(&state, &relative_path)?;
    if !dir.is_dir() {
        return Err("目标不是文件夹".into());
    }
    let c = db(&state)?;
    let tags = tag_map(&c);
    let mut out = vec![];
    for x in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = x.map_err(|e| e.to_string())?.path();
        if !reserved(&p) && !is_link(&p) {
            let r = relative(&state.root, &p);
            out.push(entry(&state, &c, &p, tags.get(&r).map(|v| v.as_slice()).unwrap_or(&[]))?);
        }
    }
    out.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
#[tauri::command]
fn create_workspace(state: State<'_, AppState>, name: String) -> Result<BootstrapData, String> {
    valid_name(&name)?;
    if name == APP_DIR || name.starts_with('.') {
        return Err("该名称为系统保留名称".into());
    }
    let p = state.root.join(name.trim());
    if p.exists() {
        return Err("同名工作区已经存在".into());
    }
    fs::create_dir(p).map_err(|e| format!("创建工作区失败：{e}"))?;
    get_bootstrap(state)
}
#[tauri::command]
fn delete_workspace(
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<BootstrapData, String> {
    if Path::new(&relative_path).components().count() != 1 {
        return Err("只能删除完整的一级工作区".into());
    }
    let workspace = safe(&state, &relative_path)?;
    if !workspace.is_dir() {
        return Err("目标不是工作区".into());
    }
    let root = simplify(state.root.canonicalize().map_err(|e| e.to_string())?);
    if workspace.parent() != Some(root.as_path()) {
        return Err("只能删除一级工作区".into());
    }
    trash::delete(&workspace).map_err(|e| format!("无法移入 Windows 回收站：{e}"))?;
    let c = db(&state)?;
    log(&c, "trash-workspace", &relative_path);
    drop(c);
    get_bootstrap(state)
}
#[tauri::command]
fn create_folder(
    state: State<'_, AppState>,
    parent_path: String,
    name: String,
) -> Result<Vec<FileEntry>, String> {
    valid_name(&name)?;
    let parent = safe(&state, &parent_path)?;
    let p = parent.join(name.trim());
    if p.exists() {
        return Err("该位置已经存在同名项目".into());
    }
    fs::create_dir(p).map_err(|e| format!("创建文件夹失败：{e}"))?;
    list_directory(state, parent_path)
}

pub(crate) fn unique(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let f = Path::new(name);
    let stem = f.file_stem().unwrap_or_default().to_string_lossy();
    let ext = f
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..10000 {
        let n = dir.join(format!("{stem}_{i}{ext}"));
        if !n.exists() {
            return n;
        }
    }
    dir.join(format!("{stem}_{}{ext}", Uuid::new_v4()))
}
pub(crate) fn dated(p: &Path, label: &str, time: SystemTime) -> String {
    let d: DateTime<Local> = time.into();
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    format!("{stem}_{label}_{}{ext}", d.format("%Y%m%d-%H%M%S"))
}
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for x in WalkDir::new(from).min_depth(1) {
        let x = x.map_err(|e| format!("读取文件夹失败：{e}"))?;
        if x.file_type().is_symlink() {
            return Err("为保证安全，不支持导入或复制符号链接及目录连接".into());
        }
        let r = x.path().strip_prefix(from).map_err(|e| e.to_string())?;
        let t = to.join(r);
        if x.file_type().is_dir() {
            fs::create_dir_all(&t).map_err(|e| e.to_string())?
        } else {
            if let Some(parent) = t.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?
            }
            fs::copy(x.path(), t).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn ensure_no_links(path: &Path) -> Result<(), String> {
    if is_link(path) {
        return Err("为保证安全，不支持符号链接及目录连接".into());
    }
    if path.is_dir() {
        for entry in WalkDir::new(path) {
            let entry = entry.map_err(|e| format!("读取文件夹失败：{e}"))?;
            if entry.file_type().is_symlink() {
                return Err("文件夹中包含符号链接或目录连接，操作已取消".into());
            }
        }
    }
    Ok(())
}
fn move_item(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        copy_tree(from, to)?;
        fs::remove_dir_all(from).map_err(|e| e.to_string())?
    } else {
        fs::copy(from, to).map_err(|e| e.to_string())?;
        fs::remove_file(from).map_err(|e| e.to_string())?
    }
    Ok(())
}
fn transfer_one(from: &Path, dir: &Path, mode: &str) -> Result<Option<PathBuf>, String> {
    let name = from
        .file_name()
        .ok_or("来源文件名称无效")?
        .to_string_lossy()
        .to_string();
    let mut to = dir.join(&name);
    if from == to {
        return Err("来源和目标位置相同".into());
    }
    if to.exists() {
        if from.is_file() && to.is_file() {
            if hash(from)? == hash(&to)? {
                return Ok(None);
            }
            let fm = from
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            let tm = to
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            let fl = if fm == tm {
                "冲突版"
            } else if fm > tm {
                "最新版"
            } else {
                "历史版"
            };
            let tl = if fm == tm {
                "冲突版"
            } else if fm > tm {
                "历史版"
            } else {
                "最新版"
            };
            fs::rename(&to, unique(dir, &dated(&to, tl, tm)))
                .map_err(|e| format!("整理现有版本失败：{e}"))?;
            to = unique(dir, &dated(from, fl, fm));
        } else {
            to = unique(
                dir,
                &format!("{}_副本_{}", name, Local::now().format("%Y%m%d-%H%M%S")),
            );
        }
    }
    if mode == "copy" {
        if from.is_dir() {
            copy_tree(from, &to)?
        } else {
            fs::copy(from, &to).map_err(|e| e.to_string())?;
        }
    } else {
        move_item(from, &to)?
    }
    Ok(Some(to))
}
fn log(c: &Connection, op: &str, detail: &str) {
    let _ = c.execute(
        "INSERT INTO operations VALUES(?1,?2,?3,?4)",
        params![
            Uuid::new_v4().to_string(),
            op,
            detail,
            ms(SystemTime::now())
        ],
    );
}
#[tauri::command]
fn rename_entry(
    state: State<'_, AppState>,
    relative_path: String,
    new_name: String,
) -> Result<OperationResult, String> {
    valid_name(&new_name)?;
    let from = safe(&state, &relative_path)?;
    let to = from.parent().ok_or("无法确定父目录")?.join(new_name.trim());
    if to.exists() {
        return Err("该位置已经存在同名项目".into());
    }
    fs::rename(&from, &to).map_err(|e| format!("重命名失败：{e}"))?;
    let c = db(&state)?;
    let old = relative(&state.root, &from);
    let new = relative(&state.root, &to);
    let _ = c.execute(
        "UPDATE favorites SET relative_path=?1,display_name=?2 WHERE relative_path=?3",
        params![new, new_name, old],
    );
    let _ = c.execute(
        "UPDATE file_tags SET relative_path=?1 WHERE relative_path=?2",
        params![new, old],
    );
    log(&c, "rename", &format!("{old}->{new}"));
    Ok(OperationResult {
        success: true,
        message: "已完成重命名".into(),
        affected: vec![new],
        skipped: vec![],
    })
}
fn transfer_many(
    s: &AppState,
    sources: Vec<PathBuf>,
    target: String,
    mode: String,
) -> Result<OperationResult, String> {
    if mode != "copy" && mode != "move" {
        return Err("不支持的操作方式".into());
    }
    let dir = safe(s, &target)?;
    if !dir.is_dir() {
        return Err("目标位置不是文件夹".into());
    }
    let mut affected = vec![];
    let mut skipped = vec![];
    let mut moved_paths = vec![];
    for from in sources {
        if from == s.root
            || from.starts_with(s.root.join(APP_DIR))
            || from.starts_with(s.root.join(INSTALLED_APP_DIR))
        {
            return Err("存储根目录和应用程序目录不能被移动、复制或导入".into());
        }
        ensure_no_links(&from)?;
        if from.is_dir() && dir.starts_with(&from) {
            return Err("不能把文件夹移动或复制到它自己的子目录".into());
        }
        let label = from.to_string_lossy().to_string();
        match transfer_one(&from, &dir, &mode)? {
            Some(to) => {
                if mode == "move" && from.starts_with(&s.root) {
                    moved_paths.push((relative(&s.root, &from), relative(&s.root, &to)));
                }
                affected.push(relative(&s.root, &to));
            }
            None => skipped.push(label),
        }
    }
    let c = db(s)?;
    for (old, new) in moved_paths {
        let old_chars = old.chars().count() as i64 + 1;
        let _ = c.execute(
            "UPDATE favorites SET relative_path = CASE WHEN relative_path=?1 THEN ?2 ELSE ?2 || substr(relative_path, ?3) END WHERE relative_path=?1 OR substr(relative_path, 1, ?3)=?1 || '\\'",
            params![old, new, old_chars],
        );
        let _ = c.execute(
            "UPDATE file_tags SET relative_path = CASE WHEN relative_path=?1 THEN ?2 ELSE ?2 || substr(relative_path, ?3) END WHERE relative_path=?1 OR substr(relative_path, 1, ?3)=?1 || '\\'",
            params![old, new, old_chars],
        );
    }
    log(&c, &mode, &format!("{} item(s)->{target}", affected.len()));
    sync_affected_to_wps(s, &c, &affected);
    let message = if skipped.is_empty() {
        format!(
            "已{} {} 个项目",
            if mode == "copy" { "复制" } else { "移动" },
            affected.len()
        )
    } else {
        format!(
            "已处理 {} 个项目，跳过 {} 个内容相同的文件",
            affected.len(),
            skipped.len()
        )
    };
    Ok(OperationResult {
        success: true,
        message,
        affected,
        skipped,
    })
}
fn sync_affected_to_wps(s: &AppState, c: &Connection, affected: &[String]) {
    let settings = load_settings(c);
    let Some(dir) = settings.wps_sync_dir.clone() else {
        return;
    };
    if settings.wps_sync_workspaces.is_empty() {
        return;
    }
    let wps = PathBuf::from(&dir);
    let mut synced = 0usize;
    for path in affected {
        let Some(workspace) = Path::new(path).components().next() else {
            continue;
        };
        let workspace = workspace.as_os_str().to_string_lossy().to_string();
        if !settings
            .wps_sync_workspaces
            .iter()
            .any(|w| w == &workspace)
        {
            continue;
        }
        match wps_sync::sync_file(&s.root, &wps, path) {
            Ok(true) => synced += 1,
            Ok(false) => {}
            Err(e) => log(c, "wps-sync-failed", &format!("{path}：{e}")),
        }
    }
    if synced > 0 {
        log(
            c,
            "wps-sync",
            &format!("{synced} 个文件已复制到 WPS 同步目录"),
        );
    }
}
#[tauri::command]
fn transfer_entries(
    state: State<'_, AppState>,
    relative_paths: Vec<String>,
    target_path: String,
    mode: String,
) -> Result<OperationResult, String> {
    let sources = relative_paths
        .iter()
        .map(|p| safe(&state, p))
        .collect::<Result<Vec<_>, _>>()?;
    transfer_many(&state, sources, target_path, mode)
}
#[tauri::command]
fn import_files(
    state: State<'_, AppState>,
    source_paths: Vec<String>,
    target_path: String,
    mode: String,
) -> Result<OperationResult, String> {
    let mut sources = vec![];
    for v in source_paths {
        let p = PathBuf::from(v);
        if !p.is_absolute() || !p.exists() {
            return Err("选择的导入文件不存在".into());
        }
        sources.push(simplify(p.canonicalize().map_err(|e| e.to_string())?))
    }
    transfer_many(&state, sources, target_path, mode)
}
#[tauri::command]
fn delete_entries(
    state: State<'_, AppState>,
    relative_paths: Vec<String>,
) -> Result<OperationResult, String> {
    let items = relative_paths
        .iter()
        .map(|p| safe(&state, p))
        .collect::<Result<Vec<_>, _>>()?;
    let mut affected = vec![];
    for p in items {
        let r = relative(&state.root, &p);
        trash::delete(p).map_err(|e| format!("无法移入 Windows 回收站：{e}"))?;
        affected.push(r)
    }
    let c = db(&state)?;
    for r in &affected {
        let _ = c.execute(
            "DELETE FROM file_tags WHERE relative_path=?1 OR substr(relative_path,1,?2)=?1 || '\\'",
            params![r, r.chars().count() as i64 + 1],
        );
    }
    log(&c, "trash", &affected.join(";"));
    Ok(OperationResult {
        success: true,
        message: format!("已将 {} 个项目移入 Windows 回收站", affected.len()),
        affected,
        skipped: vec![],
    })
}

#[tauri::command]
fn search_files(state: State<'_, AppState>, query: String) -> Result<Vec<FileEntry>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let c = db(&state)?;
    let mut indexed = HashSet::new();
    let like = format!("%{query}%");
    if let Ok(mut q)=c.prepare("SELECT relative_path FROM ocr_results WHERE lower(text) LIKE ?1 OR lower(relative_path) LIKE ?1 LIMIT 100"){if let Ok(rows)=q.query_map([like],|r|r.get::<_,String>(0)){for x in rows.filter_map(Result::ok){indexed.insert(x);}}}
    let mut out = vec![];
    for x in WalkDir::new(&state.root)
        .max_depth(16)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !reserved(e.path()))
        .filter_map(Result::ok)
    {
        if !x.file_type().is_file() || is_link(x.path()) {
            continue;
        }
        let r = relative(&state.root, x.path());
        if x.file_name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&query)
            || indexed.contains(&r)
        {
            out.push(entry(&state, &c, x.path(), &[])?);
            if out.len() >= 100 {
                break;
            }
        }
    }
    out.sort_by_key(|item| std::cmp::Reverse(item.modified_at));
    Ok(out)
}
#[tauri::command]
fn list_ocr_candidates(
    state: State<'_, AppState>,
    workspace_paths: Vec<String>,
) -> Result<Vec<FileEntry>, String> {
    let c = db(&state)?;
    let mut out = vec![];
    let mut seen = HashSet::new();
    for workspace in workspace_paths {
        let dir = safe(&state, &workspace)?;
        if !dir.is_dir() {
            continue;
        }
        for item in WalkDir::new(dir)
            .max_depth(16)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !item.file_type().is_file() || is_link(item.path()) {
                continue;
            }
            let extension = item
                .path()
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !matches!(
                extension.as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "tif" | "tiff" | "pdf"
            ) {
                continue;
            }
            let relative_path = relative(&state.root, item.path());
            if !seen.insert(relative_path.clone()) {
                continue;
            }
            let stored = c
                .query_row(
                    "SELECT fingerprint FROM ocr_results WHERE relative_path=?1",
                    [&relative_path],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if stored.as_deref() != Some(hash(item.path())?.as_str()) {
                out.push(entry(&state, &c, item.path(), &[])?);
            }
        }
    }
    Ok(out)
}
#[tauri::command]
fn create_favorite_category(
    state: State<'_, AppState>,
    name: String,
    color: String,
) -> Result<FavoriteCategory, String> {
    valid_name(&name)?;
    let c = db(&state)?;
    let pos = c
        .query_row(
            "SELECT COALESCE(MAX(position),-1)+1 FROM favorite_categories",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let x = FavoriteCategory {
        id: Uuid::new_v4().to_string(),
        name,
        color,
        position: pos,
        count: 0,
    };
    c.execute(
        "INSERT INTO favorite_categories VALUES(?1,?2,?3,?4)",
        params![x.id, x.name, x.color, x.position],
    )
    .map_err(|_| "该收藏分区已经存在".to_string())?;
    Ok(x)
}
#[tauri::command]
fn toggle_favorite(
    state: State<'_, AppState>,
    category_id: String,
    relative_path: String,
    display_name: String,
) -> Result<Vec<FavoriteLink>, String> {
    safe(&state, &relative_path)?;
    let c = db(&state)?;
    let id = c
        .query_row(
            "SELECT id FROM favorites WHERE category_id=?1 AND relative_path=?2",
            params![category_id, relative_path],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = id {
        c.execute("DELETE FROM favorites WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    } else {
        c.execute(
            "INSERT INTO favorites VALUES(?1,?2,?3,?4,?5)",
            params![
                Uuid::new_v4().to_string(),
                category_id,
                relative_path,
                display_name,
                ms(SystemTime::now())
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    favs(&state, &c)
}
#[tauri::command]
fn add_favorites_from_paths(
    state: State<'_, AppState>,
    category_id: String,
    source_paths: Vec<String>,
) -> Result<OperationResult, String> {
    let c = db(&state)?;
    let category_exists = c
        .query_row(
            "SELECT 1 FROM favorite_categories WHERE id=?1",
            [&category_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if !category_exists {
        return Err("收藏分区不存在".into());
    }
    drop(c);

    let root = simplify(state.root.canonicalize().map_err(|e| e.to_string())?);
    let import_dir = state.root.join("收藏导入");
    let mut affected = vec![];
    let mut skipped = vec![];
    for raw in source_paths {
        let raw_path = PathBuf::from(&raw);
        let source = if raw_path.is_absolute() {
            simplify(
                raw_path
                    .canonicalize()
                    .map_err(|_| format!("文件不存在：{raw}"))?,
            )
        } else {
            safe(&state, &raw)?
        };
        if !source.is_file() {
            skipped.push(raw);
            continue;
        }
        ensure_no_links(&source)?;
        let final_path = if source.starts_with(&root) {
            safe(&state, &source.to_string_lossy())?
        } else {
            fs::create_dir_all(&import_dir).map_err(|e| format!("创建收藏导入区失败：{e}"))?;
            match transfer_one(&source, &import_dir, "copy")? {
                Some(path) => path,
                None => import_dir.join(source.file_name().ok_or("文件名无效")?),
            }
        };
        let relative_path = relative(&state.root, &final_path);
        let display_name = final_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let c = db(&state)?;
        let inserted = c
            .execute(
                "INSERT OR IGNORE INTO favorites VALUES(?1,?2,?3,?4,?5)",
                params![
                    Uuid::new_v4().to_string(),
                    category_id,
                    relative_path,
                    display_name,
                    ms(SystemTime::now())
                ],
            )
            .map_err(|e| e.to_string())?;
        if inserted == 0 {
            skipped.push(relative_path);
        } else {
            affected.push(relative_path);
        }
    }
    let c = db(&state)?;
    log(
        &c,
        "favorite-drop",
        &format!("{} item(s)->{category_id}", affected.len()),
    );
    Ok(OperationResult {
        success: true,
        message: if skipped.is_empty() {
            format!("已收藏 {} 个文件", affected.len())
        } else {
            format!(
                "已收藏 {} 个文件，跳过 {} 个重复项或文件夹",
                affected.len(),
                skipped.len()
            )
        },
        affected,
        skipped,
    })
}
fn password_list(c: &Connection) -> Result<Vec<PasswordEntry>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id,title,url,username,notes,group_tag,created_at,updated_at
             FROM password_entries ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PasswordEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                username: row.get(3)?,
                notes: row.get(4)?,
                group_tag: row.get(5)?,
                created_at: row.get::<_, i64>(6)?.max(0) as u64,
                updated_at: row.get::<_, i64>(7)?.max(0) as u64,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}
fn valid_tag(t: &str) -> Result<String, String> {
    let tag = t.trim();
    if tag.is_empty() || tag.chars().count() > 24 {
        return Err("标签需为 1–24 个字符".into());
    }
    if tag.contains(',') || tag.contains('\n') {
        return Err("标签不能包含逗号或换行".into());
    }
    Ok(tag.to_string())
}
#[tauri::command]
fn save_password_entry(
    state: State<'_, AppState>,
    id: Option<String>,
    title: String,
    url: Option<String>,
    username: Option<String>,
    password: Option<String>,
    notes: Option<String>,
    group_tag: Option<String>,
) -> Result<Vec<PasswordEntry>, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("标题需为 1–120 个字符".into());
    }
    let now = ms(SystemTime::now());
    let c = db(&state)?;
    match id.filter(|v| !v.trim().is_empty()) {
        Some(id) => {
            let exists = c
                .query_row(
                    "SELECT password_enc FROM password_entries WHERE id=?1",
                    [&id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some(existing_enc) = exists else {
                return Err("该密码条目不存在".into());
            };
            let enc = match password.filter(|v| !v.is_empty()) {
                Some(plain) => encrypt_password(&vault_key()?, &plain)?,
                None => existing_enc,
            };
            c.execute(
                "UPDATE password_entries SET title=?1,url=?2,username=?3,password_enc=?4,notes=?5,group_tag=?6,updated_at=?7 WHERE id=?8",
                params![
                    title.trim(),
                    url.unwrap_or_default().trim(),
                    username.unwrap_or_default(),
                    enc,
                    notes.unwrap_or_default(),
                    group_tag.unwrap_or_default().trim(),
                    now,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            let plain = password.unwrap_or_default();
            let enc = if plain.is_empty() {
                String::new()
            } else {
                encrypt_password(&vault_key()?, &plain)?
            };
            c.execute(
                "INSERT INTO password_entries VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    Uuid::new_v4().to_string(),
                    title.trim(),
                    url.unwrap_or_default().trim(),
                    username.unwrap_or_default(),
                    enc,
                    notes.unwrap_or_default(),
                    group_tag.unwrap_or_default().trim(),
                    now,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    log(&c, "password-save", title);
    password_list(&c)
}
#[tauri::command]
fn delete_password_entry(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<PasswordEntry>, String> {
    let c = db(&state)?;
    c.execute("DELETE FROM password_entries WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    log(&c, "password-delete", &id);
    password_list(&c)
}
#[tauri::command]
fn reveal_password(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let c = db(&state)?;
    let enc = c
        .query_row(
            "SELECT password_enc FROM password_entries WHERE id=?1",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(enc) = enc else {
        return Err("该密码条目不存在".into());
    };
    if enc.is_empty() {
        return Ok(String::new());
    }
    decrypt_password(&vault_key()?, &enc)
}
#[tauri::command]
fn add_file_tags(
    state: State<'_, AppState>,
    relative_paths: Vec<String>,
    tag: String,
) -> Result<OperationResult, String> {
    let tag = valid_tag(&tag)?;
    let c = db(&state)?;
    let mut affected = vec![];
    for p in relative_paths {
        let path = safe(&state, &p)?;
        let r = relative(&state.root, &path);
        c.execute(
            "INSERT OR IGNORE INTO file_tags(relative_path,tag) VALUES(?1,?2)",
            params![r, tag],
        )
        .map_err(|e| e.to_string())?;
        affected.push(r);
    }
    log(&c, "tag-add", &format!("{tag} -> {} item(s)", affected.len()));
    Ok(OperationResult {
        success: true,
        message: format!("已为 {} 个项目添加标签“{tag}”", affected.len()),
        affected,
        skipped: vec![],
    })
}
#[tauri::command]
fn remove_file_tags(
    state: State<'_, AppState>,
    relative_paths: Vec<String>,
    tag: String,
) -> Result<OperationResult, String> {
    let tag = valid_tag(&tag)?;
    let c = db(&state)?;
    let mut affected = vec![];
    for p in relative_paths {
        let path = safe(&state, &p)?;
        let r = relative(&state.root, &path);
        c.execute(
            "DELETE FROM file_tags WHERE relative_path=?1 AND tag=?2",
            params![r, tag],
        )
        .map_err(|e| e.to_string())?;
        affected.push(r);
    }
    log(&c, "tag-remove", &format!("{tag} <- {} item(s)", affected.len()));
    Ok(OperationResult {
        success: true,
        message: format!("已从 {} 个项目移除标签“{tag}”", affected.len()),
        affected,
        skipped: vec![],
    })
}
#[tauri::command]
fn save_task(state: State<'_, AppState>, task: TaskInput) -> Result<PlanTask, String> {
    if task.title.trim().is_empty() {
        return Err("待办标题不能为空".into());
    }
    let now = ms(SystemTime::now());
    let done = task.completed.unwrap_or(false);
    let x = PlanTask {
        id: task.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        title: task.title.trim().into(),
        plan_scope: match task.plan_scope.as_deref() {
            Some("weekly") => "weekly".into(),
            _ => "daily".into(),
        },
        due_date: task
            .due_date
            .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string()),
        remind_at: task.remind_at,
        priority: task.priority.unwrap_or_else(|| "medium".into()),
        repeat_rule: task.repeat_rule.unwrap_or_else(|| "none".into()),
        note: task.note.unwrap_or_default(),
        completed: done,
        completed_at: if done {
            task.completed_at.or(Some(now))
        } else {
            None
        },
        created_at: task.created_at.unwrap_or(now),
    };
    let c = db(&state)?;
    c.execute("INSERT INTO tasks(id,title,due_date,remind_at,priority,repeat_rule,note,completed,completed_at,created_at,plan_scope) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET title=excluded.title,due_date=excluded.due_date,remind_at=excluded.remind_at,priority=excluded.priority,repeat_rule=excluded.repeat_rule,note=excluded.note,completed=excluded.completed,completed_at=excluded.completed_at,plan_scope=excluded.plan_scope",params![x.id,x.title,x.due_date,x.remind_at,x.priority,x.repeat_rule,x.note,x.completed,x.completed_at,x.created_at,x.plan_scope]).map_err(|e|e.to_string())?;
    Ok(x)
}
#[tauri::command]
fn delete_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    db(&state)?
        .execute("DELETE FROM tasks WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: AppSettings,
    model_api_key: Option<String>,
) -> Result<AppSettings, String> {
    if let Some(secret) = model_api_key.filter(|v| !v.trim().is_empty()) {
        keyring::Entry::new("BEN Archive Assistant", "model-api-key")
            .map_err(|e| e.to_string())?
            .set_password(secret.trim())
            .map_err(|e| format!("保存 API 密钥失败：{e}"))?;
        settings.model_key_saved = true
    }
    settings.wps_sync_dir = match settings.wps_sync_dir.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => {
            let dir = wps_sync::validate_dir(v)?;
            Some(dir.to_string_lossy().to_string())
        }
        _ => {
            settings.wps_sync_workspaces.clear();
            None
        }
    };
    if settings.start_on_login {
        app.autolaunch().enable().map_err(|e| e.to_string())?
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?
    }
    let c = db(&state)?;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO settings VALUES('app',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json],
    )
    .map_err(|e| e.to_string())?;
    Ok(settings)
}
#[tauri::command]
fn save_ocr_result(state: State<'_, AppState>, result: OcrResult) -> Result<(), String> {
    let p = safe(&state, &result.relative_path)?;
    let fingerprint = result.fingerprint.unwrap_or(hash(&p)?);
    let languages = serde_json::to_string(&result.languages).unwrap_or_else(|_| "[]".into());
    let mut c = db(&state)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO ocr_results VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(relative_path) DO UPDATE SET fingerprint=excluded.fingerprint,text=excluded.text,confidence=excluded.confidence,pages=excluded.pages,languages=excluded.languages,updated_at=excluded.updated_at",params![result.relative_path,fingerprint,result.text,result.confidence,result.pages,languages,ms(SystemTime::now())]).map_err(|e|e.to_string())?;
    let _ = tx.execute(
        "DELETE FROM ocr_search WHERE relative_path=?1",
        [&result.relative_path],
    );
    tx.execute(
        "INSERT INTO ocr_search VALUES(?1,?2)",
        params![result.relative_path, result.text],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
fn get_cached_ocr(
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<Option<OcrResult>, String> {
    let fingerprint = hash(&safe(&state, &relative_path)?)?;
    let c = db(&state)?;
    let found=c.query_row("SELECT fingerprint,text,confidence,pages,languages FROM ocr_results WHERE relative_path=?1",[&relative_path],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,f64>(2)?,r.get::<_,usize>(3)?,r.get::<_,String>(4)?))).optional().map_err(|e|e.to_string())?;
    Ok(
        found.and_then(|(stored, text, confidence, pages, languages)| {
            if stored == fingerprint {
                Some(OcrResult {
                    relative_path,
                    text,
                    confidence,
                    pages,
                    languages: serde_json::from_str(&languages).unwrap_or_default(),
                    cached: true,
                    fingerprint: Some(fingerprint),
                })
            } else {
                None
            }
        }),
    )
}
#[tauri::command]
fn read_file_bytes(state: State<'_, AppState>, relative_path: String) -> Result<Vec<u8>, String> {
    let p = safe(&state, &relative_path)?;
    if !p.is_file() {
        return Err("目标不是文件".into());
    }
    if p.metadata().map_err(|e| e.to_string())?.len() > 250 * 1024 * 1024 {
        return Err("文件超过 250 MB，请先压缩或拆分后识别".into());
    }
    fs::read(p).map_err(|e| e.to_string())
}
#[tauri::command]
fn get_file_hash(state: State<'_, AppState>, relative_path: String) -> Result<String, String> {
    hash(&safe(&state, &relative_path)?)
}
#[tauri::command]
fn validate_wps_dir(path: String) -> Result<String, String> {
    wps_sync::validate_dir(&path).map(|p| p.to_string_lossy().to_string())
}
#[tauri::command]
fn wps_sync_now(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<OperationResult, String> {
    let c = db(&state)?;
    let settings = load_settings(&c);
    drop(c);
    let dir = settings
        .wps_sync_dir
        .ok_or("请先在设置中选择 WPS 同步目录")?;
    let enabled = &settings.wps_sync_workspaces;
    if enabled.is_empty() {
        return Err("请先在设置中开启需要同步的工作区".into());
    }
    let targets = match workspace {
        Some(name) => {
            if !enabled.iter().any(|w| w == &name) {
                return Err("该工作区未开启云同步".into());
            }
            vec![name]
        }
        None => enabled.clone(),
    };
    let wps = PathBuf::from(&dir);
    let mut outcome = wps_sync::SyncOutcome::default();
    for name in &targets {
        let out = wps_sync::sync_workspace(&state.root, &wps, name)?;
        outcome.copied.extend(out.copied);
        outcome.skipped.extend(out.skipped);
        outcome.failed.extend(out.failed);
    }
    let message = if outcome.failed.is_empty() {
        format!(
            "已同步 {} 个文件，{} 个内容一致无需更新",
            outcome.copied.len(),
            outcome.skipped.len()
        )
    } else {
        format!(
            "已同步 {} 个文件，{} 个跳过，{} 个失败：{}",
            outcome.copied.len(),
            outcome.skipped.len(),
            outcome.failed.len(),
            outcome.failed.join("；")
        )
    };
    let c = db(&state)?;
    log(
        &c,
        "wps-sync",
        &format!(
            "手动同步（{}）：更新 {}，跳过 {}，失败 {}",
            if targets.len() == 1 {
                targets[0].as_str()
            } else {
                "全部工作区"
            },
            outcome.copied.len(),
            outcome.skipped.len(),
            outcome.failed.len()
        ),
    );
    Ok(OperationResult {
        success: true,
        message,
        affected: outcome.copied,
        skipped: outcome.skipped,
    })
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示归档助手", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut b = TrayIconBuilder::new()
        .tooltip("归档助手")
        .menu(&menu)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone())
    }
    b.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            fs::create_dir_all(ROOT)?;
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            let c = Connection::open(data.join("archive-assistant.db"))?;
            init_db(&c)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut signature = 0u64;
                loop {
                    let next = WalkDir::new(ROOT)
                        .max_depth(16)
                        .into_iter()
                        .filter_map(Result::ok)
                        .filter(|e| !reserved(e.path()))
                        .filter_map(|e| e.metadata().ok())
                        .filter_map(|m| m.modified().ok())
                        .map(ms)
                        .fold(0, u64::max);
                    if signature != 0 && signature != next {
                        let _ = handle.emit("filesystem-changed", ());
                    }
                    signature = next;
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            });
            app.manage(AppState {
                root: PathBuf::from(ROOT),
                db: Mutex::new(c),
            });
            setup_tray(app.handle())?;
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    w.hide()?
                }
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            list_directory,
            create_workspace,
            delete_workspace,
            create_folder,
            rename_entry,
            transfer_entries,
            import_files,
            delete_entries,
            search_files,
            list_ocr_candidates,
            create_favorite_category,
            toggle_favorite,
            add_favorites_from_paths,
            save_task,
            delete_task,
            save_settings,
            save_ocr_result,
            get_cached_ocr,
            read_file_bytes,
            get_file_hash,
            open_file,
            open_file_with,
            reveal_in_explorer,
            save_password_entry,
            delete_password_entry,
            reveal_password,
            add_file_tags,
            remove_file_tags,
            validate_wps_dir,
            wps_sync_now
        ])
        .run(tauri::generate_context!())
        .expect("归档助手启动失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_names_are_validated() {
        assert!(valid_name("技术工作").is_ok());
        assert!(valid_name("季度报告.docx").is_ok());
        for invalid in ["", "CON", "a/b", "a*", "结尾.", "结尾 "] {
            assert!(valid_name(invalid).is_err(), "{invalid} 应被拒绝");
        }
    }

    #[test]
    fn vault_encryption_roundtrips() {
        use rand::RngCore;
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let blob = encrypt_password(&key, "P@ss中文123").unwrap();
        assert_ne!(blob, "P@ss中文123");
        assert_eq!(decrypt_password(&key, &blob).unwrap(), "P@ss中文123");
        let mut other = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut other);
        assert!(decrypt_password(&other, &blob).is_err());
        assert!(valid_tag("").is_err());
        assert!(valid_tag("  工作  ").map(|t| t == "工作").unwrap_or(false));
    }

    #[test]
    fn database_bootstrap_is_idempotent() {
        let connection = Connection::open_in_memory().expect("创建内存数据库");
        init_db(&connection).expect("初始化数据库");
        init_db(&connection).expect("重复初始化数据库");
        let categories = cats(&connection).expect("读取收藏分区");
        assert_eq!(categories.len(), 4);
        assert!(plans(&connection).expect("读取计划").is_empty());
        connection
            .execute(
                "INSERT INTO tasks(id,title,due_date,remind_at,priority,repeat_rule,note,completed,completed_at,created_at) VALUES('legacy','旧计划','2026-01-01',NULL,'medium','none','',0,NULL,1)",
                [],
            )
            .expect("写入旧版计划");
        assert_eq!(
            plans(&connection).expect("读取旧版计划")[0].plan_scope,
            "daily"
        );
    }

    #[test]
    fn safe_path_accepts_only_files_inside_root() {
        let root = tempfile::tempdir().expect("创建临时根目录");
        let workspace = root.path().join("技术工作");
        fs::create_dir(&workspace).expect("创建工作区");
        let file = workspace.join("报告.docx");
        fs::write(&file, "content").expect("创建测试文件");
        let state = AppState {
            root: root.path().to_path_buf(),
            db: Mutex::new(Connection::open_in_memory().expect("创建数据库")),
        };
        assert_eq!(
            safe(&state, "技术工作\\报告.docx").expect("接受相对路径"),
            simplify(file.canonicalize().expect("规范化文件"))
        );
        assert_eq!(
            safe(&state, &file.to_string_lossy()).expect("接受根目录内绝对路径"),
            simplify(file.canonicalize().expect("规范化文件"))
        );
        let simplified = safe(&state, "技术工作\\报告.docx").expect("接受相对路径");
        assert!(
            !simplified.to_string_lossy().starts_with(r"\\?\"),
            "返回路径不应包含 verbatim 前缀"
        );
        let outside = tempfile::NamedTempFile::new().expect("创建外部文件");
        assert!(safe(&state, &outside.path().to_string_lossy()).is_err());
    }

    #[test]
    fn identical_file_is_not_saved_twice() {
        let temp = tempfile::tempdir().expect("创建临时测试目录");
        let source_dir = temp.path().join("source");
        let target_dir = temp.path().join("target");
        fs::create_dir_all(&source_dir).expect("创建来源目录");
        fs::create_dir_all(&target_dir).expect("创建目标目录");
        let source = source_dir.join("报告.txt");
        fs::write(&source, "same-content").expect("写入来源文件");
        fs::write(target_dir.join("报告.txt"), "same-content").expect("写入目标文件");

        let result = transfer_one(&source, &target_dir, "copy").expect("比较同名文件");
        assert!(result.is_none());
        assert!(source.exists());
        assert_eq!(fs::read_dir(&target_dir).expect("读取目标目录").count(), 1);
    }

    #[test]
    fn version_name_preserves_extension() {
        let name = dated(
            Path::new("正式讲稿.docx"),
            "最新版",
            UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
        );
        assert!(name.starts_with("正式讲稿_最新版_"));
        assert!(name.ends_with(".docx"));
    }
}
