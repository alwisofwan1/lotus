import 'dart:async';

import '../core/api_failure.dart';
import '../core/push_tokens.dart';
import '../core/transport.dart';
import '../hosts/host_registry.dart';
import '../models/host_id.dart';

/// Keeping every host that can wake this phone told where to reach it (ADR-4).
///
/// The policy lives here rather than on a screen because it is a **set** problem, not
/// a screen problem: one token has to reach every paired host that advertises `push`,
/// and it has to reach them again whenever FCM rotates it. A widget doing that would
/// leave a host un-registered the first time the operator happened not to open a
/// particular screen.
class PushRepository {
  PushRepository({required this.tokens, required this.registry});

  /// Injected collaborators, visible at the call site (ADR-13 no. 4).
  final PushTokens tokens;
  final HostRegistry registry;

  StreamSubscription<String>? _rotations;
  String? _current;

  /// The token currently registered, or null when push is not in play. Exposed for
  /// diagnostics — never rendered, and never logged.
  String? get currentToken => _current;

  /// Asks for the token once, registers it everywhere, then follows rotations.
  ///
  /// Safe to call on every cold start: FCM returns the same token until it rotates,
  /// and the host skips a write when the value has not changed.
  Future<void> start() async {
    // **Nothing paired means nothing asked.** Requesting the notification permission
    // on a phone with no host is asking for something that cannot be used yet — and on
    // Android 13+ that is not merely impolite: a refusal is permanent, and the OS will
    // not ask again. So a "no" collected before the operator has seen what the app does
    // would silently disable push forever, including after they pair.
    //
    // Seen for real on 2026-08-07: a fresh install put the system permission dialog on
    // top of the onboarding screen, before a single machine was known.
    //
    // Deferred rather than dropped: `PocketApp` calls this again from `onPaired`, so
    // the prompt lands the moment a machine exists that can actually ring this phone.
    if (registry.hosts.isEmpty) return;

    if (!await tokens.available) return;

    final token = await tokens.requestToken();
    if (token == null) return; // Permission declined, or no Play Services.

    _current = token;
    await _registerEverywhere(token);

    // Rotation is not an edge case: a stale token stops delivering **silently**, which
    // in this product looks exactly like a quiet fleet.
    _rotations ??= tokens.refreshed.listen((next) {
      _current = next;
      unawaited(_registerEverywhere(next));
    });
  }

  /// Registers with a single host — the path a freshly paired host takes, since it
  /// joined after [start] already ran.
  Future<void> registerWith(HostId host) async {
    final token = _current;
    if (token == null) return;
    await _registerWith(host, token);
  }

  /// Withdraws this device from every host that knows it.
  ///
  /// Best-effort by design: a host that is asleep cannot be told, and the operator
  /// asking for quiet must not be blocked on a machine they walked away from. The
  /// token dies with the pairing on that host anyway, and FCM stops delivering once
  /// the app's registration is gone.
  Future<void> stop() async {
    await _rotations?.cancel();
    _rotations = null;
    _current = null;

    for (final host in registry.hosts.where((h) => h.canPush)) {
      final api = registry.apiFor(host.id);
      if (api == null) continue;
      try {
        await api.clearPushToken();
      } on TransportUnavailable {
        // Unreachable hosts are left as they are; see above.
      } on ApiFailure {
        // Same.
      }
    }
  }

  Future<void> _registerEverywhere(String token) async {
    // Every host in parallel: one sleeping machine must not delay the others (R-11).
    await Future.wait(
      registry.hosts.where((h) => h.canPush).map((h) => _registerWith(h.id, token)),
    );
  }

  /// One host, and failures are swallowed on purpose.
  ///
  /// Push is the second channel. A host that cannot be told where to ring is a host
  /// the operator will still see over the live socket the moment they open the app, so
  /// failing loudly here would trade a real capability for a broken screen.
  Future<void> _registerWith(HostId host, String token) async {
    final api = registry.apiFor(host);
    if (api == null) return;
    try {
      await api.registerPushToken(token);
    } on TransportUnavailable {
      // Asleep or unreachable. The next cold start registers again.
    } on ApiFailure {
      // A host that refuses the route — older than it, or push switched off since
      // `hello` was read.
    }
  }
}
