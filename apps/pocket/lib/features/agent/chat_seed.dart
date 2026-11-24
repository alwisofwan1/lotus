import '../../data/agent_view.dart';
import '../../data/live_conversation.dart';
import '../../models/host_id.dart';

/// Where Chat's history comes from when a page opens: **one conversation, one
/// derivation.**
///
/// The host's own turns win wherever it serves them, because their part ids are the
/// ids its live lane sends — a seed and a delta then describe the same part instead of
/// two copies of it. Seeding from entries alongside a runner that streams native parts
/// is what drew every prompt of a codex cell twice: codex's own ids on the lane, this
/// app's hashed ids from the seed (reported from a device on 2026-09-08).
///
/// Entries remain the fallback, and not a vestigial one: a host with no conversation
/// route is a host this app still has to work against, because it has **no minimum host
/// version** (`contract/README.md`).
///
/// Its own function so the rule can be read and tested without a page — the same reason
/// `ChatLayout` and `WorkState` are not inside widgets.
void seedChat(LiveConversation live, CellRef ref, AgentView view) {
  final turns = view.conversation;
  if (turns != null) {
    live.seed(ref, turns);
    return;
  }
  final entries = view.transcript?.entries;
  if (entries != null) live.seedEntries(ref, entries);
}
