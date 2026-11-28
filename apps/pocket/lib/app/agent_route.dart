import 'package:flutter/material.dart';

import '../features/agent/agent_screen.dart';
import '../models/cell.dart';
import 'composition_root.dart';

/// Pushes the agent pager on [cell], and answers whether its Sessions sheet asked for a
/// new agent (v4 tiket 08) — the opener decides where that leads, because only it knows
/// whether a Home is underneath.
///
/// Lifted out of `pocket_app.dart` when that answer pushed the file past the 300-line
/// limit. A push rather than a replace: back belongs to whatever pushed it, and the pager
/// freezes its order at open time — so returning is also how the operator picks up a
/// freshly reordered list. Keyed rather than contextual: a wake-up tap has no widget
/// context to offer.
Future<bool> showAgentPager(NavigatorState? navigator, CompositionRoot root, Cell cell) async {
  // Looked at, so Home stops marking it — before the push, so the row is plain by
  // the time the operator comes back.
  root.seenMarks.markOpened(cell.ref);
  final startAgent = await navigator?.push<bool>(
    MaterialPageRoute<bool>(
      builder: (_) => AgentScreen(
        fleet: root.fleet,
        repository: root.agents,
        live: root.liveTranscript,
        pager: root.transcriptPager,
        dictation: root.dictation,
        snippets: root.snippets,
        drafts: root.drafts,
        doneMarks: root.doneMarks,
        hostLabel: root.hostLabel,
        initial: cell.ref,
        // Taken from the cell that was tapped rather than from Home's own selection:
        // one object carries both facts, so the pager cannot end up scoped to a
        // different project than the agent it opened on.
        project: cell.project,
      ),
    ),
  );
  return startAgent ?? false;
}
