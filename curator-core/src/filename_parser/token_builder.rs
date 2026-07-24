use super::types::{ParsedMetadata, TokenBlock};
use chrono::{DateTime, Utc};
use regex::Regex;
use std::sync::OnceLock;

/// Test Regex pattern with named capture groups
pub fn test_regex(filename: &str, pattern: &str) -> Option<ParsedMetadata> {
    // Cache compiled NFA regexes for reuse across batch calls
    static NFA_CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, Regex>>> =
        OnceLock::new();
    let cache = NFA_CACHE.get_or_init(|| {
        std::sync::Mutex::new(std::collections::HashMap::new())
    });
    let re = {
        let mut guard = cache.lock().unwrap();
        guard
            .entry(pattern.to_string())
            .or_insert_with(|| Regex::new(pattern).unwrap_or_else(|_| Regex::new("a^").unwrap()))
            .clone()
    };

    if let Some(caps) = re.captures(filename) {
        let mut artist = None;
        let mut pixiv_id = None;
        let mut twitter_id = None;
        let mut timestamp_4chan = None;
        let mut datetime_iso = None;
        let mut extracted_tags = Vec::new();

        // Extract known named groups
        if let Some(m) = caps.name("artist") {
            let a = m.as_str().to_string();
            extracted_tags.push(format!("artist:{}", a));
            artist = Some(a);
        }
        if let Some(m) = caps.name("pixiv_id") {
            let pid = m.as_str().to_string();
            extracted_tags.push(format!("pixiv:{}", pid));
            pixiv_id = Some(pid);
        }
        if let Some(m) = caps.name("twitter_id") {
            let tid = m.as_str().to_string();
            extracted_tags.push(format!("twitter:{}", tid));
            twitter_id = Some(tid);
        }
        if let Some(m) = caps.name("timestamp") {
            let ts = m.as_str().to_string();
            timestamp_4chan = Some(ts.clone());
            if let Ok(sec) = ts.parse::<i64>() {
                if let Some(dt) = DateTime::<Utc>::from_timestamp(sec, 0) {
                    datetime_iso = Some(dt.format("%Y-%m-%d %H:%M:%S UTC").to_string());
                    extracted_tags.push(format!("date:{}", dt.format("%Y-%m-%d")));
                }
            }
        }
        if let Some(m) = caps.name("tag") {
            extracted_tags.push(m.as_str().to_string());
        }

        // Extract any other named groups (custom labels from token builder)
        // Skip groups prefixed with _skip_ (disabled blocks)
        let known_groups = ["artist", "pixiv_id", "twitter_id", "timestamp", "tag"];
        for name in re.capture_names().flatten() {
            if known_groups.contains(&name) || name.starts_with("_skip_") {
                continue;
            }
            if let Some(m) = caps.name(name) {
                let val = m.as_str().to_string();
                if !val.is_empty() {
                    extracted_tags.push(format!("{}:{}", name, val));
                }
            }
        }

        return Some(ParsedMetadata {
            match_type: "custom_regex".to_string(),
            raw_matched: filename.to_string(),
            artist,
            pixiv_id,
            twitter_id,
            timestamp_4chan,
            datetime_iso,
            extracted_tags,
            partial: false,
        });
    }
    None
}

/// Compile No-Code token blocks into Regex with named capture groups.
/// Disabled blocks are still included in the regex (so the pattern matches)
/// but their group names are prefixed with `_skip_` so their values are discarded.
pub fn compile_token_blocks(blocks: &[TokenBlock]) -> String {
    let mut regex_str = String::from("^");
    for b in blocks {
        let default_name = match b.token_type.as_str() {
            "artist" => "artist",
            "timestamp_4chan" => "timestamp",
            "pixiv_id" => "pixiv_id",
            "twitter_id" => "twitter_id",
            "number" => "number",
            "md5_hash" => "hash",
            "wildcard" => "wildcard",
            "tag" => "tag",
            "bracketed" => "bracketed",
            _ => "extracted",
        };
        let base_name = b.label.as_deref().unwrap_or(default_name);
        let group_name = if b.enabled {
            base_name.to_string()
        } else {
            format!("_skip_{}", base_name)
        };
        let inner = match b.token_type.as_str() {
            "artist" => format!(r"(?P<{}>[A-Za-z0-9_\-\s]+)", group_name),
            "timestamp_4chan" => format!(r"(?P<{}>\d{{10,16}})", group_name),
            "pixiv_id" => format!(r"(?P<{}>\d{{7,10}})", group_name),
            "twitter_id" => format!(r"(?P<{}>[A-Za-z0-9_-]{{15,25}})", group_name),
            "number" => format!(r"(?P<{}>\d+)", group_name),
            "md5_hash" => format!(r"(?P<{}>[0-9a-f]{{32}})", group_name),
            "delimiter" => regex::escape(b.value.as_deref().unwrap_or("_")),
            "wildcard" => format!(r"(?P<{}>.*?)", group_name),
            "tag" => format!(r"(?P<{}>[A-Za-z0-9_\-]+)", group_name),
            "bracketed" => format!(r"\[(?P<{}>[^\]]+)\]", group_name),
            "whitespace" => r"\s*".to_string(),
            _ => continue,
        };
        if let Some(ref prefix) = b.optional_prefix {
            let escaped = regex::escape(prefix);
            regex_str.push_str(&format!("(?:{})?{}", escaped, inner));
        } else {
            regex_str.push_str(&inner);
        }
    }
    regex_str.push('$');
    regex_str
}

pub(crate) fn apply_match_type_override(
    result: ParsedMetadata,
    override_type: Option<&str>,
) -> ParsedMetadata {
    match override_type {
        Some(t) => ParsedMetadata {
            match_type: t.to_string(),
            ..result
        },
        None => result,
    }
}
