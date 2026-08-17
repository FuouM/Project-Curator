use curator_core::thumbnail::generate_thumbnail;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let list_file = std::env::args()
        .nth(1)
        .expect("usage: bench_thumb <paths-file>");
    let content = std::fs::read_to_string(list_file)?;
    let paths: Vec<String> = content.lines().map(str::to_string).collect();

    let mut total = 0.0f64;
    let mut n = 0u64;
    let mut total_bytes = 0u64;
    for p in &paths {
        let t0 = Instant::now();
        match generate_thumbnail(std::path::Path::new(p), 200) {
            Ok(bytes) => {
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                total += ms;
                total_bytes += bytes.len() as u64;
                n += 1;
                println!("{:>8.2} ms {:>6}B  {}", ms, bytes.len(), p);
            }
            Err(e) => println!("ERR {}: {:?}", p, e),
        }
    }
    if n > 0 {
        println!(
            "TOTAL {:.1} ms, avg {:.1} ms/thumb, avg {:.1} B/thumb, {:.2} KB/img-sum over {}",
            total,
            total / n as f64,
            total_bytes as f64 / n as f64,
            total_bytes as f64 / 1024.0 / n as f64,
            n
        );
    }
    Ok(())
}
