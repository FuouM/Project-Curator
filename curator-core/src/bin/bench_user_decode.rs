use curator_core::image_decode::decode_rgb;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let list_file = std::env::args().nth(1).expect("usage: bench_user_decode <paths-file>");
    let content = std::fs::read_to_string(list_file)?;
    let paths: Vec<String> = content.lines().map(str::to_string).collect();

    let mut total_ms = 0.0f64;
    let mut total_px = 0u64;
    let mut n = 0u64;
    for p in &paths {
        let t0 = Instant::now();
        match decode_rgb(std::path::Path::new(p)) {
            Ok((rgb_buf, w, h)) => {
                let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;

                let target_width = 200u32;
                let target_height = ((h as f64 / w as f64) * target_width as f64).round().max(1.0) as u32;

                let t1 = Instant::now();
                let src = fast_image_resize::images::ImageRef::new(
                    w,
                    h,
                    &rgb_buf,
                    fast_image_resize::PixelType::U8x3,
                )
                .unwrap();
                let mut dst = fast_image_resize::images::Image::from_vec_u8(
                    target_width,
                    target_height,
                    vec![0u8; (target_width * target_height * 3) as usize],
                    fast_image_resize::PixelType::U8x3,
                )
                .unwrap();
                let mut resizer = fast_image_resize::Resizer::new();
                resizer.resize(&src, &mut dst, None).unwrap();
                let resize_ms = t1.elapsed().as_secs_f64() * 1000.0;

                let t2 = Instant::now();
                let encoder = webp::Encoder::from_rgb(dst.buffer(), target_width, target_height);
                let webp80 = encoder.encode(80.0);
                let encode_ms = t2.elapsed().as_secs_f64() * 1000.0;
                let size80 = webp80.len();

                let mut cfg = webp::WebPConfig::new().unwrap();
                cfg.quality = 80.0;
                cfg.method = 0;
                let t2b = Instant::now();
                let webpM0 = encoder.encode_advanced(&cfg).unwrap();
                let encode_m0_ms = t2b.elapsed().as_secs_f64() * 1000.0;
                let sizeM0 = webpM0.len();

                let mut cfg2 = webp::WebPConfig::new().unwrap();
                cfg2.quality = 75.0;
                cfg2.method = 2;
                let t2c = Instant::now();
                let webpM2 = encoder.encode_advanced(&cfg2).unwrap();
                let encode_m2_ms = t2c.elapsed().as_secs_f64() * 1000.0;
                let sizeM2 = webpM2.len();

                let t3 = Instant::now();
                let mut d2 = fast_image_resize::images::Image::from_vec_u8(
                    800,
                    800,
                    vec![0u8; 800 * 800 * 3],
                    fast_image_resize::PixelType::U8x3,
                )
                .unwrap();
                let point_opts = fast_image_resize::ResizeOptions::new()
                    .resize_alg(fast_image_resize::ResizeAlg::Nearest);
                resizer.resize(&src, &mut d2, Some(&point_opts)).unwrap();
                let mid = fast_image_resize::images::ImageRef::new(
                    800,
                    800,
                    d2.buffer(),
                    fast_image_resize::PixelType::U8x3,
                )
                .unwrap();
                let mut d3 = fast_image_resize::images::Image::from_vec_u8(
                    target_width,
                    target_height,
                    vec![0u8; (target_width * target_height * 3) as usize],
                    fast_image_resize::PixelType::U8x3,
                )
                .unwrap();
                resizer.resize(&mid, &mut d3, None).unwrap();
                let twostep_ms = t3.elapsed().as_secs_f64() * 1000.0;

                total_ms += decode_ms;
                total_px += w as u64 * h as u64;
                n += 1;
                println!(
                    "{:>6.1} dec | {:>4.1} res | {:>4.1}/{:>5}B | {:>4.1}/{:>5}B | {:>4.1}/{:>5}B | {:>5.1} 2stp | {:>6}x{:<5} {:5.2} MP  {}",
                    decode_ms, resize_ms, encode_ms, size80, encode_m0_ms, sizeM0, encode_m2_ms, sizeM2, twostep_ms, w, h, (w as f64 * h as f64) / 1e6, p
                );
            }
            Err(e) => println!("ERR {}: {:?}", p, e),
        }
    }
    if n > 0 {
        println!(
            "TOTAL {:.1} ms over {} images -> avg {:.1} ms/img ; total {:.2} MP -> {:.1} MP/s",
            total_ms,
            n,
            total_ms / n as f64,
            total_px as f64 / 1e6,
            total_px as f64 / 1e6 / (total_ms / 1000.0)
        );
    }
    Ok(())
}
