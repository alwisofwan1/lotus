//! Shell-script builders for SSH editor commands.
//!
//! Every script is a single string passed to `ssh <host> "exec $SHELL -lic ..."`.
//! Inputs are quoted with [`quote_shell_arg`] so callers can safely pass
//! arbitrary path strings without breaking shell parsing.

use crate::editor_fs::MAX_EDITOR_LARGE_FILE_SIZE_BYTES;
use crate::remote_capability::StatVariant;

const MAX_LIST_DEPTH: u32 = 10;
const DEFAULT_LIST_DEPTH: u32 = 3;
const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".next",
    "out",
    "dist",
    "build",
    "target",
    ".turbo",
    ".cache",
    "coverage",
    ".git",
];

pub(super) fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A shell pipeline that prints `file_var`'s mtime in milliseconds, for the detected `stat`.
///
/// Milliseconds, not seconds times 1000: with whole seconds, someone else's save landing in the
/// same second as ours read as "unchanged", and the next save overwrote it. Local mode has had
/// millisecond mtimes all along.
///
/// - `Some(Gnu)` → `%Y` (seconds) plus the fraction of `%y` (Linux; every coreutils version has it)
/// - `Some(Bsd)` → `%Fm`, seconds with a fraction (macOS / BSDs)
/// - `None` → GNU form with BSD fallback (safe before the probe completes). awk exits 1 on no
///   input, so a `stat` that refused the GNU flags fails the pipeline and the fallback runs.
fn stat_mtime_ms_expr(file_var: &str, variant: Option<StatVariant>) -> String {
    // The fraction is padded and cut to 3 digits; the seconds are kept as text, never as an awk
    // number, which some awks print as 1.79e+12 or clamp to 32 bits.
    let to_ms = |seconds: &str, fraction: &str| {
        format!(
            "awk '{{ split({fraction}, t, \".\"); printf \"%s%s\\n\", {seconds}, substr(t[2] \"000\", 1, 3); ok = 1 }} END {{ exit !ok }}'"
        )
    };
    let gnu = format!("stat -c '%Y %y' {file_var} | {}", to_ms("$1", "$3"));
    let bsd = format!("stat -f '%Fm' {file_var} | {}", to_ms("t[1]", "$1"));
    match variant {
        Some(StatVariant::Gnu) => gnu,
        Some(StatVariant::Bsd) => bsd,
        None => format!("{{ {gnu}; }} 2>/dev/null || {bsd}"),
    }
}

/// The permission bits of `file_var` in octal, so a save can give them to its temp file.
fn stat_mode_expr(file_var: &str, variant: Option<StatVariant>) -> String {
    match variant {
        Some(StatVariant::Gnu) => format!("stat -c '%a' {file_var}"),
        Some(StatVariant::Bsd) => format!("stat -f '%Lp' {file_var}"),
        None => format!("stat -c '%a' {file_var} 2>/dev/null || stat -f '%Lp' {file_var}"),
    }
}

/// Build a remote shell script that lists entries under `remote_cwd`.
///
/// Output is a stream of `KIND\tABSOLUTE_PATH` lines, one per entry.
/// Pruned directories from `IGNORED_DIRECTORIES` are excluded with `-prune`.
pub(crate) fn build_remote_list_script(remote_cwd: &str, max_depth: Option<u32>) -> String {
    let depth = max_depth.unwrap_or(DEFAULT_LIST_DEPTH).min(MAX_LIST_DEPTH);
    let prunes = IGNORED_DIRECTORIES
        .iter()
        .map(|name| format!("-name {}", quote_shell_arg(name)))
        .collect::<Vec<_>>()
        .join(" -o ");

    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "cd \"$ROOT\"\n",
            "if git -C \"$ROOT\" rev-parse --is-inside-work-tree >/dev/null 2>&1; then\n",
            "  git -C \"$ROOT\" ls-files -co --exclude-standard | awk -v root=\"$ROOT\" '\n",
            "    function emit_dirs(path, parts, n, i, acc) {{\n",
            "      n = split(path, parts, \"/\"); acc = \"\";\n",
            "      for (i = 1; i < n; i++) {{\n",
            "        acc = acc ? acc \"/\" parts[i] : parts[i];\n",
            "        if (!(acc in seen)) {{ seen[acc] = 1; printf \"directory\\t%s/%s\\n\", root, acc; }}\n",
            "      }}\n",
            "    }}\n",
            "    NF {{ emit_dirs($0); printf \"file\\t%s/%s\\n\", root, $0; }}\n",
            "  '\n",
            "  exit 0\n",
            "fi\n",
            "find \"$ROOT\" -mindepth 1 -maxdepth {depth} \\( -type d \\( {prunes} \\) -prune \\) -o \\( -type d -printf 'directory\\t%p\\n' \\) -o \\( -type f -printf 'file\\t%p\\n' \\)",
        ),
        root = quote_shell_arg(remote_cwd),
        depth = depth,
        prunes = prunes,
    )
}

