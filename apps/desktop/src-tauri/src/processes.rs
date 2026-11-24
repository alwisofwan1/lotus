use crate::no_window::NoWindow;
use crate::error::{other, AppError};
use crate::json;
use crate::models::ProcessInfo;
use crate::paths;

pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        if pid == 0 {
            return false;
        }
        // SAFETY: signal 0 only checks process existence, no side effects
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        is_process_alive_windows(pid)
    }
}

#[cfg(windows)]
fn is_process_alive_windows(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// `STILL_ACTIVE` (259) — process has not exited (`GetExitCodeProcess`); not exported in newer `windows-sys`.
    const STILL_ACTIVE: u32 = 259;

    if pid == 0 {
        return false;
    }
    // SAFETY: Win32 API per MSDN; handle closed on all paths.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        let _ = CloseHandle(handle);
        ok && code == STILL_ACTIVE
    }
}

pub fn read_procs() -> Vec<ProcessInfo> {
    let path = paths::procs_file();
    let procs: Vec<ProcessInfo> = json::read_json(&path).unwrap_or_default();
    procs
        .into_iter()
        .filter(|p| is_process_alive(p.pid))
        .collect()
}

pub fn list_processes() -> Vec<ProcessInfo> {
    read_procs()
}

pub fn kill_process(pid: u32) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::process::Command;
        let status = Command::new("kill")
            .no_window()
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(AppError::Io)?;
        if !status.success() {
            return Err(other(format!("kill({pid}) failed")));
        }
    }
    #[cfg(windows)]
    {
        use std::process::Command;
        let status = Command::new("taskkill")
            .no_window()
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(AppError::Io)?;
        if !status.success() {
            return Err(other(format!("taskkill({pid}) failed")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PIDs this high are not used on dev machines; both Unix and Windows APIs reject them.
    const NONEXISTENT_PID: u32 = 99_999_999;

    #[test]
    fn is_process_alive_false_for_nonexistent_pid() {
        assert!(!is_process_alive(NONEXISTENT_PID));
    }

    #[test]
    fn is_process_alive_false_for_pid_zero() {
        assert!(!is_process_alive(0));
    }

    #[test]
    fn kill_process_errors_for_nonexistent_pid() {
        assert!(kill_process(NONEXISTENT_PID).is_err());
    }
}
