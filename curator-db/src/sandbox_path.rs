//! NTFS-hardened sandboxed path type for plugin storage.
//!
//! Every path a plugin touches must resolve strictly inside
//! `<data_dir>/plugin_data/<plugin_id>/`. `SandboxedPath` centralizes the
//! boundary check that was previously duplicated ad-hoc per command handler:
//!
//! * plugin-id validation (bare safe name, no separators/`..`/leading dot),
//! * lexical normalization (`/` `.` `..` components),
//! * NTFS exploit rejection (Alternate Data Streams via `:`, trailing
//!   dots/spaces on any component),
//! * canonical-root containment (canonicalizes the deepest existing ancestor
//!   so symlinked roots and intermediate dirs cannot be used to escape).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    InvalidPluginId,
    IllegalName,
    PathEscapesSandbox,
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxError::InvalidPluginId => write!(f, "invalid plugin id"),
            SandboxError::IllegalName => {
                write!(f, "illegal name component (separator, dot/space suffix, or NTFS stream)")
            }
            SandboxError::PathEscapesSandbox => write!(f, "path escapes plugin data directory"),
        }
    }
}

impl std::error::Error for SandboxError {}

/// A safe bare file/dir name: no separators, no leading dot, no `..`.
pub fn is_safe_name(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.starts_with('.')
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// True when `id` is a valid plugin-id root directory name.
pub fn is_safe_plugin_id(id: &str) -> bool {
    is_safe_name(id)
}

/// Lexically normalize a relative path, resolving `.` and `..` segments.
/// Any residual `..`, root, drive/UNC component, or a leading `.curator`
/// component (which refers to the workspace root, outside the sandbox) makes
/// the path rejectable.
fn normalize_lexically(relative: &str) -> Result<PathBuf, SandboxError> {
    let path = Path::new(relative);
    if path.is_absolute() || path.has_root() {
        return Err(SandboxError::PathEscapesSandbox);
    }
    let mut out = PathBuf::new();
    let mut first = true;
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err(SandboxError::PathEscapesSandbox);
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(SandboxError::PathEscapesSandbox);
            }
            std::path::Component::Normal(name) => {
                let name_str = name.to_string_lossy();
                if (first && name_str == ".curator")
                    || name_str.contains(':')
                    || name_str.ends_with('.')
                    || name_str.ends_with(' ')
                {
                    return Err(SandboxError::IllegalName);
                }
                first = false;
                out.push(name);
            }
        }
    }
    Ok(out)
}

