import 'dart:math';

import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/refresh_keys.dart';
import '../core/transport.dart';
import '../hosts/credentials.dart';
import '../hosts/host_failure.dart';
import '../hosts/host_registry.dart';
import '../hosts/paired_host.dart';
import '../models/host_id.dart';
import 'fleet_store.dart';
import 'snippets.dart';
import 'pairing_address.dart';
import 'pairing_outcome.dart';
import 'readdress_outcome.dart';

/// Redeeming an 8-digit code for a device token, and everything that must follow it
/// (ADR-5).
///
/// Policy lives here rather than on the screen for the same reason
/// [AgentRepository]'s gate does: there is exactly one way into the app, and a widget
/// must not be able to store a credential without also registering the host, or
/// register a host without storing the credential. Half of either leaves an app that
/// believes it is paired and cannot connect.
///
/// **No biometric gate, deliberately.** ADR-8 gates *mutations*, which presuppose a
/// credential; there is none yet here. What stands in its place is the host's own
/// pairing code: single-use, five minutes, and five failed attempts drop every
/// pending code (`packages/host/src/adapters/mobile/pairing.ts`).
class PairingRepository {
  const PairingRepository({
    required this.credentials,
    required this.registry,
    required this.transport,
    required this.fleet,
    required this.snippets,
    this.keys = const NoRefreshKeys(),
  });

  /// Injected collaborators, visible at the call site (ADR-13 no. 4).
  final Credentials credentials;
  final HostRegistry registry;

  /// What the unpaired host left on screen. Taken here rather than cleared by the
  /// diagnostics screen, so that "unpairing removes a machine entirely" is one
  /// statement in one place instead of a widget remembering to tidy up (ADR-13
  /// no. 1: `features/` decides no policy).
  final FleetStore fleet;

  /// Kept lines are per machine, so they leave with the machine.
  final Snippets snippets;

  /// The HTTP seam. Held directly because `POST /m/pair` is the one route with no
  /// bearer and no host to ask for a [HostApi] — the host's identity arrives in the
  /// reply, so there is nothing to construct one from beforehand.
  final HttpTransport transport;

  /// Where a pairing's hardware-bound refresh key is made and dropped (`refresh_keys.dart`).
  final RefreshKeys keys;

  /// Redeems [code] against [address] and, on success, joins the host to the running
  /// app: credential stored, host registered, socket dialling.
  ///
  /// The order is not arbitrary. Storage happens **before** the registry, because a
  /// host that is registered but whose token was never written would work until the
  /// next cold start and then be silently gone.
  Future<PairingOutcome> pair({
    required String address,
    required String code,
    required String deviceName,
  }) async {
    final reading = readAddress(address);
    if (reading is AddressUnreadable) return PairingAddressUnreadable(reading.reason);
    final baseUri = (reading as AddressReadable).uri;

    // Made before the request, because its public half rides in it. Null on a phone that
    // cannot hold one, and that phone pairs exactly as before.
    final alias = 'lotus-refresh-${_suffix()}';
    final publicKey = await keys.create(alias);
    var keyKept = false;
    try {
      final paired = await HostApi.pair(
        transport: transport,
        baseUri: baseUri,
        pairingCode: code.trim(),
        deviceName: deviceName.trim().isEmpty ? 'Lotus Pocket' : deviceName.trim(),
        refreshKey: publicKey,
      );
      // A host older than `device-renew` ignored the key, so keeping it would promise a
      // renewal nobody can grant.
      keyKept = publicKey != null && paired.caps.features.contains('device-renew');
      final device = paired.withRefreshKey(keyKept ? alias : null);
      // Re-pairing a machine replaces its entry, and the key the old entry named with it.
      final previous = credentials.deviceFor(device.hostId)?.refreshKeyAlias;
      if (previous != null) await keys.delete(previous);

      await credentials.remember(device);
      registry.add(PairedHost(
        id: device.hostId,
        label: device.hostLabel,
        baseUri: device.baseUri,
        mode: device.mode,
        caps: device.caps,
      ));
      // Not awaited, and not a shortcut: a socket retries for as long as the host
      // stays quiet, so awaiting it here would hold the screen on a machine that has
      // already proved it is reachable by answering this very request (R-11).
      registry.connect(device.hostId);

      return PairingSucceeded(device);
    } on PairingRejected {
      return const PairingCodeRefused();
    } on TooManyPairingAttempts catch (failure) {
      return PairingThrottled(failure.reason);
    } on TransportUnavailable catch (failure) {
      return PairingUnreachable(HostFailure.fromCause(failure.cause));
    } on HostRejected catch (failure) {
      return PairingHostFaulted(failure.reason);
    } on ApiFailure catch (failure) {
      // Everything left is a host that answered something unusable. `toString` on
      // `HostFaulted` already carries the status and the host's own words.
      return PairingHostFaulted('$failure');
    } finally {
      if (publicKey != null && !keyKept) await keys.delete(alias);
    }
  }

