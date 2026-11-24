import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/agent_view.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/features/agent/chat_seed.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/transcript.dart';

const _mac = HostId('mac');
final _ref = CellRef(_mac, 'ss-1');
final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

/// Codex's own id, as it arrives on the live lane.
Part _native(String text) => UserMessagePart(
    id: '01a07f0e-3ba4-7281-99f', ts: _at, seq: 0, provenance: Provenance.native, text: text);

Turn _turn(List<Part> parts) => Turn(turnId: '01a07f0e-3b24', startedAt: _at, parts: parts);

TranscriptEntry _entry(String prompt) => TranscriptEntry(
    event: 'prompt-submit', status: 'running', title: 'You', body: prompt,
    userPrompt: prompt, toolTarget: '', timestamp: _at);

TranscriptSnapshot _snapshot(List<TranscriptEntry> entries) => TranscriptSnapshot(
      paneId: 'ss-1',
      total: entries.length,
      entries: entries,
      hostSupports: true,
      runnerReports: true,
      outlook: TranscriptOutlook.expected,
    );

void main() {
  late StreamController<HostEvent> events;
  late LiveConversation live;

  setUp(() {
    events = StreamController<HostEvent>.broadcast();
    live = LiveConversation(events.stream)..follow([_ref]);
  });

  tearDown(() {
    live.dispose();
    unawaited(events.close());
  });

  /// The bug this function exists for: a codex cell drew every prompt twice, because
  /// the seed converted `/transcript` entries into parts of the app's own — hashed ids —
  /// while the live lane delivered codex's ids for the same exchange. Two derivations of
  /// one conversation.
  test('the host own turns win, so a seed and a delta are the same part', () {
    seedChat(
      live,
      _ref,
      AgentView(
        ref: _ref,
        conversation: [_turn([_native('Buatkan pantun')])],
        transcript: _snapshot([_entry('Buatkan pantun')]),
      ),
    );

    final parts = live.turnsFor(_ref).expand((t) => t.parts).toList();
    expect(parts, hasLength(1), reason: 'one prompt, drawn once');
    expect(parts.single.id, '01a07f0e-3ba4-7281-99f', reason: "the runner's own id");
  });

  test('entries still seed a host that serves no conversation', () {
    // No minimum host version: a host without the route is one this app still serves.
    seedChat(live, _ref, AgentView(ref: _ref, transcript: _snapshot([_entry('Halo')])));
    final parts = live.turnsFor(_ref).expand((t) => t.parts).toList();
    expect(parts, hasLength(1));
    expect(parts.single.id, isNot('01a07f0e-3ba4-7281-99f'));
  });

  test('a host that answered neither leaves what is held alone', () {
    seedChat(live, _ref, AgentView(ref: _ref));
    expect(live.turnsFor(_ref), isEmpty);
  });
}
