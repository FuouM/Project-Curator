use anyhow::{bail, Context, Result};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// Animation details for animated formats (GIF today).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnimationInfo {
    pub frame_count: u32,
    /// Raw sum of per-frame GCE delays in milliseconds (delay * 10ms).
    pub duration_ms: i64,
    /// Netscape loop count: `None` when no looping extension is present,
    /// `Some(0)` means loop forever.
    pub loop_count: Option<u16>,
}

/// Read image dimensions from the file header without decoding pixel data.
pub fn read_dimensions(path: &Path) -> Result<(u32, u32)> {
    let reader = image::ImageReader::open(path)
        .with_context(|| format!("Cannot open image {:?}", path))?;
    let (w, h) = reader
        .into_dimensions()
        .with_context(|| format!("Cannot read dimensions for {:?}", path))?;
    Ok((w, h))
}

/// True if the file is a GIF, detected by extension or magic bytes.
pub fn is_gif(path: &Path) -> bool {
    let ext_gif = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("gif"))
        .unwrap_or(false);
    if ext_gif {
        return true;
    }
    matches!(read_gif_magic(path), Ok(true))
}

fn read_gif_magic(path: &Path) -> Result<bool> {
    let mut file = File::open(path)?;
    let mut buf = [0u8; 6];
    let n = file.read(&mut buf)?;
    Ok(n == 6
        && &buf[0..3] == b"GIF"
        && (&buf[3..6] == b"87a" || &buf[3..6] == b"89a"))
}

/// Scan a GIF's block structure to extract frame count, raw duration, and
/// Netscape loop count without decoding any pixel data.
///
/// Format reference:
///   header (6) + logical screen descriptor (7) [+ global color table]
///   blocks: 0x2C image descriptor | 0x21 extension | 0x3B trailer
///   extensions: 0xF9 graphic control (4-byte payload), 0xFF application,
///               0xFE comment, 0x01 plain text; all terminated by a 0-length
///               sub-block. Image data is a stream of length-prefixed sub-blocks.
pub fn read_gif_animation(path: &Path) -> Result<AnimationInfo> {
    let file = File::open(path).with_context(|| format!("Cannot open GIF {:?}", path))?;
    let mut rd = GifReader {
        r: BufReader::new(file),
    };

    let magic = rd.read_exact::<6>()?;
    if &magic[0..3] != b"GIF" {
        bail!("{:?} is not a GIF file", path);
    }

    let lsd = rd.read_exact::<7>()?;
    let _width = u16::from_le_bytes([lsd[0], lsd[1]]);
    let _height = u16::from_le_bytes([lsd[2], lsd[3]]);
    let packed = lsd[4];
    if packed & 0x80 != 0 {
        let gct_size = 3usize << ((packed & 0x07) as usize + 1);
        rd.skip(gct_size)?;
    }

    let mut frame_count: u32 = 0;
    let mut duration_ms: i64 = 0;
    let mut loop_count: Option<u16> = None;

    loop {
        let block = rd
            .read_u8()
            .with_context(|| format!("Truncated GIF {:?}", path))?;
        match block {
            0x3B => break,
            0x2C => {
                let desc = rd.read_exact::<9>()?;
                let d_packed = desc[8];
                if d_packed & 0x80 != 0 {
                    let lct_size = 3usize << ((d_packed & 0x07) as usize + 1);
                    rd.skip(lct_size)?;
                }
                rd.read_u8()?;
                skip_sub_blocks(&mut rd)?;
                frame_count += 1;
            }
            0x21 => {
                let label = rd.read_u8()?;
                match label {
                    0xF9 => {
                        let block_size = rd.read_u8()?;
                        if block_size != 4 {
                            bail!("Malformed graphic control extension in {:?}", path);
                        }
                        let payload = rd.read_exact::<4>()?;
                        let delay = u16::from_le_bytes([payload[1], payload[2]]);
                        duration_ms += delay as i64 * 10;
                        rd.read_u8()?;
                    }
                    0xFF => {
                        let block_size = rd.read_u8()?;
                        if block_size != 11 {
                            bail!("Malformed application extension in {:?}", path);
                        }
                        let app = rd.read_exact::<11>()?;
                        let is_netscape = &app == b"NETSCAPE2.0";
                        loop {
                            let len = rd.read_u8()?;
                            if len == 0 {
                                break;
                            }
                            if is_netscape && len == 3 {
                                let data = rd.read_exact::<3>()?;
                                if data[0] == 0x01 {
                                    loop_count = Some(u16::from_le_bytes([data[1], data[2]]));
                                }
                            } else {
                                rd.skip(len as usize)?;
                            }
                        }
                    }
                    _ => skip_sub_blocks(&mut rd)?,
                }
            }
            other => bail!("Unexpected block byte 0x{other:02x} in GIF {:?}", path),
        }
    }

    Ok(AnimationInfo {
        frame_count,
        duration_ms,
        loop_count,
    })
}

