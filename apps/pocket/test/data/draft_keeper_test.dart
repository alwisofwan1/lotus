import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/draft_keeper.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_security.dart';

const mac = HostId('mac');
CellRef ref(String paneId) => CellRef(mac, paneId);

/// What an unsent draft is worth, and what it costs to lose one.
void main() {
  late InMemorySecureStore store;
  late DraftKeeper drafts;

  setUp(() async {
    store = InMemorySecureStore();
    // Settles instantly here, so the assertions below are about *what* is kept rather
    // than about when. The waiting itself is what the last two tests are for.
    drafts = DraftKeeper(store, sleep: (_) async {});
    await drafts.load();
  });

  test('a draft comes back for the agent it was written for, and no other', () async {
    await drafts.keep(ref('p-1'), 'setengah kalimat yang belum');

    expect(drafts.draftFor(ref('p-1')), 'setengah kalimat yang belum');
    expect(drafts.draftFor(ref('p-2')), isNull,
        reason: 'a draft meant for one agent surfaced in another');
  });

  test('it survives the phone killing the app', () async {
    await drafts.keep(ref('p-1'), 'setengah kalimat yang belum');

    // The whole reason this is stored and not just remembered: Android kills a
    // backgrounded app, and the operator who put the phone down is the one being served.
    final afterRelaunch = DraftKeeper(store)..addListener(() {});
    await afterRelaunch.load();

    expect(afterRelaunch.draftFor(ref('p-1')), 'setengah kalimat yang belum');
  });

  test('sending it clears what was kept, from storage as well as memory', () async {
    await drafts.keep(ref('p-1'), 'setengah kalimat yang belum');

    await drafts.clear(ref('p-1'));

    expect(drafts.draftFor(ref('p-1')), isNull);
    expect(store.entries.keys.where((k) => k.startsWith('draft:')), isEmpty,
        reason: 'a sent draft was left behind to be restored over the next one');
  });

  test('an empty draft is a clear, not a stored nothing', () async {
    await drafts.keep(ref('p-1'), 'setengah kalimat yang belum');

    // The composer reports every change, so emptying the field arrives here as `''`.
    // Writing that would leave a key per agent the operator has ever typed into.
    await drafts.keep(ref('p-1'), '   ');

    expect(drafts.draftFor(ref('p-1')), isNull);
    expect(store.entries.keys.where((k) => k.startsWith('draft:')), isEmpty);
  });

  group('what typing costs', () {
    /// A keeper whose write never stops waiting, so a test can look at the moment
    /// between the keystroke and the write.
    DraftKeeper stalled() => DraftKeeper(store, sleep: (_) => Completer<void>().future);

    test('a sentence is one write, not one per keystroke', () async {
      final drafts = stalled();
      await drafts.load();

      for (final typed in ['s', 'se', 'set', 'seten', 'setengah']) {
        unawaited(drafts.keep(ref('p-1'), typed));
      }
      await pumpEventQueue();

      // Every keystroke reaching the Keystore is a platform call per character, on the
      // one control this app exists for. Memory still answers immediately.
      expect(store.writes, 0,
          reason: 'the field is writing to storage on every keystroke');
      expect(drafts.draftFor(ref('p-1')), 'setengah');
    });

    test('whatever is still waiting is written when the page goes away', () async {
      final drafts = stalled();
      await drafts.load();
      for (final typed in ['s', 'se', 'setengah']) {
        unawaited(drafts.keep(ref('p-1'), typed));
      }
      await pumpEventQueue();

      await drafts.flush();

      // The tail of a sentence must not be lost to a timer that had not fired yet.
      expect(store.writes, 1);
      expect(store.entries['draft:mac/p-1'], 'setengah');
    });
  });
}
