import '../hosts/host_failure.dart';
import '../models/cell_result.dart';
import '../models/conversation.dart';
import '../models/host_id.dart';
import '../models/permission.dart';
import '../models/transcript.dart';

/// Why Chat cannot be drawn for a cell — never *that* it cannot, which a bool already
/// said, but which of two different things the operator is looking at.
///
/// They lead to the same next move (Terminal) and to different sentences, and the
/// sentence is the whole point: an empty Chat with no explanation is the failure this
/// enum exists to stop, so replacing it with the wrong explanation would be no better.
enum ChatBlocked {
  /// The host has no hook pipeline at all — a Standalone Host on a VPS (PLAN §7 no. 10).
  /// Nothing about this host will ever change it short of running the desktop there.
  noPipeline,

  /// The host **has** the pipeline but records nothing from the agents it spawns, and
  /// says so (`hostSupports: false`). On the desktop that means its hooks are installed
  /// somewhere the agent does not read — see `settings::hooks_reach_spawned_agents`.
  /// Unlike [noPipeline] this is a fixable condition on the machine, not a fact about it.
  notRecording,

  /// The host records fine — **this agent's CLI has nothing to report with**.
  ///
  /// Codex's entire surface into Lotus is one `agent-turn-complete` notify carrying a
  /// pane id (`mcp_config::build_codex_notify_script`), so no prompt, no tool steps and
  /// no prose ever reach the transcript ring. Chat for such a cell is not late, it is
  /// never coming.
  ///
  /// Kept apart from [notRecording] on purpose: that one sends the operator to fix the
  /// desktop, and there is nothing to fix here. Pointing them at a healthy machine would
  /// be exactly the wrong explanation this enum exists to prevent.
  runnerSilent,

  /// The host **cannot say** whether a transcript is coming for this pane.
  ///
  /// The desktop's pane→runner map is pushed by its own UI (ADR-1), so it is empty after
  /// every restart and until a Canvas board is on screen. During that window the host
  /// knows the pane exists and nothing else about it.
  ///
  /// Its own state rather than folded into [runnerSilent], because the two point
  /// somewhere different: that one says stop waiting, this one says the answer may still
  /// arrive. Folding it in would tell an operator with a healthy Claude cell that no
  /// transcript is coming, which is the wrong explanation — the exact failure mode this
  /// enum exists to prevent, just pointed at a different screen.
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

  /// The conversation **as the host derived it**, when it serves one.
  ///
  /// Preferred over [transcript] for seeding Chat: its part ids are the ones the live
  /// lane sends, so a seed and a delta describe the same part rather than two copies.
  /// Null for a host with no conversation route — then the entries are all there is,
  /// and this app converts them itself as it always did.
  final List<Turn>? conversation;

  bool get chatAvailable => blocked == null;

  bool get isFailed => failure != null;

  /// The only condition under which answer buttons may be drawn: the hook says the
  /// cell is waiting *and* the options were read from the terminal (ADR-8).
  bool get answerable => permission?.answerable ?? false;
}