struct GifReader<R: Read> {
    r: R,
}

impl<R: Read> GifReader<R> {
    fn read_exact<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut buf = [0u8; N];
        self.r
            .read_exact(&mut buf)
            .context("unexpected end of GIF stream")?;
        Ok(buf)
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_exact::<1>()?[0])
    }

    fn skip(&mut self, n: usize) -> Result<()> {
        let mut buf = vec![0u8; n];
        self.r
            .read_exact(&mut buf)
            .context("unexpected end of GIF stream")?;
        Ok(())
    }
}

fn skip_sub_blocks<R: Read>(rd: &mut GifReader<R>) -> Result<()> {
    loop {
        let len = rd.read_u8()?;
        if len == 0 {
            return Ok(());
        }
        rd.skip(len as usize)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// Build a minimal single-frame GIF with a 1x1 pixel.
    /// `delay` is in centiseconds for the GCE, `loop_ext` controls the Netscape
    /// looping extension (None = absent, Some(0) = infinite).
    fn build_gif(loop_ext: Option<u16>) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"GIF89a");
        out.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
        if let Some(repeat) = loop_ext {
            out.extend_from_slice(&[0x21, 0xFF]);
            out.push(11);
            out.extend_from_slice(b"NETSCAPE2.0");
            out.push(3);
            out.push(0x01);
            out.extend_from_slice(&repeat.to_le_bytes());
            out.push(0);
        }
        out.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00, 0x14, 0x00, 0x00, 0x00]);
        out.extend_from_slice(&[0x2C, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]);
        out.push(2);
        out.push(0x02);
        out.extend_from_slice(&[0x44, 0x01, 0x00]);
        out.push(0x3B);
        out
    }

    fn write_temp(bytes: &[u8]) -> NamedTempFile {
        let mut f = tempfile::Builder::new().suffix(".gif").tempfile().unwrap();
        f.write_all(bytes).unwrap();
        f
    }

    #[test]
    fn single_frame_no_loop() {
        let f = write_temp(&build_gif(None));
        let info = read_gif_animation(f.path()).unwrap();
        assert_eq!(info.frame_count, 1);
        assert_eq!(info.duration_ms, 200);
        assert_eq!(info.loop_count, None);
    }

    #[test]
    fn single_frame_infinite_loop() {
        let f = write_temp(&build_gif(Some(0)));
        let info = read_gif_animation(f.path()).unwrap();
        assert_eq!(info.loop_count, Some(0));
        assert_eq!(info.duration_ms, 200);
    }

    #[test]
    fn multiple_frames_sum_delays() {
        let mut gif = build_gif(Some(3));
        gif.pop(); // drop trailer, we will append more frames then trailer
        for _ in 0..2 {
            gif.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00]);
            gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]);
            gif.push(2);
            gif.push(0x02);
            gif.extend_from_slice(&[0x44, 0x01, 0x00]);
        }
        gif.push(0x3B);
        let f = write_temp(&gif);
        let info = read_gif_animation(f.path()).unwrap();
        assert_eq!(info.frame_count, 3);
        assert_eq!(info.duration_ms, 200 + 100 + 100);
        assert_eq!(info.loop_count, Some(3));
    }

    #[test]
    fn rejects_non_gif() {
        let f = write_temp(b"not a gif at all");
        assert!(read_gif_animation(f.path()).is_err());
    }

    #[test]
    fn dimensions_roundtrip() {
        let f = write_temp(&build_gif(None));
        let (w, h) = read_dimensions(f.path()).unwrap();
        assert_eq!((w, h), (1, 1));
    }
}
