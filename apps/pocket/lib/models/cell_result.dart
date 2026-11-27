/// Git reports actual changes, including untracked files (`contract/README.md`).
class CellResult {
  const CellResult({
    required this.paneId,
    required this.cwd,
    required this.closing,
    required this.changes,
    required this.reason,
  });

  final String paneId;

  /// Null when the fleet knows no directory for this pane — then [reason] is `no_cwd`.
  final String? cwd;

  /// The last `stop` body as the desktop kept it; null on a host with no ring.
  final ClosingWords? closing;

  /// Null with a [reason] whenever the tree could not be asked. **Not** an empty list:
  /// "nothing changed" and "not knowable here" are different sentences on screen.
  final CellChanges? changes;

  /// `no_cwd` · `not_a_repo` · `git_failed`, or null when [changes] is present.
  final String? reason;

  bool get knowsChanges => changes != null;

  factory CellResult.fromJson(Map<String, Object?> json) => CellResult(
        paneId: json['paneId']! as String,
        cwd: json['cwd'] as String?,
        closing: switch (json['closing']) {
          final Map<String, Object?> c => ClosingWords.fromJson(c),
          _ => null,
        },
        changes: switch (json['changes']) {
          final Map<String, Object?> c => CellChanges.fromJson(c),
          _ => null,
        },
        reason: json['reason'] as String?,
      );
}

class ClosingWords {
  const ClosingWords({required this.text, required this.truncated, required this.at});

  final String text;
  final bool truncated;
  final DateTime at;

  factory ClosingWords.fromJson(Map<String, Object?> json) => ClosingWords(
        text: json['text']! as String,
        truncated: json['truncated'] as bool? ?? false,
        at: DateTime.fromMillisecondsSinceEpoch(json['at']! as int),
      );
}

class CellChanges {
  const CellChanges({required this.files, required this.added, required this.removed});

  final List<ChangedPath> files;

  /// Totals over the files git could measure; binaries and unmeasured untracked files
  /// are in [files] with null stats and skipped here.
  final int added;
  final int removed;

  factory CellChanges.fromJson(Map<String, Object?> json) => CellChanges(
        files: (json['files']! as List<Object?>)
            .whereType<Map<String, Object?>>()
            .map(ChangedPath.fromJson)
            .toList(growable: false),
        added: json['added']! as int,
        removed: json['removed']! as int,
      );
}

class ChangedPath {
  const ChangedPath({required this.path, required this.status, this.added, this.removed});

  final String path;

  /// `modified` · `added` · `deleted` · `renamed` · `untracked` — an open string, so a
  /// newer host can name a state this app has no word for yet without breaking it.
  final String status;

  /// Null for a binary, or an untracked file past the host's measuring cap — never 0.
  final int? added;
  final int? removed;

  bool get measured => added != null || removed != null;

  factory ChangedPath.fromJson(Map<String, Object?> json) => ChangedPath(
        path: json['path']! as String,
        status: json['status'] as String? ?? 'modified',
        added: json['added'] as int?,
        removed: json['removed'] as int?,
      );
}

/// `GET /m/cell/:paneId/diff?file=` — one file's unified diff against `HEAD`.
class CellDiff {
  const CellDiff({required this.paneId, required this.file, required this.diff, required this.truncated});

  final String paneId;
  final String file;
  final String diff;

  /// The host caps a diff at 64 KiB; past that the rest is on the machine.
  final bool truncated;

  factory CellDiff.fromJson(Map<String, Object?> json) => CellDiff(
        paneId: json['paneId']! as String,
        file: json['file']! as String,
        diff: json['diff']! as String,
        truncated: json['truncated'] as bool? ?? false,
      );
}