  static String _suffix() {
    final random = Random.secure();
    return List.generate(8, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }

  /// What this phone calls a machine, or null to fall back to its hostname.
  ///
  /// Routed through here rather than letting a screen hold [Credentials] directly, for
  /// the reason this class exists at all: `features/` reads `data/`, and the store is
  /// not something a widget gets to reach into (ADR-13 no. 1). Nothing is sent to the
  /// machine — the name is the phone's own word for it (`issues/11`).
  Future<void> rename(HostId host, String? nickname) =>
      credentials.rename(host, nickname);

  /// How many machines this phone is paired with, which is what decides whether a
  /// machine's name is drawn at all (`hostQualifier`).
  int get pairedCount => credentials.devices.length;

  /// Points an existing pairing at a new address, keeping its token.
  ///
  /// The address is the one field on a credential that goes stale on its own. The host
  /// binds a literal IP — `host_runtime::interfaces` refuses a hostname outright — and
  /// `PairedHost.withHello` deliberately keeps [PairedHost.baseUri] across every
  /// reconnection, so until this existed a DHCP lease moving meant unpairing, walking
  /// to the machine, minting a code, and typing an address again. Nothing had been
  /// revoked; the phone simply no longer knew where to look.
  ///
  /// **Gated, unlike [unpair], and the asymmetry is deliberate.** ADR-8 gates what
  /// reaches a machine, and this reaches one: it decides where the bearer gets sent
  /// next, so somebody holding an unlocked phone could otherwise point a live token at
  /// a server of their own and collect it. Refusing costs nothing — the old address
  /// stands and every host keeps working — whereas gating [unpair] could strand a
  /// phone holding a dead credential it is not allowed to drop.
  ///
  /// The order mirrors [pair] for the same reason: stored before registered, because a
  /// host dialling an address that was never written would work until the next cold
  /// start and then quietly revert.
  Future<ReaddressOutcome> readdress({
    required HostId host,
    required String address,
  }) async {
    final device = credentials.deviceFor(host);
    if (device == null) {
      // No credential to move. Not reachable from the diagnostics screen, which only
      // lists hosts the registry knows — but the registry and the store are separate
      // maps, and this is the seam where they could disagree.
      return const ReaddressUnreadable('This phone has no key for that machine.');
    }

    final reading = readAddress(address);
    if (reading is AddressUnreadable) return ReaddressUnreadable(reading.reason);
    final baseUri = (reading as AddressReadable).uri;

    final verdict = await credentials.gate.authorize('Move ${device.hostLabel} to $address');
    if (!verdict.allowed) return const ReaddressRefused();

    final moved = device.at(baseUri);
    await credentials.remember(moved);
    // `add` replaces rather than duplicates, retiring the socket that was dialling the
    // old address first — which is what this call is for. Without it the previous
    // connection would keep its backoff pointed at an address nothing answers on.
    registry.add(PairedHost(
      id: moved.hostId,
      label: moved.hostLabel,
      baseUri: baseUri,
      mode: moved.mode,
      caps: moved.caps,
    ));
    registry.connect(moved.hostId);

    return const ReaddressDone();
  }

  /// Hands a credential back and forgets it — [pair] run backwards, and the only way
  /// out of a pairing from the phone.
  ///
  /// Three deliberate properties, in the order they bite:
  ///
  /// - **The host is told first, and best-effort.** `DELETE /m/devices/:deviceId` kills
  ///   the token there and then; without it the host keeps a live credential and a push
  ///   destination for a phone that has walked away, until the 72-hour TTL runs out.
  /// - **An unreachable host does not block it.** The commonest reason to unpair is a
  ///   machine that is gone, and an unpair that only works while the host answers would
  ///   be no way out at all. What is lost is the early revoke, not the unpairing.
  /// - **The registry goes before the credential.** The reverse of [pair], because the
  ///   failure it avoids is the reverse too: a socket left holding a token that no
  ///   longer exists would reconnect into 401s.
  ///
  /// Local, not a mutation against the fleet, so **no biometric gate** (ADR-8 gates
  /// what reaches a machine). Gating it would also be backwards in practice: the state
  /// that most needs clearing is a dead credential, and putting it behind a prompt that
  /// can fail is how a phone gets stuck listing a host it cannot use or remove.
  Future<void> unpair(HostId host) async {
    final device = credentials.deviceFor(host);
    final api = registry.apiFor(host);

    if (device != null && api != null) {
      try {
        await api.revokeDevice(device.deviceId);
      } on TransportUnavailable {
        // Asleep, or off the tailnet. See above.
      } on ApiFailure {
        // Already revoked from the desktop, or a host that predates the route.
      }
    }

    registry.remove(host);
    await credentials.forget(host);
    final alias = device?.refreshKeyAlias;
    if (alias != null) await keys.delete(alias);
    // Everything the machine left behind goes with it. Its cells and projects are
    // not merely stale now — they are unreachable, and an index row that cannot be
    // opened is worse than one that is missing.
    //
    // `LastProject` used to be cleared here too. It was retired on 2026-08-11 with the
    // screen that read it: the app opens on the project index, so which project was open
    // last is no longer a fact the app keeps — and a store nothing reads cannot go stale.
    fleet.forget(host);
    await snippets.forgetHost(host);
  }
}
