import 'dart:async';

import 'package:lotus_pocket/core/biometrics.dart';
import 'package:lotus_pocket/core/secure_store.dart';

/// The Keychain, in a Map. What ADR-13 no. 4 buys: the whole credential lifecycle is
/// exercised with no device, no plugin, and no platform channel.
class InMemorySecureStore implements SecureStore {
  final Map<String, String> entries = {};

  /// Counted so a test can prove a write actually reached storage — an in-memory
  /// model that only ever updated itself would pass every other assertion here.
  int writes = 0;
  int deletes = 0;

  /// When set, the next [write] throws — a Keystore that refused.
  Object? failWrites;

  /// When set, [readAll] throws — a Keystore that cannot be read at boot.
  Object? failReads;

  @override
  Future<Map<String, String>> readAll() async {
    final failure = failReads;
    if (failure != null) throw failure;
    return Map.of(entries);
  }

  @override
  Future<void> write(String key, String value) async {
    final failure = failWrites;
    if (failure != null) throw failure;
    entries[key] = value;
    writes += 1;
  }

  @override
  Future<void> delete(String key) async {
    entries.remove(key);
    deletes += 1;
  }
}

/// A device whose lock the test decides.
class FakeBiometrics implements Biometrics {
  FakeBiometrics({
    this.hasLock = true,
    this.answer = true,
    this.failCanPrompt,
    this.failPrompt,
  });

  /// False models the ADR-12 no. 4 exception: a device with no lock at all.
  bool hasLock;

  /// What the operator does at the prompt.
  bool answer;

  /// The plugin cannot even say whether this device has a lock. Kept separate from
  /// [failPrompt] because the two failures reach the gate by different routes, and the
  /// first is the one that could wrongly grant the no-lock exception.
  Object? failCanPrompt;

  /// The prompt itself failed — a lockout after too many attempts.
  Object? failPrompt;

  /// When set, [prompt] waits on it before answering — the OS sheet, left up.
  ///
  /// Without this a fake resolves on the next microtask, so every await in a test flies
  /// straight past the one moment a dispatch actually spends time in. What that moment
  /// looks like on screen is a question the app now has an answer for, and a seam is the
  /// only way to ask it.
  Completer<void>? holdPrompt;

  int prompts = 0;
  final List<String> reasons = [];

  @override
  Future<bool> get canPrompt async {
    final failure = failCanPrompt;
    if (failure != null) throw failure;
    return hasLock;
  }

  @override
  Future<bool> prompt(String reason) async {
    prompts += 1;
    reasons.add(reason);
    await holdPrompt?.future;
    final failure = failPrompt;
    if (failure != null) throw failure;
    return answer;
  }
}
