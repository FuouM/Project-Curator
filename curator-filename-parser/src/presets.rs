use super::types::ParsedMetadata;
use aho_corasick::AhoCorasick;
use chrono::{DateTime, Utc};
use regex::Regex;
use std::sync::OnceLock;

/// Returns true if the filename might match a given preset (Aho-Corasick substring check)
fn might_match(filename: &str, preset_id: &str) -> bool {
    static AC_PIXIV: OnceLock<AhoCorasick> = OnceLock::new();
    static AC_TWITTER: OnceLock<AhoCorasick> = OnceLock::new();
    static AC_TAGGED: OnceLock<AhoCorasick> = OnceLock::new();

    match preset_id {
        "pixiv_id" => {
            let ac = AC_PIXIV
                .get_or_init(|| AhoCorasick::new(["illust_", "_p0", "_p1", "_p2", "_p3"]).unwrap());
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
        _ => true, // 4chan_timestamp, anime_screenshot, danbooru: no quick reject
    }
}

/// Run built-in preset test
pub fn test_preset(filename: &str, preset_id: &str) -> Option<ParsedMetadata> {
    match preset_id {
        "4chan_timestamp" => parse_4chan_timestamp(filename),
        "pixiv_id" => {
            if might_match(filename, "pixiv_id") {
                parse_pixiv_id(filename)
            } else {
                None
            }
        }
        "twitter_key" => {
            if might_match(filename, "twitter_key") {
                parse_twitter_key(filename)
            } else {
                None
            }
        }
        "danbooru" => parse_danbooru(filename),
        "tagged_string" => {
            if might_match(filename, "tagged_string") {
                parse_tagged_string(filename)
            } else {
                None
            }
        }
        "anime_screenshot" => parse_anime_screenshot(filename),
        _ => None,
    }
}

/// 4chan timestamp extractor (10, 13, 16 digits)
fn parse_4chan_timestamp(filename: &str) -> Option<ParsedMetadata> {
    let parts: Vec<&str> = filename.split(['_', '-', ' ']).collect();
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
                        return Some(ParsedMetadata {
                            match_type: "4chan_timestamp".to_string(),
                            raw_matched: filename.to_string(),
                            artist: None,
                            pixiv_id: None,
                            twitter_id: None,
                            timestamp_4chan: Some(part.to_string()),
                            datetime_iso: Some(iso),
                            extracted_tags: vec![date_tag],
                            partial: false,
                        });
                    }
                }
            }
        }
    }
    None
}

/// Pixiv post extractor (illust_123456_..., ..._p0)
fn parse_pixiv_id(filename: &str) -> Option<ParsedMetadata> {
    static RE_ILLUST: OnceLock<Regex> = OnceLock::new();
    let re_illust =
        RE_ILLUST.get_or_init(|| Regex::new(r"illust_(\d+)(?:_(\d{8})_(\d{6}))?").unwrap());
    if let Some(caps) = re_illust.captures(filename) {
        let pid = caps.get(1)?.as_str().to_string();
        let mut tags = vec![format!("pixiv:{}", pid)];
        let mut iso = None;
        if let (Some(d), Some(t)) = (caps.get(2), caps.get(3)) {
            let date_str = d.as_str();
            if date_str.len() == 8 {
                tags.push(format!(
                    "date:{}-{}-{}",
                    &date_str[0..4],
                    &date_str[4..6],
                    &date_str[6..8]
                ));
                iso = Some(format!(
                    "{}-{}-{} {}",
                    &date_str[0..4],
                    &date_str[4..6],
                    &date_str[6..8],
                    t.as_str()
                ));
            }
        }
        return Some(ParsedMetadata {
            match_type: "pixiv_id".to_string(),
            raw_matched: filename.to_string(),
            artist: None,
            pixiv_id: Some(pid),
            twitter_id: None,
            timestamp_4chan: None,
            datetime_iso: iso,
            extracted_tags: tags,
            partial: false,
        });
    }

    static RE_PAGE: OnceLock<Regex> = OnceLock::new();
    let re_page =
        RE_PAGE.get_or_init(|| Regex::new(r"^(?:(.+)_)?(\d{7,10})_p(\d+)(?:[\s_](.+))?$").unwrap());
    if let Some(caps) = re_page.captures(filename) {
        let artist = caps.get(1).map(|m| m.as_str().trim().to_string());
        let pid = caps.get(2)?.as_str().to_string();
        let page = caps.get(3)?.as_str().to_string();
        let mut tags = vec![format!("pixiv:{}", pid), format!("page:{}", page)];
        if let Some(ref a) = artist {
            if !a.is_empty() {
                tags.push(format!("artist:{}", a));
            }
        }
        return Some(ParsedMetadata {
            match_type: "pixiv_id".to_string(),
            raw_matched: filename.to_string(),
            artist,
            pixiv_id: Some(pid),
            twitter_id: None,
            timestamp_4chan: None,
            datetime_iso: None,
            extracted_tags: tags,
            partial: false,
        });
    }

    None
}