/// Build a remote shell script that reads a single file and emits an envelope
/// of metadata + base64-encoded content.
///
/// The script:
///   1. Resolves `$ROOT/$REL` via `realpath -e` and rejects results outside `$ROOT`.
///   2. A file over `max_bytes` is not sent: the envelope says `TOO_LARGE=1` (and `BINARY=1`),
///      as a local read does, so the editor can offer "Open anyway".
///   3. Marks the file as binary if a NUL byte is in its first 8 KiB, unless it starts with a
///      UTF-16 byte-order mark (UTF-16 text is full of NULs). Rust decodes the rest
///      (`editor_encoding`). The NUL test counts bytes before and after `tr -d '\000'`: the
///      old `grep -q $'\0'` was `grep -q ''` (a shell string ends at its NUL), which matches
///      any line, so every non-empty file read as binary.
///   4. Emits the envelope:
///      MTIME=<ms>
///      SIZE=<bytes>
///      BINARY=<0|1>
///      [TOO_LARGE=1]
///      ---
///      <base64 stream, possibly empty for binary>
pub(crate) fn build_remote_read_script(
    remote_cwd: &str,
    relative_path: &str,
    max_bytes: u64,
    stat_variant: Option<StatVariant>,
) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "REL={rel}\n",
            "MAX_BYTES={max}\n",
            "ABS=\"$(realpath -e -- \"$ROOT/$REL\" 2>/dev/null)\" || {{ echo NOT_FOUND >&2; exit 4; }}\n",
            "case \"$ABS\" in \"$ROOT\"|\"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "[ -f \"$ABS\" ] || {{ echo NOT_A_FILE >&2; exit 5; }}\n",
            "SIZE=$(wc -c < \"$ABS\" | tr -d ' ')\n",
            "MTIME_MS=$({stat_mtime})\n",
            "if [ \"$SIZE\" -gt \"$MAX_BYTES\" ]; then printf 'MTIME=%s\\nSIZE=%s\\nBINARY=1\\nTOO_LARGE=1\\n---\\n' \"$MTIME_MS\" \"$SIZE\"; exit 0; fi\n",
            "BOM=$(head -c 2 \"$ABS\" | od -An -tx1 | tr -d ' \\n')\n",
            "case \"$BOM\" in\n",
            "  fffe|feff) BINARY=0;;\n",
            "  *) SNIFF=$(head -c 8192 \"$ABS\" | wc -c | tr -d ' ')\n",
            "     KEPT=$(head -c 8192 \"$ABS\" | tr -d '\\000' | wc -c | tr -d ' ')\n",
            "     if [ \"$SNIFF\" = \"$KEPT\" ]; then BINARY=0; else BINARY=1; fi;;\n",
            "esac\n",
            "printf 'MTIME=%s\\nSIZE=%s\\nBINARY=%s\\n---\\n' \"$MTIME_MS\" \"$SIZE\" \"$BINARY\"\n",
            "if [ \"$BINARY\" = \"0\" ]; then base64 < \"$ABS\"; fi\n",
        ),
        root = quote_shell_arg(remote_cwd),
        rel = quote_shell_arg(relative_path),
        max = max_bytes,
        stat_mtime = stat_mtime_ms_expr("\"$ABS\"", stat_variant),
    )
}

