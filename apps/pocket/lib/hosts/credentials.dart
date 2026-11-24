import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/api_failure.dart';
import '../core/clock.dart';
import '../core/secure_store.dart';
import '../models/host_id.dart';
import '../models/pairing.dart';
import 'biometric_gate.dart';

/// What happened when a credential was asked to renew itself.
enum RefreshOutcome {
  /// More than [Credentials.refreshLead] left — nothing to do yet.
  notDue,

  refreshed,

  /// Proof of presence was not given. The old token is still alive, so this is a
  /// pause rather than a loss.
  refused,

  /// This credential can never be renewed again: past the 30-day ceiling, refused by
  /// the host, or never there at all. Only a fresh pairing code gets back in.
  mustRepair,
}

/// Every device token, per host — the only thing Pocket persists (ADR-12 no. 3).
///
/// Owns two rules that are easy to state and easy to get wrong:
///
/// - **Refresh before the 401, not after it** (ADR-12 no. 2). The 12-hour TTL does not
///   care that a socket is open, so waiting for the rejection means the operator meets
///   it mid-action.
/// - **A refresh needs proof of presence, and the 30-day ceiling never moves**
///   (`PLAN.md` §Kredensial). A TTL without both is decoration: a thief holding an
///   unlocked phone would renew forever.
class Credentials extends ChangeNotifier {
  Credentials({required this.store, required this.now, required this.gate});

  /// Injected collaborators, kept visible rather than hidden behind underscores — the
  /// convention `HostSocket` sets, and what this object depends on is worth reading at
  /// the call site (ADR-13 no. 4). The clock is one of them so the TTL is tested by
  /// moving time rather than by waiting it out.
  final SecureStore store;
  final Clock now;
  final BiometricGate gate;

  /// Namespaces the entries, so storage this app does not own is never touched.
  static const String keyPrefix = 'host:';

  /// How early a renewal starts.
  ///
  /// Was one hour against a 12-hour host TTL, which meant refresh only fired if the
  /// app happened to be opened in the token's last hour — everything before that was
  /// luck. The host TTL moved to 72 hours for the same reason (see
  /// `DEVICE_TOKEN_TTL_MS`), and this lead moved with it: at 24 hours, opening the app
  /// roughly once every two days keeps the token from ever lapsing, while an absence
  /// genuinely past 72 hours still forces the re-pair the host enforces regardless.
  static const Duration refreshLead = Duration(hours: 24);

  final Map<HostId, PairedDevice> _devices = {};
  final List<String> _unreadable = [];

  Iterable<HostId> get hosts => _devices.keys;

  Iterable<PairedDevice> get devices => _devices.values;

  /// Storage keys that could not be parsed. Surfaced rather than swallowed: one rotted
  /// entry is a diagnostic, and silence here would look like an unpaired device.
  List<String> get unreadable => List.unmodifiable(_unreadable);

  PairedDevice? deviceFor(HostId host) => _devices[host];

  /// Hydrates from storage. Called once, before the first screen.
  Future<void> load() async {
    _devices.clear();
    _unreadable.clear();
    final Map<String, String> entries;
    try {
      entries = await store.readAll();
    } on Object {
      // A Keystore that cannot be read must not hold the launch screen forever:
      // start unpaired and leave a diagnostic, the same as a rotted entry.
      _unreadable.add('keystore');
      notifyListeners();
      return;
    }

    for (final entry in entries.entries) {
      if (!entry.key.startsWith(keyPrefix)) continue;
      final device = _parse(entry.value);
      if (device == null) {
        _unreadable.add(entry.key);
        continue;
      }
      _devices[device.hostId] = device;
    }
    notifyListeners();
  }

  /// The bearer for a host, or empty when there is none.
  ///
  /// Shaped to fit `TokenReader`, which is read from inside socket callbacks — so it
  /// cannot throw. An empty bearer earns a 401, and that is a path the app already
  /// handles; an exception thrown into a reconnect loop is not.
  String tokenFor(HostId host) => _devices[host]?.deviceToken ?? '';

