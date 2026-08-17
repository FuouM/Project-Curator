//! Media pipeline commands for plugins (`GetTranscodeProgress`,
//! `GetMediaMetadata`, `TranscodeVideo`, `CreateGifFromImages`,
//! `ProcessGifEffects`, `SplitGif`, `EphemeralConvertImages`).
//!
//! All heavy lifting is delegated to `curator_core::{transcode,gif,convert}`;
//! these handlers only parse parameters, resolve paths, and marshal JSON.

use std::sync::Arc;
use tonic::Status;

use crate::ClientContext;
use crate::handlers;

pub async fn get_transcode_progress(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing job_id"))?;
    let progress =
        curator_core::transcode::get_transcode_progress(job_id, &ctx.transcode_progress).await;
    Ok(serde_json::json!({
        "TranscodeProgressResult": {
            "running": progress.running,
            "percent": progress.percent,
            "fps": progress.fps,
            "x_speed": progress.x_speed,
            "out_time_ms": progress.out_time_ms,
            "output_path": progress.output_path,
            "error": progress.error,
            "command": progress.command,
            "input_size_bytes": progress.input_size_bytes,
            "output_size_bytes": progress.output_size_bytes,
            "output_video_size_bytes": progress.output_video_size_bytes,
            "output_audio_size_bytes": progress.output_audio_size_bytes,
        }
    }))
}

pub async fn media_transform(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"].as_str().unwrap_or_default();
    let input_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["input_path"].as_str().unwrap_or_default(),
    );
    let output_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["output_path"].as_str().unwrap_or_default(),
    );
    let target_format = params["target_format"].as_str().map(|s| s.to_string());
    let video_filters = params["video_filters"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let custom_args = params["custom_args"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
        .await
        .map_err(crate::server::internal_status)?;

    if let Err(e) = curator_core::transcode::start_media_transform(
        job_id,
        &input_path,
        &output_path,
        target_format.as_deref(),
        video_filters,
        custom_args,
        &ffmpeg,
        &ctx.transcode_progress,
    )
    .await
    {
        return Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        }));
    }
    Ok(serde_json::json!("Success"))
}

pub async fn get_media_metadata(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let resolved = handlers::resolve_relative_path(&ctx.data_dir, path);
    match handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings).await {
        Ok(ffmpeg) => {
            match curator_core::transcode::read_media_metadata(
                std::path::Path::new(&resolved),
                &ffmpeg,
            ) {
                Ok(meta) => Ok(serde_json::json!({
                    "MediaMetadataResult": {
                        "duration_ms": meta.duration_ms,
                        "fps": meta.fps,
                        "total_frames": meta.total_frames,
                    }
                })),
                Err(e) => Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                })),
            }
        }
        Err(e) => Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        })),
    }
}

pub async fn ephemeral_convert_images(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let quality = params["quality"].as_u64().unwrap_or(80) as u8;
    let max_dimension = params["max_dimension"].as_u64().map(|v| v as u32);
    let max_bytes = params["max_bytes"].as_u64();
    let conversions_array = params["conversions"]
        .as_array()
        .ok_or_else(|| Status::invalid_argument("missing conversions"))?;
    let mut conversions = Vec::new();
    for item in conversions_array {
        if let (Some(src), Some(dst)) = (item[0].as_str(), item[1].as_str()) {
            let resolved_src = handlers::resolve_relative_path(&ctx.data_dir, src);
            let resolved_dst = handlers::resolve_relative_path(&ctx.data_dir, dst);
            conversions.push((resolved_src, resolved_dst));
        }
    }
    let converted =
        curator_core::convert::convert_images(conversions, quality, max_dimension, max_bytes)
            .await
            .map_err(crate::server::internal_status)?;
    let converted_json: Vec<serde_json::Value> = converted
        .into_iter()
        .map(|c| {
            serde_json::json!({
                "source_path": c.source_path,
                "output_path": c.output_path,
                "error": c.error,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "ConvertImagesResult": {
            "converted": converted_json
        }
    }))
}

pub async fn transcode_video(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"].as_str().unwrap_or_default();
    let input_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["input_path"].as_str().unwrap_or_default(),
    );
    let output_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["output_path"].as_str().unwrap_or_default(),
    );
    let target_format = params["target_format"].as_str().unwrap_or_default();
    let vcodec = params["vcodec"].as_str().map(|s| s.to_string());
    let acodec = params["acodec"].as_str().map(|s| s.to_string());
    let crf = params["crf"].as_u64().map(|v| v as u32);
    let video_bitrate = params["video_bitrate"].as_u64().map(|v| v as u32);
    let preset = params["preset"].as_str().map(|s| s.to_string());
    let target_size_mb = params["target_size_mb"].as_f64();
    let audio_bitrate = params["audio_bitrate"].as_u64().map(|v| v as u32);
    let mixdown = params["mixdown"].as_str().map(|s| s.to_string());
    let sample_rate = params["sample_rate"].as_u64().map(|v| v as u32);
    let custom_args = params["custom_args"].as_str().map(|s| s.to_string());

    let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
        .await
        .map_err(crate::server::internal_status)?;

    let opts = curator_core::transcode::TranscodeOptions {
        vcodec,
        acodec,
        crf,
        video_bitrate,
        preset,
        target_size_mb,
        audio_bitrate,
        mixdown,
        sample_rate,
        custom_args,
    };

    if let Err(e) = curator_core::transcode::start_transcode(
        job_id,
        &input_path,
        &output_path,
        target_format,
        opts,
        &ffmpeg,
        &ctx.transcode_progress,
    )
    .await
    {
        return Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        }));
    }
    Ok(serde_json::json!("Success"))
}