/// Build a remote shell script that prints a file as base64, for the media viewer. Same sandbox
/// checks and exit codes as [`build_remote_read_script`], with the media size cap.
pub(crate) fn build_remote_read_bytes_script(remote_cwd: &str, relative_path: &str) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "REL={rel}\n",
            "MAX_BYTES={max}\n",
            "ABS=\"$(realpath -e -- \"$ROOT/$REL\" 2>/dev/null)\" || {{ echo NOT_FOUND >&2; exit 4; }}\n",
            "case \"$ABS\" in \"$ROOT\"|\"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "[ -f \"$ABS\" ] || {{ echo NOT_A_FILE >&2; exit 5; }}\n",
            "SIZE=$(wc -c < \"$ABS\" | tr -d ' ')\n",
            "if [ \"$SIZE\" -gt \"$MAX_BYTES\" ]; then printf 'TOO_LARGE\\n%d\\n' \"$SIZE\" >&2; exit 6; fi\n",
            "base64 < \"$ABS\"\n",
        ),
        root = quote_shell_arg(remote_cwd),
        rel = quote_shell_arg(relative_path),
        max = crate::editor_fs::MAX_EDITOR_MEDIA_SIZE_BYTES,
    )
}

/// Build a remote shell script that writes file content via stdin (base64).
///
/// Steps (single SSH round-trip):
///   1. `realpath -e` parent dir + sandbox check. A symlink is followed to its target (which
///      must be inside the root too), so the link stays a link: `mv` onto the link itself
///      replaced it with a plain file.
///   2. If `expected_mtime` is `Some` and the file exists, compare mtime (ms);
///      emit `MTIME_CONFLICT` and exit 7 on mismatch.
///   3. Decode base64 stdin into a temporary file `$ABS.lotus.tmp.$$`.
///   4. The temp file gets the target's permission bits (an executable script stays
///      executable), then `mv -f` atomically replaces the target.
///   5. Emit `NEW_MTIME=<ms>` on stdout.
///   6. `trap` on EXIT removes the temp file if anything fails mid-way.
///
/// The caller streams the base64-encoded content as stdin via
/// [`crate::cli_tools::run_ssh_shell_command_with_stdin`].
pub(crate) fn build_remote_write_script(
    remote_cwd: &str,
    relative_path: &str,
    expected_mtime: Option<i64>,
    stat_variant: Option<StatVariant>,
) -> String {
    let expected = expected_mtime.map(|m| m.to_string()).unwrap_or_default();
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "REL={rel}\n",
            "EXPECTED_MTIME={expected}\n",
            "MAX_BYTES={max}\n",
            "PARENT_REL=\"$(dirname -- \"$REL\")\"\n",
            "PARENT_ABS=\"$(realpath -e -- \"$ROOT/$PARENT_REL\" 2>/dev/null)\" || {{ echo PARENT_NOT_FOUND >&2; exit 4; }}\n",
            "case \"$PARENT_ABS\" in \"$ROOT\"|\"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "ABS=\"$PARENT_ABS/$(basename -- \"$REL\")\"\n",
            "if [ -L \"$ABS\" ]; then\n",
            "  ABS=\"$(realpath -e -- \"$ABS\" 2>/dev/null)\" || {{ echo NOT_FOUND >&2; exit 4; }}\n",
            "  case \"$ABS\" in \"$ROOT\"|\"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "fi\n",
            "if [ -e \"$ABS\" ] && [ ! -f \"$ABS\" ]; then echo NOT_A_FILE >&2; exit 5; fi\n",
            "if [ -n \"$EXPECTED_MTIME\" ] && [ -f \"$ABS\" ]; then\n",
            "  CURRENT_MS=$({stat_mtime})\n",
            "  if [ \"$CURRENT_MS\" != \"$EXPECTED_MTIME\" ]; then printf 'MTIME_CONFLICT\\n%s\\n' \"$CURRENT_MS\" >&2; exit 7; fi\n",
            "fi\n",
            "MODE=''\n",
            "if [ -f \"$ABS\" ]; then MODE=$({stat_mode}); fi\n",
            "TMP=\"$ABS.lotus.tmp.$$\"\n",
            "trap 'rm -f -- \"$TMP\"' EXIT\n",
            "base64 -d > \"$TMP\"\n",
            "WRITTEN=$(wc -c < \"$TMP\" | tr -d ' ')\n",
            "if [ \"$WRITTEN\" -gt \"$MAX_BYTES\" ]; then printf 'TOO_LARGE\\n%d\\n' \"$WRITTEN\" >&2; exit 6; fi\n",
            "if [ -n \"$MODE\" ]; then chmod \"$MODE\" \"$TMP\"; fi\n",
            "mv -f \"$TMP\" \"$ABS\"\n",
            "trap - EXIT\n",
            "printf 'NEW_MTIME=%s\\n' \"$({stat_mtime})\"\n",
        ),
        root = quote_shell_arg(remote_cwd),
        rel = quote_shell_arg(relative_path),
        expected = quote_shell_arg(&expected),
        max = MAX_EDITOR_LARGE_FILE_SIZE_BYTES,
        stat_mtime = stat_mtime_ms_expr("\"$ABS\"", stat_variant),
        stat_mode = stat_mode_expr("\"$ABS\"", stat_variant),
    )
}