  /// Whether this credential can still be used right now.
  ///
  /// This is the `tokenStillValid` question `HostRegistry.reportUnauthorized` asks: a
  /// 401 with a token that is still inside its TTL was **revoked**, while one past it
  /// merely aged out. Same status code, different next move.
  bool isUsable(HostId host) {
    final device = _devices[host];
    return device != null && now().isBefore(device.expiresAt);
  }

  bool refreshDue(HostId host) {
    final device = _devices[host];
    return device != null && device.refreshDueAt(now(), lead: refreshLead);
  }

  bool pastCeiling(HostId host) {
    final device = _devices[host];
    return device == null || !now().isBefore(device.hardExpiresAt);
  }

  /// Stores a newly paired device.
  Future<void> remember(PairedDevice device) async {
    await _persist(device);
    _devices[device.hostId] = device;
    notifyListeners();
  }

  /// Renames a machine to whatever its owner calls it, or back to its hostname.
  ///
  /// Kept on the credential rather than in a store of its own, so it dies with the
  /// pairing: a nickname outliving its host would be an orphan nobody would ever think
  /// to clear, and it would come back to greet the next machine that happened to
  /// reuse the id.
  ///
  /// **No gate.** ADR-8 gates what reaches a machine; this changes a word on this
  /// phone and reaches nothing.
  Future<void> rename(HostId host, String? nickname) async {
    final device = _devices[host];
    if (device == null) return;
    await remember(device.named(nickname));
  }

  /// Drops a host entirely — a revoke, or an operator unpairing.
  Future<void> forget(HostId host) async {
    await store.delete('$keyPrefix${host.value}');
    _devices.remove(host);
    notifyListeners();
  }

  /// Renews the token if it is close enough to expiry to be worth a prompt.
  ///
  /// [refresh] is injected rather than a `HostApi` held here, so this class stays
  /// testable without a transport and `hosts/` keeps owning what it already owns.
  /// Anything other than a [RefreshRefused] — an asleep host, a revoked token — is
  /// **rethrown**: those are reachability questions, and answering them here would
  /// flatten a sleeping machine into a dead credential.
  Future<RefreshOutcome> refreshIfDue(
    HostId host,
    Future<RefreshedToken> Function() refresh,
  ) async {
    final device = _devices[host];
    if (device == null) return RefreshOutcome.mustRepair;

    // Answered locally: the host would refuse this, and a round trip to be told so
    // costs the operator a wait on a cellular link for no new information.
    if (pastCeiling(host)) return RefreshOutcome.mustRepair;
    if (!device.refreshDueAt(now(), lead: refreshLead)) return RefreshOutcome.notDue;

    final verdict = await gate.authorize('Refresh access to ${device.hostLabel}');
    if (!verdict.allowed) return RefreshOutcome.refused;

    final RefreshedToken renewed;
    try {
      renewed = await refresh();
    } on RefreshRefused {
      // Kept on the list on purpose: onboarding has to know *which* host needs a new
      // pairing code, and deleting the entry would drop it off the screen entirely.
      return RefreshOutcome.mustRepair;
    }

    // Storage first. A token live in memory but never written would disappear on the
    // next cold start while the app went on behaving as though it were paired.
    await remember(device.withToken(renewed));
    return RefreshOutcome.refreshed;
  }

  Future<void> _persist(PairedDevice device) =>
      store.write('$keyPrefix${device.hostId.value}', jsonEncode(device.toJson()));

  PairedDevice? _parse(String raw) {
    try {
      final json = jsonDecode(raw);
      if (json is! Map<String, Object?>) return null;
      return PairedDevice.fromStored(json);
    } on Object {
      // Any shape we cannot read — bad JSON, a field gone missing across an app
      // update — is one unusable host, never a crash on the only screen there is.
      return null;
    }
  }
}
