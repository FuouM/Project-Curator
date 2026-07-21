use anyhow::Error;
use std::fs;
use std::path::Path;
use tracing::info;
use uuid::Uuid;

pub fn load_or_create_service_key<P: AsRef<Path>>(key_dir: P) -> Result<String, Error> {
    let key_dir = key_dir.as_ref();
    fs::create_dir_all(key_dir)?;

    let key_file = key_dir.join("service.key");
    if key_file.exists() {
        info!("Loading existing service key from {:?}", key_file);
        let key = fs::read_to_string(&key_file)?;
        Ok(key.trim().to_string())
    } else {
        info!("Generating new master service key...");
        let new_key = Uuid::new_v4().to_string();

        // Write the key file
        fs::write(&key_file, &new_key)?;

        // On Windows, restrict permissions to the owner if possible, or keep it standard.
        // For portability, standard write works and we warn in production.
        info!("New service key saved to {:?}", key_file);
        Ok(new_key)
    }
}
