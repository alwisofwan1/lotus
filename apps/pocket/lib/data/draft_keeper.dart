import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/secure_store.dart';
import '../models/host_id.dart';

/// What the operator had started saying to each agent, kept until they send it.
///
/// **Drafts became expensive the day the return key started writing lines.** Before that
/// the composer held at most a wrapped sentence; now it holds a paragraph somebody stood
/// somewhere and typed, and the two ways to lose one are both ordinary: backing out to
/// pick a different agent, and Android killing a backgrounded app. This closes both,
/// which is why it is stored rather than only remembered.
///
/// Keyed per cell, modelled on `SeenMarks` down to the prefix and the hydrate-once shape.
/// A draft belongs to the agent it was aimed at — restoring one into the wrong composer
/// would be worse than losing it, because it would be *sent*.
///
/// **The held paste is deliberately not kept.** That block is whatever was on the
/// operator's clipboard, and a log they pasted once is not something this app should copy
/// into the Keystore and hold across relaunches on their behalf.
class DraftKeeper extends ChangeNotifier {
  DraftKeeper(
    this.store, {
    this.settle = const Duration(milliseconds: 400),
    this.sleep = _wait,
  });

  static Future<void> _wait(Duration d) => Future<void>.delayed(d);

  /// Injected, kept visible (ADR-13 no. 4).
  final SecureStore store;

  /// How long the field has to be still before what it says reaches storage.
  ///
  /// **Memory is updated on the keystroke; storage is not.** Every change would otherwise
  /// be a Keystore write per character typed — a platform call per letter, on the one
  /// control this whole app exists to offer. Four hundred milliseconds is past the gap
  /// between two keystrokes and far short of the gap between a thought and the next one.
  final Duration settle;

  /// Injected so a test can hold the moment between the keystroke and the write.
  final Future<void> Function(Duration) sleep;

  final Map<CellRef, String> _drafts = {};

  /// Drafts whose stored copy is behind what is in memory.
  final Set<CellRef> _behind = {};

  /// Bumped on every change, so only the last keystroke's own wait does the writing.
  int _tick = 0;

  /// Namespaced like every other key this app owns, so `Credentials.load` — which reads
  /// everything and reports what it cannot parse — skips it by prefix.
  static const String _prefix = 'draft:';

  /// Reads every draft back. Called once at boot; the map is the truth afterwards.
  Future<void> load() async {
    final all = await store.readAll();
    for (final entry in all.entries) {
      if (!entry.key.startsWith(_prefix)) continue;
      final ref = _parse(entry.key.substring(_prefix.length));
      if (ref != null) _drafts[ref] = entry.value;
    }
    notifyListeners();
  }

  /// What was left unsent for this agent, or null if nothing was.
  String? draftFor(CellRef ref) => _drafts[ref];

  /// Remembers what is in the composer for this agent.
  ///
  /// Blank is a [clear], not a stored empty string. The composer reports every change,
  /// so emptying the field arrives here as `''` — writing that would leave one key behind
  /// per agent the operator has ever typed into, and a restore would then put an empty
  /// draft over whatever else is there.
  Future<void> keep(CellRef ref, String text) async {
    if (text.trim().isEmpty) return clear(ref);
    if (_drafts[ref] == text) return;
    _drafts[ref] = text;
    _behind.add(ref);
    notifyListeners();

    final mine = ++_tick;
    await sleep(settle);
    // Something newer arrived while this one waited; that call owns the write now.
    if (mine != _tick) return;
    await flush();
  }

  /// Writes anything memory is holding that storage has not caught up to.
  ///
  /// Called on the way out of a page as well as on the timer, because the tail of a
  /// sentence must not be lost to a wait that had not finished — which would be this
  /// object failing at the one thing it is for.
  Future<void> flush() async {
    if (_behind.isEmpty) return;
    final pending = _behind.toList();
    _behind.clear();
    for (final ref in pending) {
      final text = _drafts[ref];
      if (text != null) await store.write(_key(ref), text);
    }
  }

  /// Forgets it — the draft was sent, or emptied on purpose.
  Future<void> clear(CellRef ref) async {
    _behind.remove(ref);
    if (_drafts.remove(ref) == null) return;
    notifyListeners();
    await store.delete(_key(ref));
  }

  static String _key(CellRef ref) => '$_prefix${ref.host.value}/${ref.paneId}';

  static CellRef? _parse(String raw) {
    final slash = raw.indexOf('/');
    if (slash <= 0 || slash == raw.length - 1) return null;
    return CellRef(HostId(raw.substring(0, slash)), raw.substring(slash + 1));
  }
}
