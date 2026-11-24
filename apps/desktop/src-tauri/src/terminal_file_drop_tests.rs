use crate::terminal_file_drop::{safe_basename, upload_script};

#[test]
fn upload_script_uses_collision_suffix_and_never_overwrites() {
    let script = upload_script("/repo", "report.pdf", 12);
    assert!(script.contains("CAND=\"$BASE-$i$EXT\""));
    assert!(script.contains("if ln \"$TMP\" \"$DEST\""));
    assert!(!script.contains("mv -f"));
}

#[test]
fn safe_basename_rejects_paths() {
    assert!(safe_basename("ok.txt", "/x/ok.txt").is_ok());
    assert!(safe_basename("../bad.txt", "/x/bad.txt").is_err());
    assert_eq!(
        safe_basename("", "/x/fallback.txt").unwrap(),
        "fallback.txt"
    );
}
