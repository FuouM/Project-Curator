fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto");
    println!("cargo:rerun-if-changed=build.rs");
    let protos: Vec<String> = std::fs::read_dir("proto")?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "proto"))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if protos.is_empty() {
        return Err("no .proto files found in proto/".into());
    }
    tonic_build::configure()
        .compile_protos(&protos, &["proto"])?;
    Ok(())
}