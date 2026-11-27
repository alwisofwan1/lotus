import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/transport.dart';
import '../hosts/biometric_gate.dart';
import '../hosts/credentials.dart';
import '../hosts/host_failure.dart';
import '../hosts/host_registry.dart';
import '../models/host_id.dart';
import 'mutation_outcome.dart';

/// Share freshness and presence policy across mutation repositories (ADR-8, ADR-12 no. 2, `plans/pocket-vps-project-checkout/issues/04`).
class HostGate {
  const HostGate({
    required this.registry,
    required this.credentials,
    required this.gate,
  });

  final HostRegistry registry;
  final Credentials credentials;
  final BiometricGate gate;

  /// Use the same gate for actions before a cell exists.
  Future<MutationOutcome> run(
    HostId host,
    String reason,
    Future<void> Function(HostApi api) action,
  ) async {
    final api = registry.apiFor(host);
    if (api == null) return const MutationUnknownHost();

    // Freshness first, and it may prompt. When it does, that one prompt is also this
    // mutation's proof: both rules ask the operator for the same thing in the same
    // gesture, and prompting twice in one tap would train them to tap through prompts —
    // which is how a gate stops being one.
    final RefreshOutcome refreshed;
    try {
      refreshed = await credentials.refreshIfDue(host, api.refreshToken);
    } on TransportUnavailable catch (failure) {
      return MutationUnreachable(HostFailure.fromCause(failure.cause));
    } on ApiFailure {
      return const MutationNeedsPairing();
    }

    switch (refreshed) {
      case RefreshOutcome.mustRepair:
        return const MutationNeedsPairing();
      case RefreshOutcome.refused:
        return const MutationRefused();
      case RefreshOutcome.refreshed:
        break; // Proof was just given; do not ask again for the same gesture.
      case RefreshOutcome.notDue:
        if (!(await gate.authorize(reason)).allowed) return const MutationRefused();
    }

    try {
      await action(api);
      return const MutationSent();
    } on NoLiveSession catch (failure) {
      return MutationNoLiveSession(failure.paneId);
    } on HostRejected catch (failure) {
      return MutationRejected(failure.reason);
    } on HostUnauthorized {
      return MutationNeedsPairing(cause: reportUnauthorized(host));
    } on RefreshRefused {
      return const MutationNeedsPairing();
    } on PairingRejected {
      return const MutationNeedsPairing();
    } on HostFaulted catch (failure) {
      return failure.status == 503 ? MutationHostNotReady(failure.reason) : MutationRejected(failure.reason);
    } on TransportUnavailable catch (failure) {
      return MutationUnreachable(HostFailure.fromCause(failure.cause));
    }
  }

  /// Tells the registry a credential was refused, and answers with what that means
  /// for this host — revoked, or aged out.
  HostFailure? reportUnauthorized(HostId host) {
    registry.reportUnauthorized(host, tokenStillValid: credentials.isUsable(host));
    return registry.statusOf(host)?.failure;
  }
}
