#[cfg(windows)]
mod windows {
    use std::io;
    use std::mem::{size_of, zeroed};

    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct PtyProcessTreeGuard {
        job: Option<PtyJob>,
    }

    impl PtyProcessTreeGuard {
        pub fn for_child_process(pid: Option<u32>) -> Self {
            let job = pid.and_then(|pid| match PtyJob::create_for(pid) {
                Ok(job) => Some(job),
                Err(err) => {
                    eprintln!("[pty] Windows Job Object setup failed for pid={pid}: {err}");
                    None
                }
            });
            Self { job }
        }
    }

    struct PtyJob {
        handle: HANDLE,
    }

    unsafe impl Send for PtyJob {}
    unsafe impl Sync for PtyJob {}

    impl PtyJob {
        fn create_for(pid: u32) -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() || job == INVALID_HANDLE_VALUE {
                    return Err(io::Error::last_os_error());
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let err = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(err);
                }

                let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, FALSE, pid);
                if process.is_null() {
                    let err = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(err);
                }

                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    let err = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(err);
                }

                Ok(Self { handle: job })
            }
        }
    }

    impl Drop for PtyJob {
        fn drop(&mut self) {
            if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.handle) };
            }
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::collections::{HashMap, HashSet};
    use std::process::Command;
    use std::time::Duration;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct ProcessEntry {
        pid: i32,
        parent_pid: i32,
    }

    fn process_snapshot() -> Vec<ProcessEntry> {
        let Ok(output) = Command::new("ps").args(["-Ao", "pid=,ppid="]).output() else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                Some(ProcessEntry {
                    pid: fields.next()?.parse().ok()?,
                    parent_pid: fields.next()?.parse().ok()?,
                })
            })
            .collect()
    }

    fn process_tree(entries: &[ProcessEntry], root_pid: i32) -> Vec<(i32, usize)> {
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        for entry in entries {
            children
                .entry(entry.parent_pid)
                .or_default()
                .push(entry.pid);
        }

        let mut result = Vec::new();
        let mut seen = HashSet::from([root_pid]);
        let mut stack = vec![(root_pid, 0usize)];
        while let Some((pid, depth)) = stack.pop() {
            result.push((pid, depth));
            if let Some(direct_children) = children.get(&pid) {
                for child in direct_children {
                    if seen.insert(*child) {
                        stack.push((*child, depth + 1));
                    }
                }
            }
        }
        result.sort_unstable_by(|left, right| right.1.cmp(&left.1));
        result
    }

    fn signal_processes(processes: &[(i32, usize)], signal: i32) {
        let current_pid = std::process::id() as i32;
        for (pid, _) in processes {
            if *pid <= 1 || *pid == current_pid {
                continue;
            }
            // SAFETY: signaling a process id obtained from the OS process table
            // is safe. ESRCH/permission failures are intentionally best-effort.
            unsafe {
                libc::kill(*pid, signal);
            }
        }
    }

    /// Gracefully terminate a PTY-owned process tree, then force-kill survivors.
    /// Descendants go first so the root cannot reparent work before it is found.
    pub fn terminate_process_tree(root_pid: u32, grace: Duration) {
        let root_pid = root_pid as i32;
        if root_pid <= 1 || root_pid == std::process::id() as i32 {
            return;
        }

        let initial_tree = process_tree(&process_snapshot(), root_pid);
        signal_processes(&initial_tree, libc::SIGTERM);
        std::thread::sleep(grace);

        // Keep the initial ids after reparenting, and include children created
        // by a TERM-ignoring descendant during the grace window.
        let refreshed = process_snapshot();
        let mut survivors = initial_tree;
        let mut seen: HashSet<i32> = survivors.iter().map(|(pid, _)| *pid).collect();
        for (known_pid, _) in survivors.clone() {
            for (pid, depth) in process_tree(&refreshed, known_pid) {
                if seen.insert(pid) {
                    survivors.push((pid, depth));
                }
            }
        }
        survivors.sort_unstable_by(|left, right| right.1.cmp(&left.1));
        signal_processes(&survivors, libc::SIGKILL);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn process_tree_orders_descendants_before_the_root() {
            let entries = [
                ProcessEntry {
                    pid: 10,
                    parent_pid: 1,
                },
                ProcessEntry {
                    pid: 11,
                    parent_pid: 10,
                },
                ProcessEntry {
                    pid: 12,
                    parent_pid: 11,
                },
                ProcessEntry {
                    pid: 20,
                    parent_pid: 1,
                },
            ];

            assert_eq!(process_tree(&entries, 10), vec![(12, 2), (11, 1), (10, 0)]);
        }
    }
}

#[cfg(unix)]
pub use unix::terminate_process_tree;
#[cfg(windows)]
pub use windows::PtyProcessTreeGuard;

#[cfg(not(windows))]
pub struct PtyProcessTreeGuard;

#[cfg(not(windows))]
impl PtyProcessTreeGuard {
    pub fn for_child_process(_pid: Option<u32>) -> Self {
        Self
    }
}
