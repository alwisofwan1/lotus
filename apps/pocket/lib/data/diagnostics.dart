import '../hosts/credentials.dart';
import '../hosts/host_failure.dart';
import '../hosts/host_registry.dart';
import '../hosts/paired_host.dart';
import '../models/host_id.dart';
import '../models/pairing.dart';
import 'push_repository.dart';

/// Join registry, credential, and push policy in the data layer (ADR-13 no. 1).
class Diagnostics {
  const Diagnostics({required this.hosts, required this.unreadableEntries});

  /// **In registry order — the order they were paired, not sorted by health.** A list
  /// that put the failing host first would reorder itself while it is being read, as
  /// sockets connect and drop underneath the operator's finger. Two hosts is the
  /// designed maximum (ADR-3), so there is nothing to find by sorting.
  final List<HostDiagnosis> hosts;

  /// Keychain entries that could not be parsed. `Credentials` has surfaced these since
  /// it was written and nothing has ever rendered them — this screen is what makes the
  /// distinction it draws (one rotted entry, not an unpaired phone) reach the operator.
  final List<String> unreadableEntries;

  static Diagnostics of({
    required HostRegistry registry,
    required Credentials credentials,
    required PushRepository push,
    required DateTime now,
  }) =>
      Diagnostics(
        hosts: [
          for (final status in registry.statuses)
            HostDiagnosis._from(
              status,
              credentials.deviceFor(status.host.id),
              // **Only whether a token exists — never the token.** It is the capability
              // to ring this phone; the host does not put it in its own audit log
              // either (`device-routes.ts`). Reading it as a bool here is what keeps it
              // out of reach of anything that renders.
              phoneHasToken: push.currentToken != null,
              now: now,
            ),
        ],
        unreadableEntries: credentials.unreadable,
      );
}

/// One host, as five answers rather than one health verdict.
///
/// Each field answers a question the operator arrives with — *is it reachable, why is
/// there no Chat here, how long until I have to pair again, will it wake me* — and a
/// single rolled-up "OK / not OK" would answer none of them.
class HostDiagnosis {
  const HostDiagnosis({
    required this.host,
    required this.label,
    this.nickname,
    required this.origin,
    required this.mode,
    required this.connected,
    required this.reach,
    required this.features,
    required this.credential,
    required this.push,
  });

  final HostId host;

  /// What the machine calls itself — its hostname.
  final String label;

  /// What the operator calls it, when they have said so (`issues/11`). Null is not a
  /// gap to fill in with [label]: this screen shows both, and which of the two is
  /// missing is a fact the operator may want to change.
  final String? nickname;

  /// `http://100.64.0.3:8787` — **with the scheme**, not trimmed to `host:port`. The
  /// scheme is load-bearing here: it is what decides `ws` against `wss` on the socket,
  /// and getting that wrong produced a host that paired over HTTP and then never
  /// streamed (`host_socket.dart`).
  final String origin;

  /// `client` or `standalone`. Half the answer to a missing Chat; [features] is the
  /// other half, and the honest one.
  final String mode;

  final bool connected;

  /// Keep stable diagnostic slugs separate from operator-facing copy (`issues/06`).
  final String reach;

  /// Show unfiltered capabilities so absent features can be diagnosed.
  final List<String> features;

  /// Null when a host is registered with no credential behind it — a state that should
  /// not occur, and so exactly the kind of thing this screen exists to expose rather
  /// than paper over with a zero.
  final CredentialRunway? credential;

  final PushState push;

  /// Only a fresh pairing code gets this host back: the stored token lapsed or hit its
  /// ceiling, or the host has said it no longer takes it.
  bool get needsPairing {
    final runway = credential;
    if (runway == null || runway.expired || runway.pastCeiling) return true;
    return reach == const CredentialExpired().code || reach == const CredentialRevoked().code;
  }

  factory HostDiagnosis._from(
    HostStatus status,
    PairedDevice? device, {
    required bool phoneHasToken,
    required DateTime now,
  }) {
    final host = status.host;
    return HostDiagnosis(
      host: host.id,
      label: host.label,
      nickname: device?.nickname,
      origin: host.baseUri.toString(),
      mode: host.mode,
      connected: status.connected,
      reach: status.connected ? 'connected' : (status.failure?.code ?? 'not connected'),
      features: host.caps.features,
      credential: device == null ? null : CredentialRunway._of(device, now),
      push: switch ((host.canPush, phoneHasToken)) {
        (false, _) => PushState.hostCannotSend,
        (true, false) => PushState.phoneHasNoToken,
        (true, true) => PushState.tokenSent,
      },
    );
  }
}

/// The two clocks ADR-8 puts on a credential, as time remaining rather than as dates.
///
/// Remaining rather than absolute because the question is always "how long have I
/// got" — a timestamp makes the operator do the subtraction, on a phone, usually in
/// another timezone from the machine that issued it.
class CredentialRunway {
  const CredentialRunway({
    required this.tokenLeft,
    required this.ceilingLeft,
    required this.refreshDue,
  });

  /// Until the 72-hour TTL lapses. Negative once it has.
  final Duration tokenLeft;

  /// Until the 30-day ceiling, which no amount of refreshing moves.
  final Duration ceilingLeft;

  /// Inside [Credentials.refreshLead] — the next foreground will ask for biometrics
  /// and renew. Shown because a biometric prompt the operator did not expect reads as
  /// something being wrong.
  final bool refreshDue;

  bool get expired => tokenLeft <= Duration.zero;

  /// Past the ceiling: only a fresh pairing code gets back in, and no refresh will
  /// help. Distinct from [expired] because the way out is different.
  bool get pastCeiling => ceilingLeft <= Duration.zero;

  factory CredentialRunway._of(PairedDevice device, DateTime now) => CredentialRunway(
        tokenLeft: device.expiresAt.difference(now),
        ceilingLeft: device.hardExpiresAt.difference(now),
        refreshDue: device.refreshDueAt(now, lead: Credentials.refreshLead),
      );
}

/// Distinguish host and phone push failures because their remedies differ (ADR-4).
enum PushState {
  /// The host does not advertise `push`: no Firebase service account there, so it
  /// could not ring this phone even holding a token.
  hostCannotSend,

  /// The host could ring, but this phone holds no registration token — a build with no
  /// messaging plugin, or notifications declined.
  phoneHasNoToken,

  /// Report what was sent, not unverified registration success.
  tokenSent,
}
