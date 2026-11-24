import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/transport.dart';
import '../hosts/biometric_gate.dart';
import '../hosts/credentials.dart';
import '../hosts/host_failure.dart';
import '../hosts/host_registry.dart';
import '../models/host_id.dart';
import 'mutation_outcome.dart';

/// The gate every mutation passes, for any host — freshness first, then proof.
///
/// Lifted out of `AgentRepository` when a second repository needed exactly the same
/// policy (`plans/pocket-vps-project-checkout/issues/04`). It is deliberately **one**
/// object rather than a mixin or a copied method: ADR-8 and ADR-12 no. 2 are the two
/// rules a screen must not be able to skip, and two copies of them is one copy that
/// will eventually differ.
class HostGate {
  const HostGate({
    required this.registry,
    required this.credentials,
    required this.gate,
  });

  final HostRegistry registry;
  final Credentials credentials;
  final BiometricGate gate;

  /// Runs [action] against [host], once the operator has proved they are there.
  ///
  /// Starting an agent has no pane to address yet, and that is the only difference —
  /// the freshness check, the biometric prompt, and every failure this can answer with
  /// are the same, so they stay in one method rather than being copied for the one
  /// mutation that arrives before its cell exists.
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
