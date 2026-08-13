fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protos: Vec<String> = std::fs::read_dir("proto")?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().map_or(false, |ext| ext == "proto"))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if protos.is_empty() {
        return Err("no .proto files found in proto/".into());
    }
    tonic_build::configure()
        .compile_protos(&protos, &["proto"])?;
    Ok(())
}