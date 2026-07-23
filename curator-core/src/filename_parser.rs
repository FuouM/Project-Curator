use anyhow::Result;
use aho_corasick::AhoCorasick;
use chrono::{DateTime, Utc};
use futures_util::stream::TryStreamExt;
use regex::Regex;
use regex_automata::meta::Regex as DfaRegex;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedMetadataResult {
    pub match_type: String,
    pub raw_matched: String,
    pub artist: Option<String>,
    pub pixiv_id: Option<String>,
    pub twitter_id: Option<String>,
    pub timestamp_4chan: Option<String>,
    pub datetime_iso: Option<String>,
    pub extracted_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBlock {
    pub token_type: String, // "artist", "timestamp_4chan", "pixiv_id", "twitter_id", "number", "delimiter", "wildcard", "tag", "bracketed"
    pub value: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulePayload {
    pub id: Option<i64>,
    pub name: String,
    pub rule_type: String, // "preset", "custom_regex", "token_builder"
    pub pattern: Option<String>,
    pub token_config: Option<Vec<TokenBlock>>,
    pub is_enabled: bool,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPreviewItem {
    pub image_id: i64,
    pub filename: String,
    pub filepath: String,
    pub match_result: Option<ParsedMetadataResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchExecutionResult {
    pub total_processed: usize,
    pub matched_count: usize,
    pub tags_created: usize,
}

pub struct FilenameParser;

impl FilenameParser {
    /// Test a single filename against built-in presets or custom patterns
    pub fn test_filename(filename: &str, pattern_or_type: &str, rule_type: &str, token_config: Option<&[TokenBlock]>) -> Option<ParsedMetadataResult> {
        let clean_filename = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        match rule_type {
            "preset" => Self::test_preset(clean_filename, pattern_or_type),
            "custom_regex" => Self::test_regex(clean_filename, pattern_or_type),
            "token_builder" => {
                if let Some(blocks) = token_config {
                    let compiled_regex = Self::compile_token_blocks(blocks);
                    Self::test_regex(clean_filename, &compiled_regex)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Quick prefix filter using Aho-Corasick to skip filenames that can't match a preset
    fn quick_reject(filename: &str, preset_id: &str) -> bool {
        static AC_PIXIV: OnceLock<AhoCorasick> = OnceLock::new();
        static AC_BOORU: OnceLock<AhoCorasick> = OnceLock::new();
        static AC_TWITTER: OnceLock<AhoCorasick> = OnceLock::new();
        static AC_TAGGED: OnceLock<AhoCorasick> = OnceLock::new();

        match preset_id {
            "pixiv_id" => {
                let ac = AC_PIXIV.get_or_init(|| AhoCorasick::new(["illust_", "_p0", "_p1", "_p2", "_p3"]).unwrap());
                ac.find(filename).is_some()
            }
            "booru_post" => {
                let ac = AC_BOORU.get_or_init(|| AhoCorasick::new(["gelbooru_", "yandere_", "danbooru_", "konachan_"]).unwrap());
                ac.find(filename).is_some()
            }
            "twitter_key" => {
                let ac = AC_TWITTER.get_or_init(|| AhoCorasick::new(["media_", "status_"]).unwrap());
                ac.find(filename).is_some()
            }
            "tagged_string" => {
                let ac = AC_TAGGED.get_or_init(|| AhoCorasick::new([r"["]).unwrap());
                ac.find(filename).is_some()
            }
            _ => true, // 4chan_timestamp: no quick reject
        }
    }

    /// Run built-in preset test
    pub fn test_preset(filename: &str, preset_id: &str) -> Option<ParsedMetadataResult> {
        let clean = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        match preset_id {
            "4chan_timestamp" => Self::parse_4chan_timestamp(clean),
            "pixiv_id" => {
                if Self::quick_reject(clean, "pixiv_id") {
                    Self::parse_pixiv_id(clean)
                } else {
                    None
                }
            }
            "twitter_key" => {
                if Self::quick_reject(clean, "twitter_key") {
                    Self::parse_twitter_key(clean)
                } else {
                    None
                }
            }
            "booru_post" => {
                if Self::quick_reject(clean, "booru_post") {
                    Self::parse_booru_post(clean)
                } else {
                    None
                }
            }
            "tagged_string" => {
                if Self::quick_reject(clean, "tagged_string") {
                    Self::parse_tagged_string(clean)
                } else {
                    None
                }
            }
            "anime_screenshot" => Self::parse_anime_screenshot(clean),
            _ => None,
        }
    }

    /// 4chan timestamp extractor (10, 13, 16 digits)
    fn parse_4chan_timestamp(filename: &str) -> Option<ParsedMetadataResult> {
        let clean = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        let parts: Vec<&str> = clean.split(['_', '-', ' ']).collect();
        for part in parts {
            if part.chars().all(|c| c.is_ascii_digit()) {
                let len = part.len();
                let secs = match len {
                    10 => part.parse::<i64>().ok(),
                    13 => part.parse::<i64>().ok().map(|ms| ms / 1_000),
                    16 => part.parse::<i64>().ok().map(|us| us / 1_000_000),
                    _ => None,
                };

                if let Some(sec) = secs {
                    if let Some(dt) = DateTime::<Utc>::from_timestamp(sec, 0) {
                        // Sanity check year between 2003 (4chan launch) and 2030
                        let year = dt.format("%Y").to_string().parse::<i32>().unwrap_or(0);
                        if (2003..=2030).contains(&year) {
                            let iso = dt.format("%Y-%m-%d %H:%M:%S UTC").to_string();
                            let date_tag = format!("date:{}", dt.format("%Y-%m-%d"));
                            return Some(ParsedMetadataResult {
                                match_type: "4chan_timestamp".to_string(),
                                raw_matched: filename.to_string(),
                                artist: None,
                                pixiv_id: None,
                                twitter_id: None,
                                timestamp_4chan: Some(part.to_string()),
                                datetime_iso: Some(iso),
                                extracted_tags: vec![date_tag],
                            });
                        }
                    }
                }
            }
        }
        None
    }

    /// Pixiv post extractor (illust_123456_..., ..._p0)
    fn parse_pixiv_id(filename: &str) -> Option<ParsedMetadataResult> {
        let clean = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        static RE_ILLUST: OnceLock<Regex> = OnceLock::new();
        let re_illust = RE_ILLUST.get_or_init(|| Regex::new(r"illust_(\d+)(?:_(\d{8})_(\d{6}))?").unwrap());
        if let Some(caps) = re_illust.captures(clean) {
            let pid = caps.get(1)?.as_str().to_string();
            let mut tags = vec![format!("pixiv:{}", pid)];
            let mut iso = None;
            if let (Some(d), Some(t)) = (caps.get(2), caps.get(3)) {
                let date_str = d.as_str();
                if date_str.len() == 8 {
                    tags.push(format!("date:{}-{}-{}", &date_str[0..4], &date_str[4..6], &date_str[6..8]));
                    iso = Some(format!("{}-{}-{} {}", &date_str[0..4], &date_str[4..6], &date_str[6..8], t.as_str()));
                }
            }
            return Some(ParsedMetadataResult {
                match_type: "pixiv_id".to_string(),
                raw_matched: filename.to_string(),
                artist: None,
                pixiv_id: Some(pid),
                twitter_id: None,
                timestamp_4chan: None,
                datetime_iso: iso,
                extracted_tags: tags,
            });
        }

        static RE_PAGE: OnceLock<Regex> = OnceLock::new();
        let re_page = RE_PAGE.get_or_init(|| Regex::new(r"^(?:(.+)_)?(\d{7,10})_p(\d+)(?:[\s_](.+))?$").unwrap());
        if let Some(caps) = re_page.captures(clean) {
            let artist = caps.get(1).map(|m| m.as_str().trim().to_string());
            let pid = caps.get(2)?.as_str().to_string();
            let page = caps.get(3)?.as_str().to_string();
            let mut tags = vec![format!("pixiv:{}", pid), format!("page:{}", page)];
            if let Some(ref a) = artist {
                if !a.is_empty() {
                    tags.push(format!("artist:{}", a));
                }
            }
            return Some(ParsedMetadataResult {
                match_type: "pixiv_id".to_string(),
                raw_matched: filename.to_string(),
                artist,
                pixiv_id: Some(pid),
                twitter_id: None,
                timestamp_4chan: None,
                datetime_iso: None,
                extracted_tags: tags,
            });
        }

        None
    }

    /// Twitter key extractor (media_..., snowflake IDs)
    fn parse_twitter_key(filename: &str) -> Option<ParsedMetadataResult> {
        static RE_TW: OnceLock<Regex> = OnceLock::new();
        let re_tw = RE_TW.get_or_init(|| Regex::new(r"(?:media_|status_)?([A-Za-z0-9_-]{15,25})").unwrap());
        static RE_SNOWFLAKE: OnceLock<Regex> = OnceLock::new();
        let re_snowflake = RE_SNOWFLAKE.get_or_init(|| Regex::new(r"([a-zA-Z0-9_-]+-\d{18,20})").unwrap());

        if let Some(caps) = re_snowflake.captures(filename) {
            let match_str = caps.get(1)?.as_str().to_string();
            return Some(ParsedMetadataResult {
                match_type: "twitter_key".to_string(),
                raw_matched: filename.to_string(),
                artist: None,
                pixiv_id: None,
                twitter_id: Some(match_str.clone()),
                timestamp_4chan: None,
                datetime_iso: None,
                extracted_tags: vec![format!("twitter:{}", match_str)],
            });
        }

        if let Some(caps) = re_tw.captures(filename) {
            let key = caps.get(1)?.as_str().to_string();
            if key.len() >= 15 {
                return Some(ParsedMetadataResult {
                    match_type: "twitter_key".to_string(),
                    raw_matched: filename.to_string(),
                    artist: None,
                    pixiv_id: None,
                    twitter_id: Some(key.clone()),
                    timestamp_4chan: None,
                    datetime_iso: None,
                    extracted_tags: vec![format!("twitter:{}", key)],
                });
            }
        }

        None
    }

    /// Booru post extractor (gelbooru_..., yandere_...)
    fn parse_booru_post(filename: &str) -> Option<ParsedMetadataResult> {
        static RE_BOORU: OnceLock<Regex> = OnceLock::new();
        let re_booru = RE_BOORU.get_or_init(|| Regex::new(r"(gelbooru|yandere|danbooru|konachan)_(\d+)(?:_(.+))?").unwrap());
        if let Some(caps) = re_booru.captures(filename) {
            let site = caps.get(1)?.as_str().to_string();
            let id = caps.get(2)?.as_str().to_string();
            let mut tags = vec![format!("site:{}", site), format!("post_id:{}", id)];
            
            if let Some(extra) = caps.get(3) {
                let tag_tokens: Vec<&str> = extra.as_str().split(['_', ' ']).collect();
                for t in tag_tokens {
                    if !t.is_empty() && t.len() > 2 {
                        tags.push(t.to_string());
                    }
                }
            }

            return Some(ParsedMetadataResult {
                match_type: format!("{}_post", site),
                raw_matched: filename.to_string(),
                artist: None,
                pixiv_id: None,
                twitter_id: None,
                timestamp_4chan: None,
                datetime_iso: None,
                extracted_tags: tags,
            });
        }
        None
    }

    /// Tagged string extractor `[artist] title (tag1 tag2)`
    fn parse_tagged_string(filename: &str) -> Option<ParsedMetadataResult> {
        static RE_BRACKET: OnceLock<Regex> = OnceLock::new();
        let re_bracket = RE_BRACKET.get_or_init(|| Regex::new(r"^\[([^\]]+)\]\s*(.*?)(?:\s*\(([^)]+)\))?$").unwrap());
        if let Some(caps) = re_bracket.captures(filename) {
            let artist = caps.get(1).map(|m| m.as_str().trim().to_string());
            let mut tags = Vec::new();
            if let Some(ref a) = artist {
                tags.push(format!("artist:{}", a));
            }
            if let Some(t_caps) = caps.get(3) {
                for t in t_caps.as_str().split([' ', ',']) {
                    let clean = t.trim();
                    if !clean.is_empty() {
                        tags.push(clean.to_string());
                    }
                }
            }

            return Some(ParsedMetadataResult {
                match_type: "tagged_string".to_string(),
                raw_matched: filename.to_string(),
                artist,
                pixiv_id: None,
                twitter_id: None,
                timestamp_4chan: None,
                datetime_iso: None,
                extracted_tags: tags,
            });
        }
        None
    }

    /// Anime screenshot extractor — tries multiple common patterns
    /// Mandatory fields: anime_name, episode. The pill shows "Anime Screenshot: [name] - [ep]"
    fn parse_anime_screenshot(filename: &str) -> Option<ParsedMetadataResult> {
        static RE_EPISODE: OnceLock<Regex> = OnceLock::new();
        let re_ep = RE_EPISODE.get_or_init(|| {
            Regex::new(r"(?:[-_\s](?:E(?:P)?|EP|ep)?(\d{1,4})|[-_\s](\d{1,4})[-_\s])").unwrap()
        });

        // Pattern 1: [Group] Anime Name - 03 ... .mkv_snapshot_HH.MM.SSS.jpg
        // Pattern 2: [Group] Anime Name - 03 (1080p) ...
        // Pattern 3: Anime Name - 03 [1080p] ...
        // Pattern 4: Anime.Name.E03.1080p ...
        // Extract: everything before the episode number is the anime name

        // Strip file extension
        let stem = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        // Try to find episode number
        let ep_caps = re_ep.captures(stem)?;

        let ep_str = ep_caps.get(1).or_else(|| ep_caps.get(2))?;
        let ep_num = ep_str.as_str();
        let ep_start = ep_caps.get(0).unwrap().start();

        // Extract anime name: everything before the episode match, stripped of leading brackets/groups
        let before_ep = &stem[..ep_start].trim_end_matches(|c: char| c == '-' || c == '_' || c == ' ' || c == '.');

        // Remove leading [Group] tags
        let name_clean = before_ep
            .trim_start_matches(|c: char| c == '[' || c == '(')
            .trim_start();
        let name_clean = if let Some(end) = name_clean.find(']') {
            name_clean[end + 1..].trim()
        } else if let Some(end) = name_clean.find(')') {
            name_clean[end + 1..].trim()
        } else {
            name_clean.trim()
        };

        // Clean up common separators in anime names
        let anime_name = name_clean
            .replace('_', " ")
            .replace('.', " ")
            .trim()
            .to_string();

        if anime_name.is_empty() {
            return None;
        }

        // Extract remaining info after episode
        let after_ep = &stem[ep_caps.get(0).unwrap().end()..];
        let mut extracted_tags = vec![
            format!("anime:{}", anime_name),
            format!("episode:{}", ep_num),
        ];

        // Look for resolution
        if let Some(res) = Regex::new(r"(?i)(\d{3,4}p)").ok().and_then(|r| r.find(after_ep).or_else(|| Regex::new(r"(?i)(\d{3,4}p)").ok().and_then(|r| r.find(stem)))) {
            extracted_tags.push(format!("resolution:{}", res.as_str().to_lowercase()));
        }

        // Look for source group in brackets
        if let Some(grp) = Regex::new(r"^\[([^\]]+)\]").ok().and_then(|r| r.captures(stem)).and_then(|c| c.get(1)) {
            extracted_tags.push(format!("group:{}", grp.as_str()));
        }

        Some(ParsedMetadataResult {
            match_type: "anime_screenshot".to_string(),
            raw_matched: filename.to_string(),
            artist: None,
            pixiv_id: None,
            twitter_id: None,
            timestamp_4chan: None,
            datetime_iso: None,
            extracted_tags,
        })
    }

    /// Quick pre-filter: check if filename contains a run of N+ consecutive digits
    fn has_digit_run(filename: &str, min_len: usize) -> bool {
        let mut run = 0;
        for c in filename.chars() {
            if c.is_ascii_digit() {
                run += 1;
                if run >= min_len {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        false
    }

    /// Test Regex pattern with named capture groups
    pub fn test_regex(filename: &str, pattern: &str) -> Option<ParsedMetadataResult> {
        // Quick pre-filter: if the pattern requires digit runs, check first
        if pattern.contains(r"\d{7,") || pattern.contains(r"\d{6,") || pattern.contains(r"\d{5,") {
            if !Self::has_digit_run(filename, 5) {
                return None;
            }
        }

        // Use DFA for fast match check, then NFA for captures only if matched
        static DFA_CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, DfaRegex>>> = OnceLock::new();
        let cache = DFA_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let is_match = {
            let mut guard = cache.lock().unwrap();
            let dfa = guard.entry(pattern.to_string()).or_insert_with(|| {
                DfaRegex::new(pattern).unwrap_or_else(|_| DfaRegex::new("a^").unwrap())
            });
            dfa.is_match(filename.as_bytes())
        };
        if !is_match {
            return None;
        }

        let re = Regex::new(pattern).ok()?;
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

            return Some(ParsedMetadataResult {
                match_type: "custom_regex".to_string(),
                raw_matched: filename.to_string(),
                artist,
                pixiv_id,
                twitter_id,
                timestamp_4chan,
                datetime_iso,
                extracted_tags,
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
            match b.token_type.as_str() {
                "artist" => {
                    regex_str.push_str(&format!(r"(?P<{}>[A-Za-z0-9_\-\s]+)", group_name));
                }
                "timestamp_4chan" => {
                    regex_str.push_str(&format!(r"(?P<{}>\d{{10,16}})", group_name));
                }
                "pixiv_id" => {
                    regex_str.push_str(&format!(r"(?P<{}>\d{{7,10}})", group_name));
                }
                "twitter_id" => {
                    regex_str.push_str(&format!(r"(?P<{}>[A-Za-z0-9_-]{{15,25}})", group_name));
                }
                "number" => {
                    regex_str.push_str(&format!(r"(?P<{}>\d+)", group_name));
                }
                "delimiter" => {
                    let d = b.value.as_deref().unwrap_or("_");
                    regex_str.push_str(&regex::escape(d));
                }
                "wildcard" => {
                    regex_str.push_str(&format!(r"(?P<{}>.*?)", group_name));
                }
                "tag" => {
                    regex_str.push_str(&format!(r"(?P<{}>[A-Za-z0-9_\-]+)", group_name));
                }
                "bracketed" => {
                    regex_str.push_str(&format!(r"\[(?P<{}>[^\]]+)\]", group_name));
                }
                "whitespace" => {
                    regex_str.push_str(r"\s*");
                }
                _ => {}
            }
        }
        regex_str.push('$');
        regex_str
    }

    /// Preview batch parsing results on database images
    pub async fn preview_batch(
        pool: &SqlitePool,
        limit: usize,
        pattern_or_type: &str,
        rule_type: &str,
        token_config: Option<&[TokenBlock]>,
        output_match_type: Option<&str>,
    ) -> Result<Vec<BatchPreviewItem>> {
        let mut rows = sqlx::query_as::<_, (i64, String)>(
            "SELECT id, current_filepath FROM images WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?"
        )
        .bind(limit as i64)
        .fetch(pool);

        let mut items = Vec::new();
        while let Some(row) = rows.try_next().await? {
            let (id, current_filepath) = row;
            let filename = std::path::Path::new(&current_filepath)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(&current_filepath)
                .to_string();

            let match_res = Self::test_filename(&filename, pattern_or_type, rule_type, token_config);

            // Override match_type if output_match_type is specified
            let match_res = match_res.map(|mut m| {
                if let Some(override_type) = output_match_type {
                    m.match_type = override_type.to_string();
                }
                m
            });
            items.push(BatchPreviewItem {
                image_id: id,
                filename,
                filepath: current_filepath,
                match_result: match_res,
            });
        }

        Ok(items)
    }

    /// Execute batch filename parsing and save to DB
    pub async fn run_batch(
        pool: &SqlitePool,
        pattern_or_type: &str,
        rule_type: &str,
        token_config: Option<&[TokenBlock]>,
        output_match_type: Option<&str>,
    ) -> Result<BatchExecutionResult> {
        // Ensure source exists for filename_parser
        let source: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM sources WHERE name = 'filename_parser'"
        )
        .fetch_optional(pool)
        .await?;

        let source_id = match source {
            Some((id,)) => id,
            None => {
                let res = sqlx::query(
                    "INSERT INTO sources (name, type, manifest) VALUES ('filename_parser', 'builtin', '{}')"
                )
                .execute(pool)
                .await?;
                res.last_insert_rowid()
            }
        };

        let mut rows = sqlx::query_as::<_, (i64, String)>(
            "SELECT id, current_filepath FROM images WHERE deleted_at IS NULL"
        )
        .fetch(pool);

        let mut total_processed: usize = 0;
        let mut matched_count: usize = 0;
        let mut tags_created: usize = 0;

        // In-memory tag cache: tag_name -> tag_id
        let mut tag_cache: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

        // Pre-load existing tags into cache
        let existing_tags: Vec<(i64, String)> = sqlx::query_as("SELECT id, name FROM tags")
            .fetch_all(pool)
            .await?;
        for (id, name) in existing_tags {
            tag_cache.insert(name, id);
        }

        // Process in transaction batches of 500
        const BATCH_SIZE: usize = 500;
        let mut batch: Vec<(i64, String)> = Vec::with_capacity(BATCH_SIZE);

        while let Some(row) = rows.try_next().await? {
            batch.push(row);
            total_processed += 1;

            if batch.len() >= BATCH_SIZE {
                Self::flush_batch(pool, &mut batch, pattern_or_type, rule_type, token_config, source_id, &mut tag_cache, &mut matched_count, &mut tags_created, output_match_type).await?;
            }
        }

        // Flush remaining
        if !batch.is_empty() {
            Self::flush_batch(pool, &mut batch, pattern_or_type, rule_type, token_config, source_id, &mut tag_cache, &mut matched_count, &mut tags_created, output_match_type).await?;
        }

        Ok(BatchExecutionResult {
            total_processed,
            matched_count,
            tags_created,
        })
    }

    /// Flush a batch of images within a single transaction
    async fn flush_batch(
        pool: &SqlitePool,
        batch: &mut Vec<(i64, String)>,
        pattern_or_type: &str,
        rule_type: &str,
        token_config: Option<&[TokenBlock]>,
        source_id: i64,
        tag_cache: &mut std::collections::HashMap<String, i64>,
        matched_count: &mut usize,
        tags_created: &mut usize,
        output_match_type: Option<&str>,
    ) -> Result<()> {
        let mut tx = pool.begin().await?;

        for (img_id, current_filepath) in batch.drain(..) {
            let path_buf = std::path::PathBuf::from(&current_filepath);
            let filename = path_buf
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(&current_filepath)
                .to_string();

            let match_res = Self::test_filename(&filename, pattern_or_type, rule_type, token_config);

            // Override match_type if output_match_type is specified
            let match_res = match_res.map(|mut m| {
                if let Some(override_type) = output_match_type {
                    m.match_type = override_type.to_string();
                }
                m
            });

            if let Some(res) = match_res {
                *matched_count += 1;
                let extracted_json = serde_json::to_string(&res.extracted_tags).ok();

                sqlx::query(
                    r#"
                    INSERT INTO image_parsed_metadata (
                        image_id, match_type, artist, pixiv_id, twitter_id,
                        timestamp_4chan, datetime_iso, extracted_tags, raw_matched
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(image_id) DO UPDATE SET
                        match_type = excluded.match_type,
                        artist = excluded.artist,
                        pixiv_id = excluded.pixiv_id,
                        twitter_id = excluded.twitter_id,
                        timestamp_4chan = excluded.timestamp_4chan,
                        datetime_iso = excluded.datetime_iso,
                        extracted_tags = excluded.extracted_tags,
                        raw_matched = excluded.raw_matched,
                        updated_at = CURRENT_TIMESTAMP
                    "#
                )
                .bind(img_id)
                .bind(&res.match_type)
                .bind(&res.artist)
                .bind(&res.pixiv_id)
                .bind(&res.twitter_id)
                .bind(&res.timestamp_4chan)
                .bind(&res.datetime_iso)
                .bind(&extracted_json)
                .bind(&res.raw_matched)
                .execute(&mut *tx)
                .await?;

                for tag_name in res.extracted_tags {
                    let category = if tag_name.starts_with("artist:") {
                        "artist"
                    } else if tag_name.starts_with("date:") {
                        "meta"
                    } else if tag_name.starts_with("site:") || tag_name.starts_with("source:") {
                        "source"
                    } else {
                        "general"
                    };

                    // Use cache or insert and cache
                    let tag_id = if let Some(&cached_id) = tag_cache.get(&tag_name) {
                        cached_id
                    } else {
                        sqlx::query("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)")
                            .bind(&tag_name)
                            .bind(category)
                            .execute(&mut *tx)
                            .await?;

                        let tag_row: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
                            .bind(&tag_name)
                            .fetch_one(&mut *tx)
                            .await?;

                        tag_cache.insert(tag_name.clone(), tag_row.0);
                        tag_row.0
                    };

                    let res_link = sqlx::query(
                        r#"
                        INSERT INTO image_tags (image_id, tag_id, source_id, confidence)
                        VALUES (?, ?, ?, 1.0)
                        ON CONFLICT(image_id, tag_id, source_id, transaction_id) DO NOTHING
                        "#
                    )
                    .bind(img_id)
                    .bind(tag_id)
                    .bind(source_id)
                    .execute(&mut *tx)
                    .await?;

                    if res_link.rows_affected() > 0 {
                        *tags_created += 1;
                    }
                }
            }
        }

        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_4chan_timestamp_extractor() {
        let res = FilenameParser::parse_4chan_timestamp("1652448237000.png").unwrap();
        assert_eq!(res.match_type, "4chan_timestamp");
        assert_eq!(res.timestamp_4chan.as_deref(), Some("1652448237000"));
        assert!(res.extracted_tags.iter().any(|t| t.starts_with("date:")));
    }

    #[test]
    fn test_pixiv_extractor() {
        let res = FilenameParser::parse_pixiv_id("illust_108521179_20230513_212357.jpg").unwrap();
        assert_eq!(res.match_type, "pixiv_id");
        assert_eq!(res.pixiv_id.as_deref(), Some("108521179"));

        let res_page = FilenameParser::parse_pixiv_id("gwitch_suletta_Mineori_108521179_p0.png").unwrap();
        assert_eq!(res_page.match_type, "pixiv_id");
        assert_eq!(res_page.pixiv_id.as_deref(), Some("108521179"));
    }

    #[test]
    fn test_twitter_key_extractor() {
        let res = FilenameParser::parse_twitter_key("media_FR49d0XWUAImXfA.jpg_large").unwrap();
        assert_eq!(res.match_type, "twitter_key");
        assert_eq!(res.twitter_id.as_deref(), Some("FR49d0XWUAImXfA"));
    }

    #[test]
    fn test_token_builder_compiler() {
        let blocks = vec![
            TokenBlock { token_type: "artist".to_string(), value: None },
            TokenBlock { token_type: "delimiter".to_string(), value: Some("_".to_string()) },
            TokenBlock { token_type: "pixiv_id".to_string(), value: None },
        ];

        let compiled = FilenameParser::compile_token_blocks(&blocks);
        assert_eq!(compiled, "^(?P<artist>[A-Za-z0-9_\\-\\s]+)_(?P<pixiv_id>\\d{7,10})$");

        let res = FilenameParser::test_regex("Mineori_108521179", &compiled).unwrap();
        assert_eq!(res.artist.as_deref(), Some("Mineori"));
        assert_eq!(res.pixiv_id.as_deref(), Some("108521179"));
    }

    #[test]
    fn bench_filename_parser_throughput() {
        use std::time::Instant;

        // Generate realistic filenames: 50K mix of pixiv, twitter, booru, tagged, 4chan, and random
        let mut filenames: Vec<String> = Vec::with_capacity(50_000);
        for i in 0..50_000 {
            match i % 10 {
                0 => filenames.push(format!("artist_name_{}_p0.png", 10000000 + i)),
                1 => filenames.push(format!("illust_{}_20230513_212357.jpg", 10000000 + i)),
                2 => filenames.push(format!("media_FR{}d0XWUAImXfA.jpg", i)),
                3 => filenames.push(format!("gelbooru_{}_some_tag_another_tag.jpg", i)),
                4 => filenames.push(format!("[Artist Name] Title (tag1 tag2 tag3).png")),
                5 => filenames.push(format!("{}.png", 1652448237 + i)),
                6 => filenames.push(format!("random_filename_no_match_{}.jpg", i)),
                7 => filenames.push(format!("illust_{}.png", 10000000 + i)),
                8 => filenames.push(format!("danbooru_{}_test.jpg", i)),
                9 => filenames.push(format!("[Cool Artist] Amazing Artwork (landscape wallpaper).png")),
                _ => unreachable!(),
            }
        }

        // Benchmark 1: single preset "pixiv_id" (realistic batch scenario)
        let start = Instant::now();
        let mut match_count = 0u64;
        for f in &filenames {
            if FilenameParser::test_filename(f, "pixiv_id", "preset", None).is_some() {
                match_count += 1;
            }
        }
        let elapsed_pixiv = start.elapsed();
        let throughput_pixiv = filenames.len() as f64 / elapsed_pixiv.as_secs_f64();

        // Benchmark 2: single preset "booru_post"
        let start = Instant::now();
        let mut match_count_booru = 0u64;
        for f in &filenames {
            if FilenameParser::test_filename(f, "booru_post", "preset", None).is_some() {
                match_count_booru += 1;
            }
        }
        let elapsed_booru = start.elapsed();
        let throughput_booru = filenames.len() as f64 / elapsed_booru.as_secs_f64();

        // Benchmark 3: pre-compiled custom_regex (pixiv-like pattern that matches some filenames)
        // Strip extensions like test_filename does in production
        let regex_pattern = r"^(?:(?P<artist>[A-Za-z0-9_\-\s]+)_)?(?P<pixiv_id>\d{7,10})(?:_p(?P<page>\d+))?$";
        let stripped: Vec<&str> = filenames.iter().map(|f| {
            std::path::Path::new(f).file_stem().and_then(|s| s.to_str()).unwrap_or(f)
        }).collect();
        let start = Instant::now();
        let mut match_count_re = 0u64;
        for f in &stripped {
            if FilenameParser::test_regex(f, regex_pattern).is_some() {
                match_count_re += 1;
            }
        }
        let elapsed_regex = start.elapsed();
        let throughput_regex = filenames.len() as f64 / elapsed_regex.as_secs_f64();

        // Benchmark 4: token_builder (pre-compiled regex via compile_token_blocks)
        let token_config = vec![
            TokenBlock { token_type: "pixiv_id".to_string(), value: None },
        ];
        let compiled_token_regex = FilenameParser::compile_token_blocks(&token_config);
        let start = Instant::now();
        let mut match_count_tb = 0u64;
        for f in &stripped {
            if FilenameParser::test_regex(f, &compiled_token_regex).is_some() {
                match_count_tb += 1;
            }
        }
        let elapsed_tb = start.elapsed();
        let throughput_tb = filenames.len() as f64 / elapsed_tb.as_secs_f64();

        println!("=== Filename Parser Benchmark (50,000 filenames) ===");
        println!();
        println!("pixiv_id preset (single pattern, Aho-Corasick filtered):");
        println!("  Time:       {:.2?}", elapsed_pixiv);
        println!("  Throughput: {:.0} files/sec", throughput_pixiv);
        println!("  Matches:    {} / {}", match_count, filenames.len());
        println!();
        println!("booru_post preset (single pattern, Aho-Corasick filtered):");
        println!("  Time:       {:.2?}", elapsed_booru);
        println!("  Throughput: {:.0} files/sec", throughput_booru);
        println!("  Matches:    {} / {}", match_count_booru, filenames.len());
        println!();
        println!("custom_regex (pre-compiled, single pass):");
        println!("  Time:       {:.2?}", elapsed_regex);
        println!("  Throughput: {:.0} files/sec", throughput_regex);
        println!("  Matches:    {} / {}", match_count_re, filenames.len());
        println!();
        println!("token_builder (pre-compiled regex):");
        println!("  Time:       {:.2?}", elapsed_tb);
        println!("  Throughput: {:.0} files/sec", throughput_tb);
        println!("  Matches:    {} / {}", match_count_tb, filenames.len());
    }
}

