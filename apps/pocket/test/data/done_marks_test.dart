import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/done_marks.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_security.dart';

const ref = CellRef(HostId('mac'), 'p-1');
final now = DateTime.fromMillisecondsSinceEpoch(1_785_664_800_000);

void main() {
  late InMemorySecureStore store;
  late DoneMarks marks;

  setUp(() {
    store = InMemorySecureStore();
    marks = DoneMarks(store, now: () => now);
  });

  test('marking a turn done holds the turn and the time, and survives a restart', () async {
    await marks.mark(ref, 't-7');
    expect(marks.doneFor(ref, lastTurn: 't-7')?.at, now);

    final reloaded = DoneMarks(store);
    await reloaded.load();
    expect(reloaded.doneFor(ref, lastTurn: 't-7')?.turnId, 't-7');
  });

  test('a newer turn is a new task: the old mark no longer says done', () async {
    await marks.mark(ref, 't-7');
    expect(marks.doneFor(ref, lastTurn: 't-8'), isNull);
    expect(marks.markFor(ref)?.turnId, 't-7', reason: 'the old result keeps its line');
  });

  test('undo clears the mark, on disk too', () async {
    await marks.mark(ref, 't-7');
    await marks.clear(ref);
    expect(marks.markFor(ref), isNull);
    final reloaded = DoneMarks(store);
    await reloaded.load();
    expect(reloaded.markFor(ref), isNull);
  });
}