/// Twitter key extractor (media_..., snowflake IDs)
fn parse_twitter_key(filename: &str) -> Option<ParsedMetadata> {
    static RE_TW: OnceLock<Regex> = OnceLock::new();
    let re_tw =
        RE_TW.get_or_init(|| Regex::new(r"(?:media_|status_)?([A-Za-z0-9_-]{15,25})").unwrap());
    static RE_SNOWFLAKE: OnceLock<Regex> = OnceLock::new();
    let re_snowflake =
        RE_SNOWFLAKE.get_or_init(|| Regex::new(r"([a-zA-Z0-9_-]+-\d{18,20})").unwrap());

    if let Some(caps) = re_snowflake.captures(filename) {
        let match_str = caps.get(1)?.as_str().to_string();
        return Some(ParsedMetadata {
            match_type: "twitter_key".to_string(),
            raw_matched: filename.to_string(),
            artist: None,
            pixiv_id: None,
            twitter_id: Some(match_str.clone()),
            timestamp_4chan: None,
            datetime_iso: None,
            extracted_tags: vec![format!("twitter:{}", match_str)],
            partial: false,
        });
    }

    if let Some(caps) = re_tw.captures(filename) {
        let key = caps.get(1)?.as_str().to_string();
        if key.len() >= 15 {
            return Some(ParsedMetadata {
                match_type: "twitter_key".to_string(),
                raw_matched: filename.to_string(),
                artist: None,
                pixiv_id: None,
                twitter_id: Some(key.clone()),
                timestamp_4chan: None,
                datetime_iso: None,
                extracted_tags: vec![format!("twitter:{}", key)],
                partial: false,
            });
        }
    }

    None
}

/// Danbooru post extractor — placeholder, patterns defined by user
fn parse_danbooru(_filename: &str) -> Option<ParsedMetadata> {
    None
}

/// Tagged string extractor `[artist] title (tag1 tag2)`
fn parse_tagged_string(filename: &str) -> Option<ParsedMetadata> {
    static RE_BRACKET: OnceLock<Regex> = OnceLock::new();
    let re_bracket = RE_BRACKET
        .get_or_init(|| Regex::new(r"^\[([^\]]+)\]\s*(.*?)(?:\s*\(([^)]+)\))?$").unwrap());
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

        return Some(ParsedMetadata {
            match_type: "tagged_string".to_string(),
            raw_matched: filename.to_string(),
            artist,
            pixiv_id: None,
            twitter_id: None,
            timestamp_4chan: None,
            datetime_iso: None,
            extracted_tags: tags,
            partial: false,
        });
    }
    None
}

/// Anime screenshot extractor — tries multiple common patterns
/// Returns partial match if some fields found (partial: true)
fn parse_anime_screenshot(filename: &str) -> Option<ParsedMetadata> {
    static RE_EPISODE: OnceLock<Regex> = OnceLock::new();
    let re_ep = RE_EPISODE.get_or_init(|| {
        Regex::new(r"(?:[-_\s](?:E(?:P)?|EP|ep)?(\d{1,4})|[-_\s](\d{1,4})[-_\s])").unwrap()
    });

    static RE_RESOLUTION: OnceLock<Regex> = OnceLock::new();
    let re_res = RE_RESOLUTION.get_or_init(|| Regex::new(r"(?i)(\d{3,4}p)").unwrap());

    static RE_GROUP_BRACKET: OnceLock<Regex> = OnceLock::new();
    let re_grp = RE_GROUP_BRACKET.get_or_init(|| Regex::new(r"^\[([^\]]+)\]").unwrap());

    let stem = std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    // Try to find episode number
    let ep_caps = re_ep.captures(stem);
    let ep_str = ep_caps.as_ref().and_then(|c| c.get(1).or_else(|| c.get(2)));
    let ep_num = ep_str.map(|m| m.as_str());
    let ep_start = ep_caps.as_ref().and_then(|c| c.get(0).map(|m| m.start()));

    let mut extracted_tags = Vec::new();
    let mut partial = false;

    if let (Some(ep_num), Some(ep_start)) = (ep_num, ep_start) {
        // Extract anime name: everything before the episode match
        let before_ep = &stem[..ep_start].trim_end_matches(['-', '_', ' ', '.']);

        // Remove leading [Group] tags
        let name_clean = before_ep.trim_start_matches(['[', '(']).trim_start();
        let name_clean = if let Some(end) = name_clean.find(']') {
            name_clean[end + 1..].trim()
        } else if let Some(end) = name_clean.find(')') {
            name_clean[end + 1..].trim()
        } else {
            name_clean.trim()
        };

        // Clean up common separators in anime names
        let anime_name = name_clean.replace(['_', '.'], " ").trim().to_string();

        if !anime_name.is_empty() {
            extracted_tags.push(format!("anime:{}", anime_name));
            extracted_tags.push(format!("episode:{}", ep_num));
        } else {
            partial = true;
            extracted_tags.push(format!("episode:{}", ep_num));
        }

        // Extract remaining info after episode
        let after_ep = &stem[ep_caps.as_ref().unwrap().get(0).unwrap().end()..];

        // Look for resolution
        if let Some(res) = re_res.find(after_ep).or_else(|| re_res.find(stem)) {
            extracted_tags.push(format!("resolution:{}", res.as_str().to_lowercase()));
        }
    } else {
        partial = true;
    }

    // Look for source group in brackets
    if let Some(grp) = re_grp.captures(stem).and_then(|c| c.get(1)) {
        extracted_tags.push(format!("group:{}", grp.as_str()));
    }

    if extracted_tags.is_empty() {
        return None;
    }

    Some(ParsedMetadata {
        match_type: "anime_screenshot".to_string(),
        raw_matched: filename.to_string(),
        artist: None,
        pixiv_id: None,
        twitter_id: None,
        timestamp_4chan: None,
        datetime_iso: None,
        extracted_tags,
        partial,
    })
}
