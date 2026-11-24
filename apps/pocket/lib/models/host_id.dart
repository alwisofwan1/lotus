/// Which paired host something came from.
///
/// A named type rather than a bare `String` because the two identifiers in this
/// app — host and pane — are both opaque strings, and swapping them at a call site
/// would compile and then address the wrong machine.
/// Erased to `String` at runtime, so interpolation and map keys behave exactly as
/// the bare id would — the type only exists to stop a mix-up at compile time.
extension type const HostId(String value) {}

/// The only safe way to name a cell: **host and pane together**.
///
/// Two hosts may run the same project (R-10), so `paneId` alone is ambiguous —
/// and a dispatch sent to an ambiguous address reaches whichever host answers,
/// which means an agent editing the wrong repository.
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

/// One project on one host — what Home shows, and what the switcher lists.
///
/// Host is part of the identity for the same reason it is in [CellRef]: two machines
/// can each run a project called `CNVS` (R-10), and `MVP.md` requires the switcher to
/// offer them as **two entries** (`CNVS · vps`, `CNVS · mac`). Selecting by name alone
/// would merge two repositories into one list under a title that could only name one
/// of them.
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