/// Build a remote shell script that creates an empty file at `relative_path`.
///
/// Fails with `ALREADY_EXISTS` (exit 8) if the path is taken — `set -C` (no
/// clobber) prevents overwriting an existing file. Emits the resolved absolute
/// path as `PATH=<abs>` on success.
pub(crate) fn build_remote_create_file_script(remote_cwd: &str, relative_path: &str) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "REL={rel}\n",
            "PARENT_REL=\"$(dirname -- \"$REL\")\"\n",
            "PARENT_ABS=\"$(realpath -e -- \"$ROOT/$PARENT_REL\" 2>/dev/null)\" || {{ echo PARENT_NOT_FOUND >&2; exit 4; }}\n",
            "case \"$PARENT_ABS\" in \"$ROOT\"|\"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "ABS=\"$PARENT_ABS/$(basename -- \"$REL\")\"\n",
            "if [ -e \"$ABS\" ]; then echo ALREADY_EXISTS >&2; exit 8; fi\n",
            "( set -C; : > \"$ABS\" )\n",
            "printf 'PATH=%s\\n' \"$ABS\"\n",
        ),
        root = quote_shell_arg(remote_cwd),
        rel = quote_shell_arg(relative_path),
    )
}

/// Build a remote shell script that creates a directory at `relative_path`.
///
/// Uses `mkdir -p` so intermediate ancestors are created. Sandbox is enforced
/// by validating the *parent* via `realpath` and verifying it stays under
/// `$ROOT`. Emits `PATH=<abs>` on success.
pub(crate) fn build_remote_create_directory_script(
    remote_cwd: &str,
    relative_path: &str,
) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "REL={rel}\n",
            "PARENT_REL=\"$(dirname -- \"$REL\")\"\n",
            "PARENT_ABS=\"$(realpath -e -- \"$ROOT/$PARENT_REL\" 2>/dev/null)\" || {{ echo PARENT_NOT_FOUND >&2; exit 4; }}\n",
            "case \"$PARENT_ABS\" in \"$ROOT\"|\"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "ABS=\"$PARENT_ABS/$(basename -- \"$REL\")\"\n",
            "mkdir -p \"$ABS\"\n",
            "printf 'PATH=%s\\n' \"$ABS\"\n",
        ),
        root = quote_shell_arg(remote_cwd),
        rel = quote_shell_arg(relative_path),
    )
}

/// Build a remote shell script that deletes a file or directory at
/// `relative_path`.
///
/// The target must resolve via `realpath -e` (so it must already exist) and
/// must lie strictly under `$ROOT`. Refuses to delete `$ROOT` itself. Emits
/// `PATH=<abs>` on success.
pub(crate) fn build_remote_delete_script(remote_cwd: &str, relative_path: &str) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "REL={rel}\n",
            "ABS=\"$(realpath -e -- \"$ROOT/$REL\" 2>/dev/null)\" || {{ echo NOT_FOUND >&2; exit 4; }}\n",
            "case \"$ABS\" in \"$ROOT\") echo IS_ROOT >&2; exit 9;; \"$ROOT\"/*) ;; *) echo ESCAPE >&2; exit 2;; esac\n",
            "rm -rf -- \"$ABS\"\n",
            "printf 'PATH=%s\\n' \"$ABS\"\n",
        ),
        root = quote_shell_arg(remote_cwd),
        rel = quote_shell_arg(relative_path),
    )
}

