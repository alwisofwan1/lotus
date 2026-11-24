//! The implementer's tests, checked against the approved spec (FI6). A spec with acceptance
//! criteria needs a test changed or added, and a test removed or weakened is flagged for the
//! reviewer. Pure parts: the runner feeds them `git diff` output.

/// The acceptance criteria a spec names (`AC-1`, `AC-2`, …), each once, in order. Read loosely:
/// the user may edit the spec before approving it. Only its `## Acceptance criteria` section counts
/// when it has one, so design notes that mention a criterion do not add one.
pub fn spec_acs(spec: &str) -> Vec<u32> {
    named_acs(acceptance_section(spec).unwrap_or(spec))
}

/// Where the `## Acceptance criteria` section ends (the next `## ` heading, or the end), so new
/// criteria can be added to it (CoS 8). `None` when the spec has no such section.
pub fn acceptance_end(spec: &str) -> Option<usize> {
    acceptance_section(spec).map(|section| section.as_ptr() as usize - spec.as_ptr() as usize + section.len())
}

/// Criteria named outside the `## Acceptance criteria` section and not in it: in a spec the user
/// edited, most likely one added in the wrong place, which [`spec_acs`] would silently skip.
pub fn stray_acs(spec: &str) -> Vec<u32> {
    let Some(section) = acceptance_section(spec) else { return Vec::new() };
    let inside = named_acs(section);
    named_acs(spec).into_iter().filter(|ac| !inside.contains(ac)).collect()
}

fn named_acs(section: &str) -> Vec<u32> {
    let mut acs: Vec<u32> = section
        .match_indices("AC-")
        .filter_map(|(at, _)| {
            let digits: String = section[at + 3..].chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .collect();
    acs.sort_unstable();
    acs.dedup();
    acs
}

/// The `## Acceptance criteria` section, up to the next `## ` heading.
fn acceptance_section(spec: &str) -> Option<&str> {
    let start = spec.lines().scan(0, |at, line| {
        let here = *at;
        *at += line.len() + 1;
        Some((here, line))
    });
    let mut from = None;
    for (at, line) in start {
        let heading = line.trim_end();
        match from {
            None if heading.eq_ignore_ascii_case("## Acceptance criteria") => from = Some(at + line.len()),
            Some(begin) if heading.starts_with("## ") => return Some(&spec[begin..at]),
            _ => {}
        }
    }
    from.map(|begin| &spec[begin.min(spec.len())..])
}

/// A test file by the common conventions (JS/TS, Rust, Python, Go, JVM).
pub fn is_test_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let in_test_dir = ["__tests__/", "tests/", "test/", "spec/"]
        .iter()
        .any(|dir| path.starts_with(dir) || path.contains(&format!("/{dir}")));
    in_test_dir
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_test.")
        || name.starts_with("test_")
        || (name.ends_with("Test.java") || name.ends_with("Test.kt"))
}

/// What the change did to the repo's tests.
#[derive(Debug, Default, PartialEq)]
pub struct TestChanges {
    /// Test files added or changed.
    pub touched: Vec<String>,
    /// Test files deleted (or renamed to a non-test name).
    pub deleted: Vec<String>,
    /// Test files that existed and were changed; the runner reads each one's patch.
    pub changed: Vec<String>,
    /// Changed test files whose patch takes tests away, with why (see [`weakening`]).
    pub weakened: Vec<(String, String)>,
}

/// Reads `git diff --name-status <base>` and `git ls-files --others --exclude-standard`.
pub fn test_changes(name_status: &str, untracked: &str) -> TestChanges {
    let mut changes = TestChanges::default();
    for line in name_status.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        let (status, paths) = match parts.split_first() {
            Some((status, paths)) if !paths.is_empty() => (*status, paths),
            _ => continue,
        };
        match status.chars().next() {
            Some('D') if is_test_path(paths[0]) => changes.deleted.push(paths[0].to_string()),
            Some('R') | Some('C') if paths.len() == 2 => {
                let (from, to) = (paths[0], paths[1]);
                if is_test_path(to) {
                    changes.touched.push(to.to_string());
                    if is_test_path(from) {
                        changes.changed.push(to.to_string());
                    }
                } else if is_test_path(from) && status.starts_with('R') {
                    changes.deleted.push(from.to_string());
                }
            }
            Some('M') | Some('A') | Some('T') if is_test_path(paths[0]) => {
                changes.touched.push(paths[0].to_string());
                if status.starts_with('M') || status.starts_with('T') {
                    changes.changed.push(paths[0].to_string());
                }
            }
            _ => {}
        }
    }
    changes.touched.extend(untracked.lines().map(str::trim).filter(|p| is_test_path(p)).map(String::from));
    changes
}

const DECLARES: &[&str] = &[
    "it(", "it.", "test(", "test.", "#[test]", "#[tokio::test", "def test", "async def test", "func Test", "@Test",
];
const SKIPS: &[&str] = &[".skip(", ".only(", "xit(", "xtest(", "xdescribe(", "#[ignore", "@pytest.mark.skip", "t.Skip(", "@Disabled", "@Ignore"];

