pub mod decode;
pub mod thumbnail;
pub mod crop_cache;
pub mod video;
pub mod media;
pub mod convert;
pub mod transcode;
pub mod gif;

pub use decode::decode_rgb;
pub use crop_cache::CropCache;
pub use media::{is_gif, read_dimensions, read_gif_animation, sha256_file, AnimationInfo};
pub use thumbnail::{
    generate_thumbnail, generate_thumbnail_from_rgb, generate_video_preview, ThumbnailCache,
    THUMB_KIND_ANIMATED, THUMB_KIND_STATIC,
};
pub use video::{
    decode_path, extract_video_frame, extract_video_preview, frame_to_png_bytes, hash_first_frame,
    is_video, probe_ffmpeg_version, read_video_metadata, resolve_ffmpeg_path, VideoInfo,
    VIDEO_EXTENSIONS,
};
pub use convert::{convert_images, convert_one, encode_dynamic, encode_image};
pub use transcode::{
    get_transcode_progress, read_media_metadata, start_transcode, MediaMetadata,
    TranscodeJobState, TranscodeOptions, TranscodeProgressMap,
};
pub use gif::{
    create_gif_from_images, process_gif_effects, split_gif, CreateGifOptions, GifEffectsOptions,
};

pub use image;