/// Rename / move inside the root. Every path is a single-quoted argument, never spliced into a
/// double-quoted string, so `$(…)` or backticks in a name stay plain text. The source's folder and
/// the target's nearest existing folder must resolve (`pwd -P`, POSIX, no GNU `realpath`) inside
/// the root, so a symlinked folder cannot carry the entry out.
pub(crate) fn build_remote_rename_script(remote_cwd: &str, from: &str, to: &str) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "FROM_REL={from}\n",
            "TO_REL={to}\n",
            "ROOT_REAL=\"$(cd -- \"$ROOT\" && pwd -P)\" || {{ echo NOT_FOUND >&2; exit 4; }}\n",
            "FROM=\"$ROOT/$FROM_REL\"\n",
            "TO=\"$ROOT/$TO_REL\"\n",
            "if [ ! -e \"$FROM\" ] && [ ! -L \"$FROM\" ]; then printf 'NOT_FOUND: %s\\n' \"$FROM_REL\" >&2; exit 4; fi\n",
            "if [ -e \"$TO\" ] || [ -L \"$TO\" ]; then printf 'Path already exists: %s\\n' \"$TO_REL\" >&2; exit 1; fi\n",
            "inside() {{ case \"$1\" in \"$ROOT_REAL\"|\"$ROOT_REAL\"/*) return 0;; *) return 1;; esac; }}\n",
            "FROM_DIR=\"$(cd -- \"$(dirname -- \"$FROM\")\" && pwd -P)\"\n",
            "inside \"$FROM_DIR\" || {{ echo ESCAPE >&2; exit 2; }}\n",
            "D=\"$(dirname -- \"$TO\")\"\n",
            "while [ ! -d \"$D\" ]; do D=\"$(dirname -- \"$D\")\"; done\n",
            "inside \"$(cd -- \"$D\" && pwd -P)\" || {{ echo ESCAPE >&2; exit 2; }}\n",
            "mkdir -p -- \"$(dirname -- \"$TO\")\"\n",
            "mv -- \"$FROM\" \"$TO\"\n",
            "printf 'PATH=%s\\n' \"$TO\"\n",
        ),
        root = quote_shell_arg(remote_cwd),
        from = quote_shell_arg(from),
        to = quote_shell_arg(to),
    )
}

#[cfg(test)]
mod tests {
    use super::super::MAX_REMOTE_FILE_SIZE_BYTES;
    use super::*;

    #[test]
    fn list_script_pins_root_and_uses_default_depth() {
        let script = build_remote_list_script("/home/alwi/project", None);
        assert!(script.contains("ROOT='/home/alwi/project'"));
        assert!(script.contains("git -C \"$ROOT\" ls-files -co --exclude-standard"));
        assert!(script.contains("-maxdepth 3"));
        assert!(script.contains("-printf 'file\\t%p\\n'"));
        assert!(script.contains("-printf 'directory\\t%p\\n'"));
    }

    #[test]
    fn list_script_caps_depth_at_max() {
        let script = build_remote_list_script("/repo", Some(99));
        assert!(script.contains("-maxdepth 10"));
    }

    #[test]
    fn list_script_includes_all_ignored_directories_as_prunes() {
        let script = build_remote_list_script("/repo", Some(2));
        for ignored in [
            "node_modules",
            ".next",
            "out",
            "dist",
            "build",
            "target",
            ".turbo",
            ".cache",
            "coverage",
            ".git",
        ] {
            assert!(
                script.contains(&format!("-name '{ignored}'")),
                "missing prune for {ignored} in: {script}"
            );
        }
    }

    #[test]
    fn list_script_escapes_single_quote_in_root() {
        let script = build_remote_list_script("/tmp/it's mine", None);
        assert!(script.contains(r"ROOT='/tmp/it'\''s mine'"));
    }

    #[test]
    fn read_script_pins_root_and_relative() {
        let script = build_remote_read_script("/repo", "src/main.rs", MAX_REMOTE_FILE_SIZE_BYTES, None);
        assert!(script.contains("ROOT='/repo'"));
        assert!(script.contains("REL='src/main.rs'"));
    }

