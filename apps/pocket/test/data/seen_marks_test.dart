import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/seen_marks.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_security.dart';

const mac = HostId('mac');
final now = DateTime.fromMillisecondsSinceEpoch(1_785_664_800_000);

Cell cell({String? turn, int? age}) => Cell(
      host: mac, paneId: 'p-1', workspaceId: 'w', agentType: 'claude', title: 'Atlas',
      status: 'live', isAlive: true, turn: turn, turnAgeMs: age,
    );

/// Finished while nobody was looking — the mark, and when it must stay off.
void main() {
  late InMemorySecureStore store;
  late SeenMarks marks;

  setUp(() {
    store = InMemorySecureStore();
    marks = SeenMarks(store, now: () => now);
  });

  test('an idle agent never opened is unread; opening it clears the mark', () async {
    final finished = cell(turn: 'idle', age: 60_000);
    expect(marks.isUnread(finished), isTrue);

    await marks.markOpened(finished.ref);
    expect(marks.isUnread(finished), isFalse);
  });

  test('finishing again after it was opened marks it again', () async {
    // Opened two minutes ago; finished one minute ago → newer than the look.
    marks = SeenMarks(store, now: () => now.subtract(const Duration(minutes: 2)));
    await marks.markOpened(cell().ref);
    marks = SeenMarks(store, now: () => now);
    await marks.load();

    expect(marks.isUnread(cell(turn: 'idle', age: 60_000)), isTrue);
    expect(marks.isUnread(cell(turn: 'idle', age: 5 * 60_000)), isFalse, reason: 'finished before the look');
  });

  test('a cell the fleet cannot date is never unread — no turn, no age, or still running', () {
    expect(marks.isUnread(cell()), isFalse, reason: 'quiet: Codex, or hooks that never fire');
    expect(marks.isUnread(cell(turn: 'idle')), isFalse, reason: 'idle but undated');
    expect(marks.isUnread(cell(turn: 'running', age: 1_000)), isFalse);
    expect(marks.isUnread(cell(turn: 'needs-input', age: 1_000)), isFalse, reason: 'amber owns that row');
  });

  test('marks survive a relaunch through the store', () async {
    await marks.markOpened(cell().ref);
    final reborn = SeenMarks(store, now: () => now);
    await reborn.load();
    expect(reborn.openedAt(cell().ref), now);
  });
}
