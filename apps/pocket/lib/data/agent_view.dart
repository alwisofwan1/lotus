import '../hosts/host_failure.dart';
import '../models/cell_result.dart';
import '../models/conversation.dart';
import '../models/host_id.dart';
import '../models/permission.dart';
import '../models/transcript.dart';

/// Distinguish why Chat is unavailable so the operator gets the right explanation.
enum ChatBlocked {
  /// The host has no hook pipeline at all — a Standalone Host on a VPS (PLAN §7 no. 10).
  /// Nothing about this host will ever change it short of running the desktop there.
  noPipeline,

  /// The host **has** the pipeline but records nothing from the agents it spawns, and
  /// says so (`hostSupports: false`). On the desktop that means its hooks are installed
  /// somewhere the agent does not read — see `settings::hooks_reach_spawned_agents`.
  /// Unlike [noPipeline] this is a fixable condition on the machine, not a fact about it.
  notRecording,

  /// A silent runner needs a different explanation from a host that is not recording.
  runnerSilent,

  /// Unknown runner mapping may resolve after the desktop UI loads (ADR-1).
  outlookUnknown,
}

/// What the Agent page shows for one cell, already decided.
///
/// It never throws and it carries no exceptions: a screen renders this and nothing
/// else. That is deliberate — the moment a widget has to catch an `ApiFailure`, the
/// rule "is this host allowed to show Chat" starts being answered in two places.
class AgentView {
  const AgentView({
    required this.ref,
    this.blocked,
    this.transcript,
    this.permission,
    this.failure,
    this.result,
    this.conversation,
  });

  /// Chat cannot exist on this host at all — a Standalone Host has no hook pipeline
  /// (PLAN §7 no. 10), so Terminal is the way through, not an empty Chat.
  const AgentView.terminalOnly(this.ref)
      : blocked = ChatBlocked.noPipeline,
        transcript = null,
        conversation = null,
        permission = null,
        failure = null,
        result = null;

  /// The read could not complete. [failure] already names the operator's next move.
  ///
  /// Not blocked: a failed read says nothing about whether this host can do Chat, and
  /// claiming it cannot would outlive the outage in the operator's head.
  const AgentView.failed(this.ref, HostFailure this.failure)
      : blocked = null,
        transcript = null,
        permission = null,
        result = null,
        conversation = null;

  final CellRef ref;

  /// Null when Chat works here.
  final ChatBlocked? blocked;

  final TranscriptSnapshot? transcript;
  final PermissionSnapshot? permission;
  final HostFailure? failure;

  /// Git's view of the pane's directory, when the host advertises `result`. Null on an
  /// older host **and** when the read failed — a missing card, never a failed page: the
  /// transcript is the page, this is a footnote to it.
  final CellResult? result;

  /// Prefer host conversation parts so seed and live IDs match.
  final List<Turn>? conversation;

  bool get chatAvailable => blocked == null;

  bool get isFailed => failure != null;

  /// The only condition under which answer buttons may be drawn: the hook says the
  /// cell is waiting *and* the options were read from the terminal (ADR-8).
  bool get answerable => permission?.answerable ?? false;
}
