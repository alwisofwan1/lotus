/// Prevents confusing opaque host and pane identifiers at compile time.
extension type const HostId(String value) {}

/// Identifies a cell by host and pane because pane IDs can be ambiguous (R-10).
class CellRef {
  const CellRef(this.host, this.paneId);

  final HostId host;
  final String paneId;

  @override
  bool operator ==(Object other) =>
      other is CellRef && other.host.value == host.value && other.paneId == paneId;

  @override
  int get hashCode => Object.hash(host.value, paneId);

  /// `vps/p-2` — the form a log line and an audit entry both want.
  @override
  String toString() => '$host/$paneId';
}

/// Includes the host to distinguish projects with the same name (R-10, MVP.md).
class ProjectRef {
  const ProjectRef(this.host, this.workspaceId);

  final HostId host;
  final String workspaceId;

  @override
  bool operator ==(Object other) =>
      other is ProjectRef &&
      other.host.value == host.value &&
      other.workspaceId == workspaceId;

  @override
  int get hashCode => Object.hash(host.value, workspaceId);

  @override
  String toString() => '$host/$workspaceId';
}
