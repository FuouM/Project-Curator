use std::path::PathBuf;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;
use tonic::transport::server::Connected;
use hyper_util::rt::tokio::TokioIo;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[cfg(target_os = "windows")]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
#[cfg(not(target_os = "windows"))]
use tokio::net::{UnixListener, UnixStream};

#[cfg(target_os = "windows")]
pub const WINDOWS_PIPE_NAME: &str = r"\\.\pipe\curator_ipc";

pub fn get_uds_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".curator").join("curator.sock")
}

/// Establish connection to local Curator Service over Named Pipe (Windows) or UDS (macOS/Linux)
pub async fn connect_ipc() -> Result<Channel, tonic::transport::Error> {
    let endpoint = Endpoint::from_static("http://[::]:50051");

    #[cfg(target_os = "windows")]
    {
        endpoint.connect_with_connector(service_fn(move |_: Uri| async move {
            let client = ClientOptions::new().open(WINDOWS_PIPE_NAME)?;
            Ok::<_, std::io::Error>(TokioIo::new(client))
        })).await
    }

    #[cfg(not(target_os = "windows"))]
    {
        let socket_path = get_uds_path();
        endpoint.connect_with_connector(service_fn(move |_: Uri| async move {
            let stream = UnixStream::connect(&socket_path).await?;
            Ok::<_, std::io::Error>(TokioIo::new(stream))
        })).await
    }
}

/// A wrapper to implement tonic's `Connected` trait for local IPC streams
#[derive(Debug)]
pub struct IpcStream<T> {
    pub inner: T,
}

impl<T: AsyncRead + Unpin> AsyncRead for IpcStream<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for IpcStream<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl<T: Send + Sync + 'static> Connected for IpcStream<T> {
    type ConnectInfo = ();
    fn connect_info(&self) -> Self::ConnectInfo {
        ()
    }
}

/// Incoming connections stream for the gRPC Server
#[cfg(target_os = "windows")]
pub fn server_incoming() -> Result<impl tokio_stream::Stream<Item = Result<IpcStream<NamedPipeServer>, std::io::Error>> + Send + 'static, std::io::Error> {
    let stream = async_stream::try_stream! {
        let mut is_first = true;
        loop {
            let server = ServerOptions::new()
                .first_pipe_instance(is_first)
                .create(WINDOWS_PIPE_NAME)?;
            is_first = false;
            server.connect().await?;
            yield IpcStream { inner: server };
        }
    };
    Ok(stream)
}

/// Incoming UDS connections stream for the gRPC Server
#[cfg(not(target_os = "windows"))]
pub fn server_incoming() -> Result<impl tokio_stream::Stream<Item = Result<IpcStream<UnixStream>, std::io::Error>> + Send + 'static, std::io::Error> {
    let socket_path = get_uds_path();
    if let Some(parent) = socket_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    
    let stream = async_stream::try_stream! {
        loop {
            let (stream, _) = listener.accept().await?;
            yield IpcStream { inner: stream };
        }
    };
    Ok(stream)
}