pub async fn create_gif_from_images(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"].as_str().unwrap_or_default();
    let image_pattern = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["image_pattern"].as_str().unwrap_or_default(),
    );
    let frame_rate = params["frame_rate"].as_f64().unwrap_or(10.0) as f32;
    let output_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["output_path"].as_str().unwrap_or_default(),
    );
    let width = params["width"].as_u64().map(|v| v as u32);
    let height = params["height"].as_u64().map(|v| v as u32);
    let loop_count = params["loop_count"].as_i64().map(|v| v as i32);
    let target_format = params["target_format"].as_str().unwrap_or("gif");

    let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
        .await
        .map_err(crate::server::internal_status)?;

    let opts = curator_core::gif::CreateGifOptions {
        frame_rate: Some(frame_rate),
        width,
        height,
        loop_count,
    };

    if let Err(e) = curator_core::gif::create_gif_from_images(
        job_id.to_string(),
        image_pattern,
        output_path,
        target_format.to_string(),
        opts,
        &ffmpeg,
        &ctx.transcode_progress,
    )
    .await
    {
        return Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        }));
    }
    Ok(serde_json::json!("Success"))
}

pub async fn process_gif_effects(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"].as_str().unwrap_or_default();
    let input_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["input_path"].as_str().unwrap_or_default(),
    );
    let output_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["output_path"].as_str().unwrap_or_default(),
    );
    let crop = params["crop"].as_str().map(|s| s.to_string());
    let scale = params["scale"].as_str().map(|s| s.to_string());
    let speed_multiplier = params["speed_multiplier"].as_f64().map(|v| v as f32);
    let reverse = params["reverse"].as_bool().unwrap_or(false);
    let bounce = params["bounce"].as_bool().unwrap_or(false);
    let rotate = params["rotate"].as_str().map(|s| s.to_string());
    let brightness = params["brightness"].as_f64().map(|v| v as f32);
    let contrast = params["contrast"].as_f64().map(|v| v as f32);
    let saturation = params["saturation"].as_f64().map(|v| v as f32);
    let grayscale = params["grayscale"].as_bool().unwrap_or(false);
    let invert = params["invert"].as_bool().unwrap_or(false);
    let caption_image_base64 = params["caption_image_base64"]
        .as_str()
        .map(|s| s.to_string());
    let caption_image_height = params["caption_image_height"].as_u64().map(|v| v as u32);
    let caption_style = params["caption_style"].as_str().map(|s| s.to_string());
    let max_colors = params["max_colors"].as_u64().map(|v| v as u32);
    let dither_type = params["dither_type"].as_str().map(|s| s.to_string());
    let drop_frames_factor = params["drop_frames_factor"].as_u64().map(|v| v as u32);
    let target_format = params["target_format"].as_str().unwrap_or("gif");
    let loop_count = params["loop_count"].as_i64().map(|v| v as i32);
    let fps = params["fps"].as_u64().map(|v| v as u32);
    let trim_start = params["trim_start"].as_f64();
    let trim_end = params["trim_end"].as_f64();

    let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
        .await
        .map_err(crate::server::internal_status)?;

    let opts = curator_core::gif::GifEffectsOptions {
        crop,
        scale,
        speed_multiplier,
        reverse,
        bounce,
        rotate,
        brightness,
        contrast,
        saturation,
        grayscale,
        invert,
        caption_image_base64,
        caption_image_height,
        caption_style,
        max_colors,
        dither_type,
        drop_frames_factor,
        loop_count,
        fps,
        trim_start,
        trim_end,
    };

    if let Err(e) = curator_core::gif::process_gif_effects(
        job_id.to_string(),
        input_path,
        output_path,
        target_format.to_string(),
        opts,
        &ffmpeg,
        &ctx.transcode_progress,
    )
    .await
    {
        return Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        }));
    }
    Ok(serde_json::json!("Success"))
}

pub async fn split_gif(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"].as_str().unwrap_or_default();
    let input_path = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["input_path"].as_str().unwrap_or_default(),
    );
    let output_dir = handlers::resolve_relative_path(
        &ctx.data_dir,
        params["output_dir"].as_str().unwrap_or_default(),
    );

    let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
        .await
        .map_err(crate::server::internal_status)?;

    if let Err(e) = curator_core::gif::split_gif(
        job_id.to_string(),
        input_path,
        output_dir,
        &ffmpeg,
        &ctx.transcode_progress,
    )
    .await
    {
        return Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        }));
    }
    Ok(serde_json::json!("Success"))
}
