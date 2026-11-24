//! High-level integration glue between the Tauri app and the bot supervisor.
//!
//! The supervisor (`supervisor.rs`) is intentionally agnostic to *where*
//! the config comes from and *which* API the bot should talk to. This
//! module composes those concerns into a single [`HostRuntimeIntegration`] that
//! Tauri commands manage as app state.
//!
//! Responsibilities:
//!   - Resolve config from `~/.lotus/telegram-bot.json`.
//!   - Resolve runtime extras (Lotus axum API URL + bearer) once at app
//!     startup so the bot subprocess inherits them via env.
//!   - Provide a small surface (`apply`, `stop`, `status`, …) that maps
//!     1:1 to the Tauri commands surface.

use std::path::PathBuf;
use std::sync::Arc;

use super::admin_client::{self, AdminClient, AdminError};
use super::config::{self, HostRuntimeConfig};
use super::keep_awake::{KeepAwake, SleepHoldState};
use super::supervisor::{ExtraEnv, HostRuntimeStatus, RealSpawner, Supervisor};

/// State managed by Tauri. Holds the supervisor + adapter-level extras
/// resolved once at startup.
pub struct HostRuntimeIntegration {
    supervisor: Arc<Supervisor>,
    api_url: Option<String>,
    api_token: Option<String>,
    config_path: PathBuf,
    /// Generated once per app run and handed to every child we spawn, so a
    /// restarted host keeps working without the settings UI re-reading anything.
    admin_secret: String,
    admin_advert_path: PathBuf,
    /// Tied to `enabled`, not to the child's health: a crashed host is still a host the
    /// operator asked to be reachable, and the machine has to be awake to run the retry.
    keep_awake: KeepAwake,
}

impl HostRuntimeIntegration {
    /// Build a production integration: real process spawner, embedded
    /// bot executable at default path. Materializes the executable if
    /// missing/stale so the first `apply()` call doesn't have to.
    pub fn build_default(
        api_url: Option<String>,
        api_token: Option<String>,
    ) -> std::io::Result<Self> {
        let executable_path = super::bundle::ensure_default()?;
        let supervisor = Supervisor::new(Box::new(RealSpawner), executable_path);
        Ok(Self {
            supervisor,
            api_url,
            api_token,
            config_path: config::default_config_path(),
            admin_secret: admin_client::generate_secret(),
            admin_advert_path: admin_client::default_advert_path(),
            keep_awake: KeepAwake::build_default(),
        })
    }

    /// Apply the disk-persisted config: if `enabled`, ensure the bot is
    /// running; if disabled, ensure it's stopped. Returns the resolved
    /// status. Idempotent — safe to call repeatedly (e.g. from a
    /// settings-saved hook).
    pub fn apply(&self) -> std::io::Result<HostRuntimeStatus> {
        let cfg = config::load(&self.config_path);
        // Before the spawn, and matching `enabled` in both directions — the phone's
        // whole session depends on this machine still being awake to answer it.
        self.log_sleep_hold(self.keep_awake.sync(cfg.enabled));
        if !cfg.enabled {
            self.supervisor.stop()?;
            return Ok(HostRuntimeStatus::Idle);
        }
        let extras = ExtraEnv {
            api_url: self.api_url.clone(),
            api_token: self.api_token.clone(),
            state_dir: Some(
                crate::paths::lotus_state_dir()
                    .to_string_lossy()
                    .into_owned(),
            ),
            admin_secret: Some(self.admin_secret.clone()),
        };
        // A runtime orphaned by an abnormal exit still holds the mobile port, and the
        // next listen would fail with EADDRINUSE — which is exactly what happened once,
        // taking the whole host down. The advert has named that pid all along.
        match super::stale::reap_stale_runtime(
            &self.admin_advert_path,
            &super::stale::RealProcessOps,
            || std::thread::sleep(std::time::Duration::from_millis(600)),
        ) {
            super::stale::Reaped::Nothing => {}
            super::stale::Reaped::Terminated { pid } => {
                eprintln!("[host-runtime] reaped orphaned runtime {pid} (SIGTERM)");
            }
            super::stale::Reaped::Killed { pid } => {
                eprintln!("[host-runtime] orphan {pid} ignored SIGTERM and was killed");
            }
        }
        // A SIGKILLed child never deletes its advert. Clearing it before the spawn
        // means the file only ever names a process that existed this run.
        if let Ok(advert) = admin_client::read_advert(&self.admin_advert_path) {
            use super::stale::ProcessOps;
            if !super::stale::RealProcessOps.is_alive(advert.pid) {
                let _ = std::fs::remove_file(&self.admin_advert_path);
            }
        }

        self.supervisor.start(&cfg, &extras)
    }

    pub fn stop(&self) -> std::io::Result<()> {
        // Nothing to stay awake for once the host is down, and a hold left behind would
        // outlive every reason it was taken.
        self.log_sleep_hold(self.keep_awake.sync(false));
        self.supervisor.stop()
    }

    /// Whether idle sleep is currently held off, for the settings surface.
    pub fn sleep_hold(&self) -> SleepHoldState {
        self.keep_awake.state()
    }

    /// One line to the dev terminal, where this app's diagnostics are meant to land.
    /// Only the states an operator would want explained — a held or released hold is
    /// the expected case and does not need announcing on every save.
    fn log_sleep_hold(&self, state: SleepHoldState) {
        match state {
            SleepHoldState::Holding | SleepHoldState::Released => {}
            SleepHoldState::Unsupported => {
                eprintln!(
                    "[host-runtime] no sleep hold on this platform — the machine will \
                     idle-sleep and the phone will lose the host with it"
                );
            }
            SleepHoldState::Failed { reason } => {
                eprintln!("[host-runtime] could not hold idle sleep off: {reason}");
            }
        }
    }

    /// Talks to the running child's loopback admin channel. Errors with
    /// `NotAdvertised` when the host is not up, which is a normal state.
    pub fn admin(&self) -> AdminClient {
        AdminClient::new(self.admin_secret.clone(), self.admin_advert_path.clone())
    }

    pub fn create_pairing_code(&self) -> Result<serde_json::Value, AdminError> {
        self.admin().create_pairing_code()
    }

    pub fn list_devices(&self) -> Result<serde_json::Value, AdminError> {
        self.admin().list_devices()
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<serde_json::Value, AdminError> {
        self.admin().revoke_device(device_id)
    }

    pub fn admin_health(&self) -> Result<serde_json::Value, AdminError> {
        self.admin().health()
    }

    pub fn status(&self) -> HostRuntimeStatus {
        self.supervisor.status()
    }

    /// Persist a config update. Does NOT auto-apply — caller can decide
    /// whether to call `apply()` or wait. Splitting the two operations
    /// keeps the UX in the settings page predictable: "Save" only
    /// saves; the user explicitly taps "Restart" to apply.
    pub fn save_config(&self, cfg: &HostRuntimeConfig) -> std::io::Result<()> {
        config::save(&self.config_path, cfg)
    }

    /// Returns the on-disk config.
    ///
    /// No redaction step any more: since 2026-08-02 this config holds no secret
    /// — the bot token is gone, and device credentials live with the host, not
    /// here (ADR-5). Add redaction back only if a secret is ever reintroduced.
    pub fn get_config(&self) -> HostRuntimeConfig {
        config::load(&self.config_path)
    }
}