/// Why one test file's patch (`git diff <base> -- <file>`) weakens it, or None: fewer test
/// declarations than before, or a skip (or `.only`, which skips the rest) added.
pub fn weakening(patch: &str) -> Option<String> {
    let (mut removed, mut added, mut skipped) = (0usize, 0usize, false);
    for line in patch.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        let (sign, code) = match line.split_at_checked(1) {
            Some((sign, code)) => (sign, code.trim_start()),
            None => continue,
        };
        let declares = DECLARES.iter().any(|d| code.starts_with(d));
        match sign {
            "-" if declares => removed += 1,
            "+" => {
                added += usize::from(declares);
                skipped |= SKIPS.iter().any(|s| code.contains(s));
            }
            _ => {}
        }
    }
    let mut why = Vec::new();
    if removed > added {
        let n = removed - added;
        why.push(format!("{n} test{} fewer", if n == 1 { "" } else { "s" }));
    }
    if skipped {
        why.push("a test skipped or narrowed (skip / only / ignore)".to_string());
    }
    (!why.is_empty()).then(|| why.join(", "))
}

/// The ACs the agent's summary does not name.
pub fn unmapped(acs: &[u32], summary: &str) -> Vec<u32> {
    let named = spec_acs(summary);
    acs.iter().copied().filter(|ac| !named.contains(ac)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acs_are_read_from_rendered_and_edited_specs() {
        let spec = "## Acceptance criteria\n1. **AC-1** Copy\n2. **AC-2** Toast\n- AC-2 again\n- AC-10 added by the user";
        assert_eq!(spec_acs(spec), vec![1, 2, 10]);
        assert!(spec_acs("# Spec with no criteria").is_empty());
        assert!(spec_acs("AC- with no number").is_empty());
        let with_notes = "## Acceptance criteria\n1. **AC-1** Copy\n\n## Files\n\n- a.ts\n\n## Design notes\n\nLater, AC-7 could cover rich text.";
        assert_eq!(spec_acs(with_notes), vec![1], "a criterion named outside its section is not one");
        assert_eq!(stray_acs(with_notes), vec![7]);
        assert!(stray_acs("## Acceptance criteria\n1. **AC-1** Copy\n\n## Test plan\n\n- AC-1: unit test").is_empty());
        assert!(stray_acs("AC-3 with no section").is_empty(), "without a section every criterion counts");
    }

    #[test]
    fn test_paths_by_convention() {
        for p in ["src/a.test.ts", "src/__tests__/A.tsx", "tests/factory.rs", "crates/x/tests/y.rs", "a_test.go", "test_a.py", "FooTest.java", "e2e/x.spec.ts"] {
            assert!(is_test_path(p), "{p}");
        }
        for p in ["src/a.ts", "src/latest.rs", "contest/a.rs", "README.md"] {
            assert!(!is_test_path(p), "{p}");
        }
    }

    #[test]
    fn changes_sort_touched_and_deleted_tests() {
        let status = "M\tsrc/a.ts\nM\tsrc/a.test.ts\nA\tsrc/b.test.ts\nD\tsrc/old.test.ts\nD\tsrc/gone.ts\nR100\tsrc/c.test.ts\tsrc/c.ts\n";
        let c = test_changes(status, "src/new.test.ts\nnotes.md\n");
        assert_eq!(c.touched, vec!["src/a.test.ts", "src/b.test.ts", "src/new.test.ts"]);
        assert_eq!(c.deleted, vec!["src/old.test.ts", "src/c.test.ts"]);
        assert_eq!(c.changed, vec!["src/a.test.ts"]);
        assert_eq!(test_changes("M\tsrc/a.ts\n", ""), TestChanges::default());
    }

    #[test]
    fn a_patch_that_takes_tests_away_is_weakening() {
        let fewer = "--- a/x.test.ts\n+++ b/x.test.ts\n@@\n-  it(\"copies\", () => {\n-    expect(a).toBe(1);\n-  });\n   it(\"keeps\", () => {});\n";
        assert_eq!(weakening(fewer).as_deref(), Some("1 test fewer"));
        let skipped = "@@\n-  it(\"copies\", () => {\n+  it.skip(\"copies\", () => {\n";
        assert_eq!(weakening(skipped).as_deref(), Some("a test skipped or narrowed (skip / only / ignore)"));
        let renamed = "@@\n-#[test]\n-fn old() {}\n+#[test]\n+fn new() {}\n";
        assert_eq!(weakening(renamed), None);
        let more = "@@\n+  it(\"also\", () => {});\n";
        assert_eq!(weakening(more), None);
    }

    #[test]
    fn unmapped_acs_are_the_ones_the_summary_does_not_name() {
        assert_eq!(unmapped(&[1, 2, 3], "Tests per AC:\nAC-1: a.test.ts — copies\nAC-3: a.test.ts — toast"), vec![2]);
        assert!(unmapped(&[], "anything").is_empty());
    }
}
