// WPS 云盘同步：把归档文件复制进 WPS 客户端的本地同步目录，
// 由 WPS 客户端负责上传云端。本模块不产生任何网络行为。
use crate::{dated, hash, simplify, unique};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

#[derive(Default, Clone)]
pub struct SyncOutcome {
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

pub fn validate_dir(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("WPS 同步目录必须是绝对路径".into());
    }
    if !p.is_dir() {
        return Err("WPS 同步目录不存在或不是文件夹".into());
    }
    Ok(simplify(p.canonicalize().map_err(|e| e.to_string())?))
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
}

/// 把 root 下的一个文件（或目录）镜像到 wps_dir 下相同的相对位置。
/// 返回 Ok(true) 表示产生了复制，Ok(false) 表示内容一致无需复制。
pub fn sync_file(root: &Path, wps_dir: &Path, relative_path: &str) -> Result<bool, String> {
    let source = root.join(relative_path);
    if is_link(&source) {
        return Err("为保证安全，不支持符号链接及目录连接".into());
    }
    let target = wps_dir.join(relative_path);
    if source.is_dir() {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        return Ok(false);
    }
    if !source.is_file() {
        return Err("来源不是普通文件".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if target.exists() {
        if target.is_dir() {
            return Err("同步目录中同名位置已被文件夹占用".into());
        }
        if hash(&source)? == hash(&target)? {
            return Ok(false);
        }
        // 旧内容保留为历史版，最新内容继续占用原文件名，云端表现为文件更新
        let tm = target
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        let backup = unique(
            target.parent().ok_or("无法确定同步目标位置")?,
            &dated(&target, "历史版", tm),
        );
        fs::rename(&target, &backup).map_err(|e| e.to_string())?;
    }
    fs::copy(&source, &target).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 对一个工作区做全量对账：镜像所有文件与子目录结构。
pub fn sync_workspace(root: &Path, wps_dir: &Path, workspace: &str) -> Result<SyncOutcome, String> {
    let base = root.join(workspace);
    if !base.is_dir() {
        return Err("工作区不存在".into());
    }
    if is_link(&base) {
        return Err("为保证安全，不支持符号链接及目录连接".into());
    }
    let mut out = SyncOutcome::default();
    for x in WalkDir::new(&base).min_depth(1).into_iter().filter_map(Result::ok) {
        let rel = x
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('/', "\\");
        match sync_file(root, wps_dir, &rel) {
            Ok(true) => out.copied.push(rel),
            Ok(false) => out.skipped.push(rel),
            Err(e) => {
                if out.failed.len() < 20 {
                    out.failed.push(format!("{rel}：{e}"));
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wps_sync_mirrors_relative_paths_and_versions_changes() {
        let root = tempfile::tempdir().expect("创建临时根目录");
        let wps = tempfile::tempdir().expect("创建临时同步目录");
        let source_dir = root.path().join("技术工作\\子目录");
        fs::create_dir_all(&source_dir).expect("创建来源目录");
        let source = source_dir.join("报告.txt");
        fs::write(&source, "第一版").expect("写入来源文件");

        assert!(sync_file(root.path(), wps.path(), "技术工作\\子目录\\报告.txt")
            .expect("首次同步")
            , "首次同步应产生复制");
        let target = wps.path().join("技术工作\\子目录\\报告.txt");
        assert_eq!(fs::read_to_string(&target).expect("读取同步文件"), "第一版");

        assert!(
            !sync_file(root.path(), wps.path(), "技术工作\\子目录\\报告.txt")
                .expect("重复同步"),
            "内容一致时应跳过"
        );

        fs::write(&source, "第二版").expect("更新来源文件");
        assert!(sync_file(root.path(), wps.path(), "技术工作\\子目录\\报告.txt")
            .expect("更新同步"));
        assert_eq!(fs::read_to_string(&target).expect("读取最新内容"), "第二版");
        let dir = wps.path().join("技术工作\\子目录");
        let versions = fs::read_dir(&dir).expect("读取同步目录").count();
        assert_eq!(versions, 2, "旧内容应保留为历史版");
        assert!(fs::read_dir(&dir)
            .expect("读取同步目录")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains("历史版")));
    }

    #[test]
    fn wps_sync_rejects_invalid_dir() {
        assert!(validate_dir("相对路径").is_err());
        assert!(validate_dir("D:\\不存在的目录\\归档助手测试").is_err());
    }

    #[test]
    fn wps_sync_workspace_walks_nested_tree() {
        let root = tempfile::tempdir().expect("创建临时根目录");
        let wps = tempfile::tempdir().expect("创建临时同步目录");
        let nested = root.path().join("数据工作\\2026\\一季度");
        fs::create_dir_all(&nested).expect("创建嵌套目录");
        fs::write(nested.join("汇总.xlsx"), "data").expect("写入文件");
        fs::write(root.path().join("数据工作\\说明.txt"), "readme").expect("写入文件");

        let out = sync_workspace(root.path(), wps.path(), "数据工作").expect("全量同步");
        assert_eq!(out.copied.len(), 2, "两个文件都应复制");
        assert!(out.failed.is_empty());
        assert!(wps.path().join("数据工作\\2026\\一季度\\汇总.xlsx").is_file());
        assert!(wps.path().join("数据工作\\说明.txt").is_file());

        let again = sync_workspace(root.path(), wps.path(), "数据工作").expect("重复同步");
        assert!(again.copied.is_empty(), "重复同步应全部跳过");
        assert_eq!(again.skipped.len(), 4, "两个文件和两个目录都应跳过");
    }
}
