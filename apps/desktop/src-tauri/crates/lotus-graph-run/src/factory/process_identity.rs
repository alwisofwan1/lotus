//! Kernel birth identity, never argv/environment. Persisted PIDs are evidence, not kill authority.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start: String,
}
#[derive(Debug, PartialEq)]
pub enum ProcessState {
    Matching,
    Reused,
    Gone,
    Unknown,
}
impl ProcessIdentity {
    pub fn capture(pid: u32) -> Result<Self, String> {
        probe(pid)
            .ok()
            .flatten()
            .ok_or("Cannot establish process birth identity".into())
    }
    pub fn state(&self) -> ProcessState {
        match probe(self.pid) {
            Ok(Some(current)) if current == *self => ProcessState::Matching,
            Ok(Some(_)) => ProcessState::Reused,
            Ok(None) => ProcessState::Gone,
            Err(_) => ProcessState::Unknown,
        }
    }
}
fn probe(pid: u32) -> Result<Option<ProcessIdentity>, ()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        let read = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size as i32,
            )
        };
        if read == size as i32 && info.pbi_start_tvsec != 0 {
            let mut boot = [0u8; 128];
            let mut len = boot.len();
            let result = unsafe {
                libc::sysctlbyname(
                    b"kern.bootsessionuuid\0".as_ptr().cast(),
                    boot.as_mut_ptr().cast(),
                    &mut len,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if result != 0 || len == 0 || len > boot.len() {
                return Err(());
            }
            let boot = std::str::from_utf8(&boot[..len])
                .map_err(|_| ())?
                .trim_end_matches('\0');
            return Ok(Some(ProcessIdentity {
                pid,
                start: format!("{boot}:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
            }));
        }
        if unsafe { libc::kill(pid as i32, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(None);
        }
        return Err(());
    }
    #[cfg(target_os = "linux")]
    {
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if unsafe { libc::kill(pid as i32, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    return Ok(None);
                }
                return Err(());
            }
            Err(_) => return Err(()),
        };
        let fields = stat.get(stat.rfind(')').ok_or(())? + 1..).ok_or(())?;
        let ticks = fields
            .split_whitespace()
            .nth(19)
            .filter(|v| v.bytes().all(|b| b.is_ascii_digit()))
            .ok_or(())?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|_| ())?;
        return Ok(Some(ProcessIdentity {
            pid,
            start: format!("{}:{ticks}", boot.trim()),
        }));
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(())
    }
}