    #[test]
    fn read_script_enforces_size_limit_constant() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, None);
        assert!(script.contains(&format!("MAX_BYTES={MAX_REMOTE_FILE_SIZE_BYTES}")));
        assert!(script.contains("TOO_LARGE=1"));
    }

    #[test]
    fn read_script_validates_realpath_escape() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, None);
        assert!(script.contains("realpath -e"));
        assert!(script.contains("ESCAPE"));
    }

    #[test]
    fn read_script_emits_envelope_then_base64() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, None);
        assert!(script.contains("MTIME=%s"));
        assert!(script.contains("SIZE=%s"));
        assert!(script.contains("BINARY=%s"));
        assert!(script.contains("---"));
        assert!(script.contains("base64 < \"$ABS\""));
    }

    #[test]
    fn read_script_finds_nul_bytes_without_grep_and_lets_utf16_through() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, None);
        // `grep -q $'\0'` is `grep -q ''`: it matched every line, so every file read as binary.
        assert!(!script.contains("grep"));
        assert!(script.contains("tr -d '\\000'"));
        assert!(script.contains("fffe|feff) BINARY=0"));
    }

    #[test]
    fn write_script_follows_a_symlink_and_keeps_the_mode() {
        let script = build_remote_write_script("/repo", "x.sh", None, Some(StatVariant::Gnu));
        assert!(script.contains("if [ -L \"$ABS\" ]; then"));
        assert!(script.contains("MODE=$(stat -c '%a' \"$ABS\")"));
        assert!(script.contains("chmod \"$MODE\" \"$TMP\""));
    }

    #[test]
    fn read_script_skips_base64_for_binary_files() {
        let script = build_remote_read_script("/repo", "x.bin", MAX_REMOTE_FILE_SIZE_BYTES, None);
        assert!(script.contains("if [ \"$BINARY\" = \"0\" ]; then base64"));
    }

    #[test]
    fn read_script_uses_gnu_stat_when_variant_gnu() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, Some(StatVariant::Gnu));
        assert!(script.contains("stat -c '%Y %y' \"$ABS\""));
        assert!(!script.contains("stat -f"));
    }

    #[test]
    fn read_script_uses_bsd_stat_when_variant_bsd() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, Some(StatVariant::Bsd));
        assert!(script.contains("stat -f '%Fm' \"$ABS\""));
        assert!(!script.contains("stat -c"));
    }

    #[test]
    fn read_script_uses_fallback_when_variant_unknown() {
        let script = build_remote_read_script("/repo", "x.txt", MAX_REMOTE_FILE_SIZE_BYTES, None);
        assert!(script.contains("stat -c '%Y %y'"));
        assert!(script.contains("|| stat -f '%Fm'"));
    }

    #[test]
    fn write_script_pins_root_relative_and_expected_mtime() {
        let script =
            build_remote_write_script("/repo", "src/main.rs", Some(1_714_492_800_000), None);
        assert!(script.contains("ROOT='/repo'"));
        assert!(script.contains("REL='src/main.rs'"));
        assert!(script.contains("EXPECTED_MTIME='1714492800000'"));
    }

    #[test]
    fn write_script_omits_expected_mtime_when_none() {
        let script = build_remote_write_script("/repo", "src/main.rs", None, None);
        assert!(script.contains("EXPECTED_MTIME=''"));
    }

    #[test]
    fn write_script_uses_atomic_rename_via_temp() {
        let script = build_remote_write_script("/repo", "x.txt", None, None);
        assert!(script.contains("$ABS.lotus.tmp.$$"));
        assert!(script.contains("mv -f \"$TMP\" \"$ABS\""));
        assert!(script.contains("trap 'rm -f -- \"$TMP\"' EXIT"));
    }

    #[test]
    fn write_script_validates_parent_dir_realpath() {
        let script = build_remote_write_script("/repo", "deep/nested/file.txt", None, None);
        assert!(script.contains("realpath -e"));
        assert!(script.contains("PARENT_NOT_FOUND"));
        assert!(script.contains("ESCAPE"));
    }

    #[test]
    fn write_script_emits_mtime_conflict_on_mismatch() {
        let script = build_remote_write_script("/repo", "x.txt", Some(123), None);
        assert!(script.contains("MTIME_CONFLICT"));
        assert!(script.contains("CURRENT_MS=$("));
    }

    #[test]
    fn write_script_enforces_size_limit_after_decode() {
        let script = build_remote_write_script("/repo", "x.txt", None, None);
        assert!(script.contains(&format!("MAX_BYTES={MAX_EDITOR_LARGE_FILE_SIZE_BYTES}")));
        assert!(script.contains("TOO_LARGE"));
    }

    #[test]
    fn write_script_emits_new_mtime_on_stdout() {
        let script = build_remote_write_script("/repo", "x.txt", None, None);
        assert!(script.contains("printf 'NEW_MTIME=%s\\n'"));
    }

    #[test]
    fn write_script_uses_gnu_stat_for_both_current_and_new_mtime() {
        let script = build_remote_write_script("/repo", "x.txt", Some(1), Some(StatVariant::Gnu));
        let gnu = "stat -c '%Y %y' \"$ABS\"";
        assert_eq!(script.matches(gnu).count(), 2, "expected 2 GNU stat calls");
        assert!(!script.contains("stat -f"));
    }

    #[test]
    fn write_script_uses_bsd_stat_for_both_current_and_new_mtime() {
        let script = build_remote_write_script("/repo", "x.txt", Some(1), Some(StatVariant::Bsd));
        let bsd = "stat -f '%Fm' \"$ABS\"";
        assert_eq!(script.matches(bsd).count(), 2, "expected 2 BSD stat calls");
        assert!(!script.contains("stat -c"));
    }

    #[test]
    fn create_file_script_uses_no_clobber_and_rejects_existing() {
        let script = build_remote_create_file_script("/repo", "src/new.rs");
        assert!(script.contains("ROOT='/repo'"));
        assert!(script.contains("REL='src/new.rs'"));
        assert!(script.contains("ALREADY_EXISTS"));
        assert!(script.contains("set -C"));
        assert!(script.contains(": > \"$ABS\""));
        assert!(script.contains("printf 'PATH=%s\\n'"));
    }

    #[test]
    fn create_directory_script_uses_mkdir_p() {
        let script = build_remote_create_directory_script("/repo", "a/b/c");
        assert!(script.contains("mkdir -p \"$ABS\""));
        assert!(script.contains("ROOT='/repo'"));
        assert!(script.contains("REL='a/b/c'"));
        assert!(script.contains("printf 'PATH=%s\\n'"));
    }

    #[test]
    fn create_scripts_validate_parent_dir_realpath() {
        for script in [
            build_remote_create_file_script("/repo", "x"),
            build_remote_create_directory_script("/repo", "x"),
        ] {
            assert!(script.contains("realpath -e"));
            assert!(script.contains("PARENT_NOT_FOUND"));
            assert!(script.contains("ESCAPE"));
        }
    }

    #[test]
    fn delete_script_resolves_target_and_refuses_root() {
        let script = build_remote_delete_script("/repo", "junk");
        assert!(script.contains("realpath -e"));
        assert!(script.contains("NOT_FOUND"));
        assert!(script.contains("IS_ROOT"));
        assert!(script.contains("rm -rf -- \"$ABS\""));
    }

    #[test]
    fn delete_script_rejects_path_outside_root() {
        let script = build_remote_delete_script("/repo", "x");
        assert!(script.contains("ESCAPE"));
    }

    /// Runs a rename script with the local `sh`, as the remote shell would.
    fn run_rename(root: &std::path::Path, from: &str, to: &str) -> std::process::Output {
        let script = build_remote_rename_script(root.to_str().unwrap(), from, to);
        std::process::Command::new("sh").arg("-c").arg(script).output().unwrap()
    }

    #[test]
    fn rename_script_moves_the_entry_and_prints_its_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.ts"), "a").unwrap();

        let output = run_rename(dir.path(), "src/a.ts", "src/b.ts");

        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(!dir.path().join("src/a.ts").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("src/b.ts")).unwrap(), "a");
        let printed = crate::editor_fs_ssh::parse_remote_path_output(&output.stdout).unwrap();
        assert!(printed.path.ends_with("/src/b.ts"), "{}", printed.path);
    }

    #[test]
    fn rename_script_treats_shell_syntax_in_names_as_plain_text() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "a").unwrap();
        let hostile = "$(touch pwned)`touch pwned2`\"x.ts";

        let output = run_rename(dir.path(), "a.ts", hostile);

        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(dir.path().join(hostile).exists());
        assert!(!dir.path().join("pwned").exists());
        assert!(!dir.path().join("pwned2").exists());
    }

    #[test]
    fn rename_script_refuses_to_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "a").unwrap();
        std::fs::write(dir.path().join("b.ts"), "b").unwrap();

        let output = run_rename(dir.path(), "a.ts", "b.ts");

        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("already exists"));
        assert_eq!(std::fs::read_to_string(dir.path().join("b.ts")).unwrap(), "b");
        assert!(dir.path().join("a.ts").exists());
    }

    #[test]
    fn rename_script_refuses_to_move_out_through_a_symlinked_folder() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "a").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();

        let output = run_rename(dir.path(), "a.ts", "link/a.ts");

        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("ESCAPE"));
        assert!(dir.path().join("a.ts").exists());
        assert!(!outside.path().join("a.ts").exists());
    }
}
