part of 'host_api.dart';

/// The reads Chat is built on past the transcript itself, split from `host_api.dart` at
/// the 300-line mark. A `part`, not a second client: they share `_authed` and `_uri`
/// with every mutation, and two clients that each classified HTTP statuses would drift.
extension HostApiReads on HostApi {
  /// What the cell is asking, and the answers it offers — read from the terminal, so
  /// the digits are the printed ones rather than positions (ADR-8).
  Future<PermissionSnapshot> permission(String paneId) async =>
      PermissionSnapshot.fromJson(await _authed('GET', _uri(['m', 'cell', paneId, 'permission'])));

  /// Use the host-derived conversation so seed and live part IDs agree.
  Future<ConversationPage> conversation(String paneId, {int? before, int? limit}) async =>
      ConversationPage.fromJson(await _authed(
        'GET',
        _uri(['m', 'cell', paneId, 'conversation'], query: {
          if (before != null) 'before': '$before',
          if (limit != null) 'limit': '$limit',
        }),
      ));

  /// What the agent left behind: git's view of the pane's directory (`result`).
  Future<CellResult> result(String paneId) async =>
      CellResult.fromJson(await _authed('GET', _uri(['m', 'cell', paneId, 'result'])));

  /// One file's diff against HEAD. [file] is relative to the pane's directory; the host
  /// refuses anything that could climb out of it (400 → [HostRejected]).
  Future<CellDiff> diff(String paneId, String file) async => CellDiff.fromJson(
      await _authed('GET', _uri(['m', 'cell', paneId, 'diff'], query: {'file': file})));

  /// `GET /m/projects/clone/:taskId` — where a clone got to.
  ///
  /// A read, so it carries no gate: polling is what the running screen does, and asking
  /// for a fingerprint every second would be a gate nobody reads.
  Future<CloneJob> cloneStatus(String taskId) async {
    final json = await _authed('GET', _uri(['m', 'projects', 'clone', taskId]));
    return CloneJob.fromJson(json);
  }

  /// `GET /m/fs?path=` — the roots this host opens, and one level of [path].
  ///
  /// Directories only; the host sends no file names and serves no contents (ADR-A). A read,
  /// so it carries no gate beyond the bearer: it reveals nothing the bearer does not reach.
  Future<BrowsePage> browse({String? path}) async => BrowsePage.fromJson(
        await _authed(
          'GET',
          _uri(const ['m', 'fs'], query: path == null ? null : {'path': path}),
        ),
      );
}
