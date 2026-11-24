import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/snippets.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_security.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

void main() {
  late InMemorySecureStore store;
  late Snippets snippets;

  setUp(() {
    store = InMemorySecureStore();
    snippets = Snippets(store);
  });

  test('nothing kept on a machine that has never been used', () async {
    expect(await snippets.saved(mac), isEmpty);
    expect(await snippets.recent(mac), isEmpty);
  });

  group('what was sent from here', () {
    test('is remembered newest first', () async {
      await snippets.remember(mac, 'bun run pocket:test');
      await snippets.remember(mac, 'git status');

      expect(await snippets.recent(mac), ['git status', 'bun run pocket:test']);
    });

    test('a repeat moves to the front rather than appearing twice', () async {
      await snippets.remember(mac, 'ls');
      await snippets.remember(mac, 'git status');
      await snippets.remember(mac, 'ls');

      // A list where `bun run pocket:test` appears nine times is a list with two
      // usable rows.
      expect(await snippets.recent(mac), ['ls', 'git status']);
    });

    test('the window rolls, so a long session does not grow forever', () async {
      for (var i = 0; i < Snippets.recentLimit + 4; i++) {
        await snippets.remember(mac, 'command $i');
      }

      final kept = await snippets.recent(mac);
      expect(kept, hasLength(Snippets.recentLimit));
      expect(kept.first, 'command ${Snippets.recentLimit + 3}');
      expect(kept, isNot(contains('command 0')));
    });

    test('blank and oversized lines are not worth a slot', () async {
      await snippets.remember(mac, '   ');
      await snippets.remember(mac, 'x' * (Snippets.maxLength + 1));

      // The second is output being pasted, not a command being reused.
      expect(await snippets.recent(mac), isEmpty);
    });
  });

  group('what the operator keeps', () {
    test('survives the rolling window entirely', () async {
      await snippets.save(mac, 'journalctl -u lotus-host -f -n 200');
      for (var i = 0; i < Snippets.recentLimit + 4; i++) {
        await snippets.remember(mac, 'command $i');
      }

      expect(await snippets.saved(mac), ['journalctl -u lotus-host -f -n 200']);
    });

    test('keeping the same line twice makes one row', () async {
      await snippets.save(mac, 'df -h');
      await snippets.save(mac, 'df -h');

      expect(await snippets.saved(mac), ['df -h']);
    });

    test('forgetting removes it and leaves the rest', () async {
      await snippets.save(mac, 'df -h');
      await snippets.save(mac, 'ss -tulpn');

      await snippets.forget(mac, 'df -h');

      expect(await snippets.saved(mac), ['ss -tulpn']);
    });
  });

  group('a machine is a machine', () {
    test('lines do not leak between hosts', () async {
      await snippets.save(mac, 'flutter test');
      await snippets.remember(mac, 'git status');

      // `journalctl -u lotus-host` means something on the VPS and nothing on the
      // laptop; offering both to whichever is on screen is how a list stops being read.
      expect(await snippets.saved(vps), isEmpty);
      expect(await snippets.recent(vps), isEmpty);
    });

    test('unpairing takes that machine\'s lines with it', () async {
      await snippets.save(mac, 'flutter test');
      await snippets.remember(mac, 'git status');
      await snippets.save(vps, 'docker ps');

      await snippets.forgetHost(mac);

      expect(await snippets.saved(mac), isEmpty);
      expect(await snippets.recent(mac), isEmpty);
      expect(await snippets.saved(vps), ['docker ps']);
    });

    test('a machine that kept nothing needs no delete at all', () async {
      await snippets.forgetHost(vps);

      // Unpairing a machine whose terminal was never opened should be as quiet here as
      // it is in `LastProject`, or a write count stops meaning anything.
      expect(store.deletes, 0);
    });
  });

  test('a rotted value is forgotten rather than surfaced as a fault', () async {
    await store.write('pref:snippets:mac', 'not json at all');

    // This is a convenience, and a convenience that can break a screen is worse than
    // one that is missing.
    expect(await snippets.saved(mac), isEmpty);
  });

  test('it writes under its own prefix, so credentials never see it', () async {
    await snippets.save(mac, 'df -h');
    await snippets.remember(mac, 'ls');

    final keys = (await store.readAll()).keys;
    expect(keys, everyElement(anyOf(startsWith('pref:snippets:'), startsWith('pref:recent:'))));
  });
}
