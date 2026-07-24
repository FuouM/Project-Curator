pub mod batch;
pub mod presets;
pub mod token_builder;
pub mod types;

pub use batch::{preview_batch, run_batch};
pub use token_builder::{compile_token_blocks, test_regex};
pub use types::{BatchExecutionResult, BatchPreviewItem, ParsedMetadata, TokenBlock};

pub struct FilenameParser;

impl FilenameParser {
    /// Test a single filename against built-in presets or custom patterns
    pub fn test_filename(
        filename: &str,
        pattern_or_type: &str,
        rule_type: &str,
        token_config: Option<&[TokenBlock]>,
    ) -> Option<ParsedMetadata> {
        let clean_filename = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        match rule_type {
            "preset" => presets::test_preset(clean_filename, pattern_or_type),
            "custom_regex" => test_regex(clean_filename, pattern_or_type),
            "token_builder" => {
                if let Some(blocks) = token_config {
                    let compiled_regex = compile_token_blocks(blocks);
                    test_regex(clean_filename, &compiled_regex)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Run built-in preset test
    pub fn test_preset(filename: &str, preset_id: &str) -> Option<ParsedMetadata> {
        presets::test_preset(filename, preset_id)
    }

    /// Test Regex pattern with named capture groups
    pub fn test_regex(filename: &str, pattern: &str) -> Option<ParsedMetadata> {
        test_regex(filename, pattern)
    }

    /// Compile No-Code token blocks into Regex with named capture groups.
    pub fn compile_token_blocks(blocks: &[TokenBlock]) -> String {
        compile_token_blocks(blocks)
    }

    /// Preview batch parsing results on database images
    pub async fn preview_batch(
        pool: &sqlx::SqlitePool,
        limit: usize,
        pattern_or_type: &str,
        rule_type: &str,
        token_config: Option<&[TokenBlock]>,
        output_match_type: Option<&str>,
    ) -> anyhow::Result<Vec<BatchPreviewItem>> {
        batch::preview_batch(
            pool,
            limit,
            pattern_or_type,
            rule_type,
            token_config,
            output_match_type,
        )
        .await
    }

    /// Execute batch filename parsing and save to DB
    pub async fn run_batch(
        pool: &sqlx::SqlitePool,
        pattern_or_type: &str,
        rule_type: &str,
        token_config: Option<&[TokenBlock]>,
        output_match_type: Option<&str>,
    ) -> anyhow::Result<BatchExecutionResult> {
        batch::run_batch(
            pool,
            pattern_or_type,
            rule_type,
            token_config,
            output_match_type,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_4chan_timestamp_extractor() {
        let res = presets::test_preset("1652448237000", "4chan_timestamp").unwrap();
        assert_eq!(res.match_type, "4chan_timestamp");
        assert_eq!(
            res.timestamp_4chan.as_deref(),
            Some("1652448237000")
        );
        assert!(res.extracted_tags.iter().any(|t| t.starts_with("date:")));
    }

    #[test]
    fn test_pixiv_extractor() {
        let res = presets::test_preset("illust_108521179_20230513_212357", "pixiv_id").unwrap();
        assert_eq!(res.match_type, "pixiv_id");
        assert_eq!(res.pixiv_id.as_deref(), Some("108521179"));

        let res_page =
            presets::test_preset("gwitch_suletta_Mineori_108521179_p0", "pixiv_id").unwrap();
        assert_eq!(res_page.match_type, "pixiv_id");
        assert_eq!(res_page.pixiv_id.as_deref(), Some("108521179"));
    }

    #[test]
    fn test_twitter_key_extractor() {
        let res = presets::test_preset("media_FR49d0XWUAImXfA", "twitter_key").unwrap();
        assert_eq!(res.match_type, "twitter_key");
        assert_eq!(res.twitter_id.as_deref(), Some("FR49d0XWUAImXfA"));
    }

    #[test]
    fn test_token_builder_compiler() {
        let blocks = vec![
            TokenBlock {
                token_type: "artist".to_string(),
                value: None,
                label: None,
                enabled: true,
                optional_prefix: None,
            },
            TokenBlock {
                token_type: "delimiter".to_string(),
                value: Some("_".to_string()),
                label: None,
                enabled: true,
                optional_prefix: None,
            },
            TokenBlock {
                token_type: "pixiv_id".to_string(),
                value: None,
                label: None,
                enabled: true,
                optional_prefix: None,
            },
        ];

        let compiled = compile_token_blocks(&blocks);
        assert_eq!(
            compiled,
            "^(?P<artist>[A-Za-z0-9_\\-\\s]+)_(?P<pixiv_id>\\d{7,10})$"
        );

        let res = test_regex("Mineori_108521179", &compiled).unwrap();
        assert_eq!(res.artist.as_deref(), Some("Mineori"));
        assert_eq!(res.pixiv_id.as_deref(), Some("108521179"));
    }

    #[test]
    fn bench_filename_parser_throughput() {
        use std::time::Instant;

        // Generate realistic filenames: 50K mix of pixiv, twitter, danbooru, tagged, 4chan, and random
        let mut filenames: Vec<String> = Vec::with_capacity(50_000);
        for i in 0..50_000 {
            match i % 10 {
                0 => filenames.push(format!("artist_name_{}_p0.png", 10000000 + i)),
                1 => filenames.push(format!("illust_{}_20230513_212357.jpg", 10000000 + i)),
                2 => filenames.push(format!("media_FR{}d0XWUAImXfA.jpg", i)),
                3 => filenames.push(format!("__some_tags_and_more__{:032x}.jpg", i)),
                4 => filenames.push(format!(
                    "[Artist Name] Title (tag1 tag2 tag3).png"
                )),
                5 => filenames.push(format!("{}.png", 1652448237 + i)),
                6 => filenames.push(format!("random_filename_no_match_{}.jpg", i)),
                7 => filenames.push(format!("illust_{}.png", 10000000 + i)),
                8 => filenames.push(format!("__danbooru_test_tags__{:032x}.png", i)),
                9 => filenames.push(format!(
                    "[Cool Artist] Amazing Artwork (landscape wallpaper).png"
                )),
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

        // Benchmark 2: single preset "danbooru"
        let start = Instant::now();
        let mut match_count_danbooru = 0u64;
        for f in &filenames {
            if FilenameParser::test_filename(f, "danbooru", "preset", None).is_some() {
                match_count_danbooru += 1;
            }
        }
        let elapsed_danbooru = start.elapsed();
        let throughput_danbooru = filenames.len() as f64 / elapsed_danbooru.as_secs_f64();

        // Benchmark 3: pre-compiled custom_regex (pixiv-like pattern that matches some filenames)
        // Strip extensions like test_filename does in production
        let regex_pattern = r"^(?:(?P<artist>[A-Za-z0-9_\-\s]+)_)?(?P<pixiv_id>\d{7,10})(?:_p(?P<page>\d+))?$";
        let stripped: Vec<&str> = filenames
            .iter()
            .map(|f| {
                std::path::Path::new(f)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(f)
            })
            .collect();
        let start = Instant::now();
        let mut match_count_re = 0u64;
        for f in &stripped {
            if test_regex(f, regex_pattern).is_some() {
                match_count_re += 1;
            }
        }
        let elapsed_regex = start.elapsed();
        let throughput_regex = filenames.len() as f64 / elapsed_regex.as_secs_f64();

        // Benchmark 4: token_builder (pre-compiled regex via compile_token_blocks)
        let token_config = vec![TokenBlock {
            token_type: "pixiv_id".to_string(),
            value: None,
            label: None,
            enabled: true,
            optional_prefix: None,
        }];
        let compiled_token_regex = compile_token_blocks(&token_config);
        let start = Instant::now();
        let mut match_count_tb = 0u64;
        for f in &stripped {
            if test_regex(f, &compiled_token_regex).is_some() {
                match_count_tb += 1;
            }
        }
        let elapsed_tb = start.elapsed();
        let throughput_tb = filenames.len() as f64 / elapsed_tb.as_secs_f64();

        println!("=== Filename Parser Benchmark (50,000 filenames) ===");
        println!();
        println!(
            "pixiv_id preset (single pattern, Aho-Corasick filtered):"
        );
        println!("  Time:       {:.2?}", elapsed_pixiv);
        println!("  Throughput: {:.0} files/sec", throughput_pixiv);
        println!("  Matches:    {} / {}", match_count, filenames.len());
        println!();
        println!("danbooru preset:");
        println!("  Time:       {:.2?}", elapsed_danbooru);
        println!("  Throughput: {:.0} files/sec", throughput_danbooru);
        println!(
            "  Matches:    {} / {}",
            match_count_danbooru,
            filenames.len()
        );
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
