import 'dart:convert';

import '../core/secure_store.dart';
import '../models/host_id.dart';

/// Separate per-host recent and saved commands so unrelated commands and deliberate saves do not mix (R-10).
class Snippets {
  const Snippets(this.store);

  final SecureStore store;

  /// How many recents a machine keeps. Enough to reach back through a debugging session,
  /// short enough that the list is still scannable at arm's length.
  static const int recentLimit = 12;

  /// Longer than this and it is not a command being reused, it is output being pasted.
  /// A bound on what the app will store rather than a judgement on what may be typed.
  static const int maxLength = 2000;

  static String _savedKey(HostId host) => 'pref:snippets:${host.value}';

  static String _recentKey(HostId host) => 'pref:recent:${host.value}';

  /// What the operator kept, newest first.
  Future<List<String>> saved(HostId host) => _read(_savedKey(host));

  /// What was dispatched from this app, newest first.
  Future<List<String>> recent(HostId host) => _read(_recentKey(host));

  /// Records a dispatch. Moves an existing entry to the front rather than repeating it —
  /// a list where `bun run pocket:test` appears nine times is a list with two usable rows.
  Future<void> remember(HostId host, String text) async {
    final entry = text.trim();
    if (entry.isEmpty || entry.length > maxLength) return;
    final kept = await recent(host);
    final next = [entry, ...kept.where((e) => e != entry)].take(recentLimit).toList();
    await store.write(_recentKey(host), jsonEncode(next));
  }

  /// Keeps a line for good. A no-op when it is already kept, so pressing `＋` twice
  /// cannot produce two identical rows.
  Future<void> save(HostId host, String text) async {
    final entry = text.trim();
    if (entry.isEmpty || entry.length > maxLength) return;
    final kept = await saved(host);
    if (kept.contains(entry)) return;
    await store.write(_savedKey(host), jsonEncode([entry, ...kept]));
  }

  Future<void> forget(HostId host, String text) async {
    final kept = await saved(host);
    if (!kept.contains(text)) return;
    await store.write(
      _savedKey(host),
      jsonEncode(kept.where((e) => e != text).toList()),
    );
  }

  /// Only remove existing keys during unpairing.
  Future<void> forgetHost(HostId host) async {
    final held = await store.readAll();
    for (final key in [_savedKey(host), _recentKey(host)]) {
      if (held.containsKey(key)) await store.delete(key);
    }
  }

  /// A rotted value is forgotten rather than surfaced as a fault: this is a convenience,
  /// and a convenience that can break a screen is worse than one that is missing.
  Future<List<String>> _read(String key) async {
    final raw = (await store.readAll())[key];
    if (raw == null) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded.whereType<String>().toList(growable: false);
    } on FormatException {
      return const [];
    }
  }
}
