import 'dart:async';

import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/refresh_keys.dart';
import '../core/transport.dart';
import '../hosts/credentials.dart';
import '../hosts/host_registry.dart';
import '../models/host_id.dart';
import '../models/pairing.dart';

/// Keeps device tokens alive by renewing them when the app is opened.
///
/// **This exists because a decision was made and then not wired up.** The addendum of
/// 2026-08-05 (`PLAN.md` §Kredensial) raised the host TTL to 72 hours and the client
/// [Credentials.refreshLead] to 24, and said what that combination buys:
///
/// > lead harus jauh lebih kecil dari TTL supaya refresh proaktif punya jendela nyata
/// > untuk menyala **saat app dibuka** … membuka Pocket sekali dalam ~48 jam membuat
/// > token tidak pernah kedaluwarsa
///
/// Nothing opened that window. `refreshIfDue` had exactly one caller, [HostGate], which
/// runs on a **mutation** — so reading the fleet, scrolling it, replying to nothing kept
/// no credential alive. An operator who read for three days and dispatched on the fourth
/// met a re-pair, which is the case the addendum set out to remove.
///
/// Measured on devbox-vps, 2026-09-17: four paired devices, every one of them dead at the
/// 72-hour TTL with 18–21 days of the 30-day ceiling still unspent.
///
/// **Why this still prompts, and is not a silent background refresh.** "Refresh butuh
/// biometrik" is not an implementation detail to route around — the host never sees proof
/// of presence, only a bearer, so the client gate means something *only* at a TTL the host
/// enforces. A renewal that asked nobody would hand a stolen phone 30 days instead of 72
/// hours and pay for it with nothing. The addendum considered loosening exactly this and
/// rejected it in writing.
///
/// So the prompt stays, and what changes is only **when it gets the chance to appear**:
/// once the credential is inside its lead, on an app open, instead of never.
///
/// Lives on [CompositionRoot] rather than inside a repository because the trigger is the
/// app's own lifecycle, not any screen's action — `PocketApp` is the only thing that
/// knows the app was opened at all.
class CredentialKeeper {
  const CredentialKeeper({
    required this.registry,
    required this.credentials,
    this.keys = const NoRefreshKeys(),
  });

  final HostRegistry registry;
  final Credentials credentials;

  /// Signs renewals for hosts paired with a hardware-bound key (`refresh_keys.dart`).
  final RefreshKeys keys;

  /// Renew every credential close enough to expiry to need it.
  ///
  /// Silent by construction. This runs because the app was opened, not because the
  /// operator asked for anything, so nothing it can discover is worth an error in their
  /// face: a machine that is off, a tailnet that is down, a credential past its ceiling —
  /// each of those already has a surface that explains it at the moment it matters.
  /// Shouting here would only mean the app greets them with a failure they did not cause.
  ///
  /// Returns the hosts it actually renewed, which is what the tests read.
  Future<List<HostId>> refreshDueHosts() async {
    final renewed = <HostId>[];
    // A copy, because refreshing notifies listeners and a screen may re-enter the store
    // while this walk is in flight.
    for (final host in credentials.hosts.toList()) {
      // A host paired with a hardware key renews on a signature the host verifies, so it
      // needs neither a live bearer nor room under the ceiling — which is the whole point.
      final device = credentials.deviceFor(host);
      if (device?.refreshKeyAlias != null) {
        final due = credentials.refreshDue(host) || credentials.pastCeiling(host);
        if (!due) continue;
        final outcome = await _renewWithKey(host, device!);
        if (outcome == RefreshOutcome.refreshed) renewed.add(host);
        if (outcome == RefreshOutcome.refused) break;
        continue;
      }
      // Asked before reaching for the API: most opens have nothing due, and building a
      // request for a host that needs none is work the operator waits through.
      if (!credentials.refreshDue(host) || credentials.pastCeiling(host)) continue;
      // And a token already past its TTL cannot be renewed — `refresh()` on the host
      // enforces the same `at >= expiresAt` as `verify()`, the identical line in both
      // (addendum 2026-08-05). Seen for real on the first live run of this class: a
      // credential 33 hours past its TTL produced a biometric prompt and a round trip
      // that could only ever answer 401. Asking is knowable locally, so it is asked here.
      if (!credentials.isUsable(host)) continue;
      final api = registry.apiFor(host);
      if (api == null) continue;

      try {
        final outcome = await credentials.refreshIfDue(host, api.refreshToken);
        if (outcome == RefreshOutcome.refreshed) renewed.add(host);
        // A refusal ends the walk rather than asking again per host: the operator just
        // declined this exact prompt, and a second sheet for the next machine reads as
        // the app not having listened.
        if (outcome == RefreshOutcome.refused) break;
      } on TransportUnavailable {
        continue;
      } on ApiFailure {
        continue;
      }
    }
    return renewed;
  }

  /// Challenge, sign, renew. The Keystore's own prompt is the proof of presence here, so
  /// [Credentials.gate] is not asked as well — one prompt per renewal, as before.
  Future<RefreshOutcome> _renewWithKey(HostId host, PairedDevice device) async {
    final api = registry.apiFor(host);
    final alias = device.refreshKeyAlias!;
    if (api == null) return RefreshOutcome.notDue;
    try {
      final nonce = await api.renewalChallenge(device.deviceId);
      final signature = await keys.sign(
        alias,
        renewalPayload(device.deviceId, nonce),
        reason: 'Renew access to ${device.hostLabel}',
      );
      switch (signature) {
        case SignRefused():
          return RefreshOutcome.refused;
        case KeyGone():
          // Kept as a pairing, minus the promise: the bearer path and a new code remain.
          await credentials.remember(device.withRefreshKey(null));
          return RefreshOutcome.mustRepair;
        case Signed(signature: final signed):
          final renewal = await api.renew(
            deviceId: device.deviceId, nonce: nonce, signature: signed);
          await credentials.remember(device.renewed(renewal));
          // A socket that stopped on the lapsed bearer does not come back on its own.
          registry.connect(host);
          return RefreshOutcome.refreshed;
      }
    } on RenewalRefused {
      // The host holds no key for this device any more (rebuilt, or revoked): the local
      // half is useless, so it goes, and only a new pairing code gets back in.
      await keys.delete(alias);
      await credentials.remember(device.withRefreshKey(null));
      return RefreshOutcome.mustRepair;
    } on TransportUnavailable {
      return RefreshOutcome.notDue;
    } on ApiFailure {
      return RefreshOutcome.notDue;
    }
  }
}
