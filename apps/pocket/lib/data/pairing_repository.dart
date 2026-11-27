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

/// Pairing stores and registers together; the single-use code protects this pre-credential action (ADR-5, ADR-8).
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

  /// Store the credential before registering the host so pairing survives restart.
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

  /// Nicknames stay local and are exposed through the data layer (ADR-13 no. 1, `issues/11`).
  Future<void> rename(HostId host, String? nickname) =>
      credentials.rename(host, nickname);

  /// How many machines this phone is paired with, which is what decides whether a
  /// machine's name is drawn at all (`hostQualifier`).
  int get pairedCount => credentials.devices.length;

  /// Gate address changes because they redirect the bearer; persist before reconnecting (ADR-8).
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

  /// Revoke best-effort, then remove the socket before the credential; unpairing must remain possible without a gate (ADR-8).
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
    // Remove unreachable host data when unpairing.
    fleet.forget(host);
    await snippets.forgetHost(host);
  }
}