/// Canonicalize the deepest existing ancestor of `target`, then re-append the
/// non-existing tail. This defends against symlinked roots and intermediate
/// directories without requiring the final file to exist yet.
fn canonicalize_ancestor(target: &Path) -> PathBuf {
    let mut existing = target.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if existing.as_os_str().is_empty() || existing.exists() {
            break;
        }
        match existing.parent() {
            Some(parent) if parent != existing => {
                if let Some(name) = existing.file_name() {
                    tail.push(name.to_os_string());
                }
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let canonical = existing.canonicalize().unwrap_or(existing);
    let mut out = canonical;
    for comp in tail.into_iter().rev() {
        out.push(comp);
    }
    out
}

/// If `relative` uses the workspace-relative convention
/// (`.curator/plugin_data/<plugin_id>/…`), return the plugin-relative tail
/// (e.g. `pages/…`). Returns `None` for plain plugin-relative paths. Any other
/// leading `.curator` path (or one pointing into a *different* plugin's data
/// dir) is rejected: it would escape this plugin's sandbox.
fn plugin_relative_tail(plugin_id: &str, relative: &str) -> Result<Option<String>, SandboxError> {
    let path = Path::new(relative);
    let Some(std::path::Component::Normal(first)) = path.components().next() else {
        return Ok(None);
    };
    if first != ".curator" {
        return Ok(None);
    }
    let Ok(rest) = path.strip_prefix(".curator") else {
        return Err(SandboxError::PathEscapesSandbox);
    };
    let mut comps = rest.components();
    let prefix_ok = match (comps.next(), comps.next()) {
        (Some(std::path::Component::Normal(a)), Some(std::path::Component::Normal(b)))
            if a == "plugin_data" && b == plugin_id =>
        {
            true
        }
        _ => false,
    };
    if !prefix_ok {
        return Err(SandboxError::PathEscapesSandbox);
    }
    let tail = comps
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Ok(Some(tail))
}

/// Reject NTFS tricks and trailing dot/space in every component of an absolute
/// path. Containment is enforced separately by the canonical-root check.
fn reject_unsafe_components(path: &str) -> Result<(), SandboxError> {
    for comp in Path::new(path).components() {
        if let std::path::Component::Normal(name) = comp {
            let s = name.to_string_lossy();
            if s.contains(':') || s.ends_with('.') || s.ends_with(' ') {
                return Err(SandboxError::IllegalName);
            }
        }
    }
    Ok(())
}

/// A path confined to a plugin's sandboxed data root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxedPath {
    absolute_path: PathBuf,
    plugin_id: String,
}

impl SandboxedPath {
    /// Resolve `relative` inside `<data_dir>/plugin_data/<plugin_id>/`.
    ///
    /// Three forms are accepted, all resolving to the same root:
    ///   * plugin-relative — `pages/x.gif`
    ///   * workspace-relative into this plugin's own data dir —
    ///     `.curator/plugin_data/<plugin_id>/pages/x.gif`
    ///   * absolute — plugins legitimately re-probe absolute paths returned by
    ///     downloads/transcodes; allowed only when the canonical path lies
    ///     inside the plugin's own data root.
    ///
    /// An empty `relative` resolves to the plugin root itself. Any path that
    /// escapes the root (absolute input outside the root, `..`,
    /// `.curator/…` pointing elsewhere, NTFS tricks) is rejected.
    pub fn resolve(data_dir: &Path, plugin_id: &str, relative: &str) -> Result<Self, SandboxError> {
        if !is_safe_plugin_id(plugin_id) {
            return Err(SandboxError::InvalidPluginId);
        }
        let root = data_dir.join("plugin_data").join(plugin_id);
        let target = if relative.is_empty() {
            root.clone()
        } else if Path::new(relative).is_absolute() {
            reject_unsafe_components(relative)?;
            PathBuf::from(relative)
        } else {
            let relative = match plugin_relative_tail(plugin_id, relative)? {
                Some(tail) => tail,
                None => relative.to_string(),
            };
            let normalized = normalize_lexically(&relative)?;
            root.join(normalized)
        };

        let canonical_root = canonicalize_ancestor(&root);
        let canonical_target = canonicalize_ancestor(&target);
        if !canonical_target.starts_with(&canonical_root) {
            return Err(SandboxError::PathEscapesSandbox);
        }

        Ok(Self {
            absolute_path: target,
            plugin_id: plugin_id.to_string(),
        })
    }

    /// The absolute, sandbox-confined filesystem path.
    pub fn absolute(&self) -> &Path {
        &self.absolute_path
    }

    /// The owning plugin id.
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("curator_sandbox_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn empty_relative_resolves_to_root() {
        let data_dir = temp_data_dir();
        let p = SandboxedPath::resolve(&data_dir, "gif-maker", "").unwrap();
        assert_eq!(p.absolute(), &data_dir.join("plugin_data").join("gif-maker"));
    }

    #[test]
    fn nested_path_is_allowed() {
        let data_dir = temp_data_dir();
        let p = SandboxedPath::resolve(&data_dir, "gif-maker", "frames/out.gif").unwrap();
        assert_eq!(
            p.absolute(),
            &data_dir.join("plugin_data").join("gif-maker").join("frames/out.gif")
        );
    }

    #[test]
    fn rejects_parent_escape() {
        let data_dir = temp_data_dir();
        assert_eq!(
            SandboxedPath::resolve(&data_dir, "gif-maker", ".."),
            Err(SandboxError::PathEscapesSandbox)
        );
        assert_eq!(
            SandboxedPath::resolve(&data_dir, "gif-maker", "../other/file.txt"),
            Err(SandboxError::PathEscapesSandbox)
        );
    }

    #[test]
    fn rejects_absolute_and_dot_curator_paths() {
        let data_dir = temp_data_dir();
        assert!(SandboxedPath::resolve(&data_dir, "gif-maker", "K:\\outside\\x.png").is_err());
        assert!(SandboxedPath::resolve(&data_dir, "gif-maker", ".curator/cache").is_err());
        assert!(SandboxedPath::resolve(&data_dir, "gif-maker", "/abs").is_err());
    }

    #[test]
    fn accepts_absolute_paths_inside_own_plugin_dir() {
        let data_dir = temp_data_dir();
        let inside = data_dir
            .join("plugin_data")
            .join("dynasty-scans")
            .join("covers")
            .join("foo.webp");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        let p = SandboxedPath::resolve(&data_dir, "dynasty-scans", &inside.to_string_lossy())
            .unwrap();
        assert_eq!(p.absolute(), &inside);
        // The path is accepted even before the file exists.
        let not_created = data_dir
            .join("plugin_data")
            .join("dynasty-scans")
            .join("pages/x.gif");
        let p2 = SandboxedPath::resolve(&data_dir, "dynasty-scans", &not_created.to_string_lossy())
            .unwrap();
        assert_eq!(p2.absolute(), &not_created);
    }

    #[test]
    fn rejects_absolute_paths_outside_own_plugin_dir() {
        let data_dir = temp_data_dir();
        let outside = temp_data_dir();
        assert!(SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            &outside.to_string_lossy()
        )
        .is_err());
        // A sibling plugin's dir is still outside this plugin's root.
        let sibling = data_dir.join("plugin_data").join("gif-maker").join("x.gif");
        std::fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        assert!(SandboxedPath::resolve(&data_dir, "dynasty-scans", &sibling.to_string_lossy())
            .is_err());
    }

    #[test]
    fn absolute_form_still_blocks_ntfs_tricks() {
        let data_dir = temp_data_dir();
        let ads = data_dir
            .join("plugin_data")
            .join("dynasty-scans")
            .join("file.txt:hidden");
        assert!(SandboxedPath::resolve(&data_dir, "dynasty-scans", &ads.to_string_lossy())
            .is_err());
        let dot = data_dir
            .join("plugin_data")
            .join("dynasty-scans")
            .join("file.txt.");
        assert!(SandboxedPath::resolve(&data_dir, "dynasty-scans", &dot.to_string_lossy())
            .is_err());
    }

    #[test]
    fn accepts_workspace_relative_form_into_own_plugin_dir() {
        let data_dir = temp_data_dir();
        let p = SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/plugin_data/dynasty-scans/pages/series/chapter/page.webp",
        )
        .unwrap();
        assert_eq!(
            p.absolute(),
            &data_dir
                .join("plugin_data")
                .join("dynasty-scans")
                .join("pages/series/chapter/page.webp")
        );
        // Exactly the plugin root is also fine.
        let root = SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/plugin_data/dynasty-scans",
        )
        .unwrap();
        assert_eq!(
            root.absolute(),
            &data_dir.join("plugin_data").join("dynasty-scans")
        );
    }

    #[test]
    fn rejects_workspace_relative_form_into_other_plugin_dir() {
        let data_dir = temp_data_dir();
        assert!(SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/plugin_data/gif-maker/pages/x.gif"
        )
        .is_err());
        assert!(SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/temp_gif/x.gif"
        )
        .is_err());
    }

    #[test]
    fn workspace_relative_form_still_blocks_ntfs_and_escape_tricks() {
        let data_dir = temp_data_dir();
        assert!(SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/plugin_data/dynasty-scans/pages/..\\..\\..\\escape.gif"
        )
        .is_err());
        assert!(SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/plugin_data/dynasty-scans/file.txt:hidden"
        )
        .is_err());
        assert!(SandboxedPath::resolve(
            &data_dir,
            "dynasty-scans",
            ".curator/plugin_data/dynasty-scans/file.txt..."
        )
        .is_err());
    }

    #[test]
    fn rejects_ntfs_tricks() {
        let data_dir = temp_data_dir();
        assert!(SandboxedPath::resolve(&data_dir, "gif-maker", "file.txt:hidden").is_err());
        assert!(SandboxedPath::resolve(&data_dir, "gif-maker", "file.txt...").is_err());
        assert!(SandboxedPath::resolve(&data_dir, "gif-maker", "dir/name ").is_err());
    }

    #[test]
    fn rejects_bad_plugin_id() {
        let data_dir = temp_data_dir();
        assert_eq!(
            SandboxedPath::resolve(&data_dir, "../evil", ""),
            Err(SandboxError::InvalidPluginId)
        );
        assert_eq!(
            SandboxedPath::resolve(&data_dir, "", ""),
            Err(SandboxError::InvalidPluginId)
        );
    }

    #[test]
    fn allows_symlink_resolution_through_root() {
        let data_dir = temp_data_dir();
        let real = data_dir.join("real_plugin");
        std::fs::create_dir_all(&real).unwrap();
        let link = data_dir.join("plugin_data").join("link");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&real)
                .status();
        }
        if link.exists() {
            let p = SandboxedPath::resolve(&data_dir, "link", "x.png").unwrap();
            // The plugin-visible path stays inside its named root; canonical
            // resolution follows the junction into `real`, which must also
            // remain within the root's canonical location.
            assert!(p.absolute().starts_with(&link));
        }
    }
}
