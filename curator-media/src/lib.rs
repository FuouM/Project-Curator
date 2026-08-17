pub mod convert;
pub mod crop_cache;
pub mod decode;
pub mod gif;
pub mod media;
pub mod thumbnail;
pub mod transcode;
pub mod video;

pub use convert::{convert_images, convert_one, encode_dynamic, encode_image};
pub use crop_cache::CropCache;
pub use decode::decode_rgb;
pub use gif::{
    CreateGifOptions, GifEffectsOptions, create_gif_from_images, process_gif_effects, split_gif,
};
pub use media::{AnimationInfo, is_gif, read_dimensions, read_gif_animation, sha256_file};
pub use thumbnail::{
    THUMB_KIND_ANIMATED, THUMB_KIND_STATIC, ThumbnailCache, generate_thumbnail,
    generate_thumbnail_from_rgb, generate_video_preview,
};
pub use transcode::{
    MediaMetadata, TranscodeJobState, TranscodeOptions, TranscodeProgressMap,
    get_transcode_progress, read_media_metadata, start_transcode,
};
pub use video::{
    VIDEO_EXTENSIONS, VideoInfo, decode_path, extract_video_frame, extract_video_preview,
    frame_to_png_bytes, hash_first_frame, is_video, probe_ffmpeg_version, read_video_metadata,
    resolve_ffmpeg_path,
};

pub use image;
