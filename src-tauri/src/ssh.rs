//! SSH tunnels: a local listener on 127.0.0.1 whose connections are forwarded
//! through an SSH server (`direct-tcpip`) to the database host. Postgres and
//! Redis then connect to the local port as if the database were local.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::store::ConnectionConfig;

struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    // Bastions are added by the user who owns them; like the TLS "prefer"
    // mode, host keys are accepted without a known_hosts check.
    async fn check_server_key(&mut self, _key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct Tunnel {
    pub local_port: u16,
    handle: Arc<Handle<Client>>,
    accept_task: JoinHandle<()>,
}

impl Tunnel {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed() || self.accept_task.is_finished()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

fn ssh_err(stage: &str, e: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("SSH {stage} failed: {e}"))
}

fn expand_home(path: &str) -> String {
    match (path.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

pub async fn open(cfg: &ConnectionConfig) -> AppResult<Tunnel> {
    let target_host = if cfg.host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        cfg.host.clone()
    };
    let target_port = if cfg.port != 0 {
        cfg.port
    } else if cfg.kind == "redis" {
        6379
    } else {
        5432
    };
    let ssh_port = if cfg.ssh_port == 0 { 22 } else { cfg.ssh_port };
    if cfg.ssh_host.trim().is_empty() {
        return Err(AppError::msg("Enter the SSH host to tunnel through."));
    }

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let mut handle = tokio::time::timeout(
        Duration::from_secs(10),
        client::connect(config, (cfg.ssh_host.trim(), ssh_port), Client),
    )
    .await
    .map_err(|_| AppError::msg(format!("Timed out connecting to SSH host {}:{ssh_port}.", cfg.ssh_host)))?
    .map_err(|e| ssh_err("connection", e))?;

    let user = if cfg.ssh_user.is_empty() {
        "root".to_string()
    } else {
        cfg.ssh_user.clone()
    };
    let authenticated = if !cfg.ssh_key_path.trim().is_empty() {
        let passphrase = (!cfg.ssh_passphrase.is_empty()).then_some(cfg.ssh_passphrase.as_str());
        let key =
            load_secret_key(expand_home(cfg.ssh_key_path.trim()), passphrase).map_err(|e| ssh_err("private key", e))?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| ssh_err("negotiation", e))?
            .flatten();
        handle
            .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| ssh_err("authentication", e))?
            .success()
    } else {
        handle
            .authenticate_password(user.clone(), cfg.ssh_password.clone())
            .await
            .map_err(|e| ssh_err("authentication", e))?
            .success()
    };
    if !authenticated {
        return Err(AppError::msg(format!(
            "SSH server rejected the credentials for user “{user}”."
        )));
    }

    // Prove the forward works before handing the port out, so a refused
    // target surfaces as a clear error instead of a database timeout.
    handle
        .channel_open_direct_tcpip(target_host.clone(), target_port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| ssh_err(&format!("forwarding to {target_host}:{target_port}"), e))?
        .close()
        .await
        .ok();

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let handle = Arc::new(handle);
    let h = handle.clone();
    let accept_task = tokio::spawn(async move {
        while let Ok((mut socket, peer)) = listener.accept().await {
            let h = h.clone();
            let host = target_host.clone();
            tokio::spawn(async move {
                let channel = match h
                    .channel_open_direct_tcpip(host, target_port as u32, peer.ip().to_string(), peer.port() as u32)
                    .await
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });
    Ok(Tunnel {
        local_port,
        handle,
        accept_task,
    })
}

/// The config the database driver should use: same credentials, local endpoint.
pub fn rewrite(cfg: &ConnectionConfig, tunnel: &Tunnel) -> ConnectionConfig {
    let mut c = cfg.clone();
    c.host = "127.0.0.1".into();
    c.port = tunnel.local_port;
    // The certificate names the real host, not 127.0.0.1.
    if c.ssl_mode == "verify-full" {
        c.ssl_mode = "require".into();
    }
    c
}
