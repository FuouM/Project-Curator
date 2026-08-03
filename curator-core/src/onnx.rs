use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use anyhow::{Context, Result};
use ort::session::Session;
use crate::ipc::DevicePreference;
use crate::vector::device::{apply_device_preference, OnnxConfig};

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub struct ManagedSession {
    name: String,
    model_path: PathBuf,
    device: Mutex<DevicePreference>,
    session: Mutex<Option<Session>>,
    last_used: AtomicU64,
    intra_threads: usize,
    config: OnnxConfig,
}

impl ManagedSession {
    pub fn new(
        name: impl Into<String>,
        model_path: PathBuf,
        device: DevicePreference,
        intra_threads: usize,
    ) -> Self {
        Self {
            name: name.into(),
            model_path,
            device: Mutex::new(device),
            session: Mutex::new(None),
            last_used: AtomicU64::new(now_secs()),
            intra_threads,
            config: OnnxConfig::default(),
        }
    }

    /// Create a new ManagedSession with custom ONNX configuration.
    pub fn with_config(
        name: impl Into<String>,
        model_path: PathBuf,
        device: DevicePreference,
        intra_threads: usize,
        config: OnnxConfig,
    ) -> Self {
        Self {
            name: name.into(),
            model_path,
            device: Mutex::new(device),
            session: Mutex::new(None),
            last_used: AtomicU64::new(now_secs()),
            intra_threads,
            config,
        }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn device(&self) -> DevicePreference {
        self.device.lock().unwrap().clone()
    }

    pub fn is_loaded(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    pub fn idle_secs(&self) -> u64 {
        now_secs().saturating_sub(self.last_used.load(Ordering::Relaxed))
    }

    pub fn unload(&self) {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            tracing::info!("{}: unloading model (idle {}s)", self.name, self.idle_secs());
            *guard = None;
        }
    }

    pub fn set_device(&self, device: DevicePreference) {
        {
            let mut d = self.device.lock().unwrap();
            *d = device.clone();
        }
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            tracing::info!(
                "{}: device changed to {:?} — unloading model for reload",
                self.name,
                device
            );
            *guard = None;
        }
    }

    pub fn load(&self) -> Result<()> {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        if !self.model_path.exists() {
            anyhow::bail!(
                "{} model file not found at {:?}",
                self.name,
                self.model_path
            );
        }

        let device = self.device.lock().unwrap().clone();
        tracing::info!(
            "Loading {} model from {:?} (device: {:?})",
            self.name,
            self.model_path,
            device
        );

        let mut builder = Session::builder()
            .context(format!("Failed to build {} session", self.name))?
            .with_intra_threads(self.intra_threads)
            .context(format!("Failed to set {} threads to {}", self.name, self.intra_threads))?;

        apply_device_preference(&mut builder, &device, &self.name, &self.config);

        let session = builder
            .commit_from_file(&self.model_path)
            .context(format!("Failed to load {} ONNX session", self.name))?;

        tracing::info!("{} ONNX session ready", self.name);
        *guard = Some(session);
        Ok(())
    }

    /// Exposes a thread-safe execution interface.
    /// Safely loads the session on demand, updates idle timestamps, and passes a reference
    /// of the underlying session to the runner closure.
    pub fn with_session<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut Session) -> Result<R>,
    {
        {
            let guard = self.session.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }

        self.last_used.store(now_secs(), Ordering::Relaxed);
        let mut guard = self.session.lock().unwrap();
        let session = guard.as_mut().context("Session not initialized")?;
        f(session)
    }

    /// Execute a closure against the session with automatic GPU→CPU fallback.
    /// If the closure returns an error and the current device is GPU,
    /// the session is reloaded on CPU and the closure retried exactly once.
    pub fn with_session_fallback<F, R>(&self, f: F) -> Result<R>
    where
        F: Fn(&mut Session) -> Result<R>,
    {
        let result = self.with_session(&f);
        if result.is_err() && self.device() != DevicePreference::Cpu {
            tracing::warn!(
                "{}: inference failed on GPU — falling back to CPU",
                self.name
            );
            self.set_device(DevicePreference::Cpu);
            return self.with_session(&f);
        }
        result
    }
}
