import 'dart:async';

import '../core/api_failure.dart';
import '../core/transport.dart';
import '../hosts/credentials.dart';
import '../hosts/host_failure.dart';
import '../hosts/host_registry.dart';
import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import 'fleet_store.dart';

/// Which hosts answered a cold start, and what stopped the ones that did not.
class HydrationReport {
  const HydrationReport({required this.answered, required this.failed});

  final List<HostId> answered;

  /// Named causes, not a count: "2 hosts failed" is not something an operator can act
  /// on, while "the mac is asleep" is.
  final Map<HostId, HostFailure> failed;

  bool get complete => failed.isEmpty;

  /// Whether the screen has anything at all to draw.
  bool get anyAnswered => answered.isNotEmpty;
}

/// The cold start: one `GET /m/bootstrap` per host, all at once (R-11, ADR-12 no. 3).
///
/// A mobile client always starts cold, so this path is the common one rather than an
/// edge case — which is why it renders progressively instead of waiting for a set.
class FleetRepository {
  FleetRepository({
    required this.registry,
    required this.store,
    required this.credentials,
  }) {
    _hellos = registry.events.listen(_onEvent);
  }

  /// Injected collaborators, visible at the call site (ADR-13 no. 4).
  final HostRegistry registry;
  final FleetStore store;
  final Credentials credentials;

  late final StreamSubscription<HostEvent> _hellos;

  /// Coalesce reconnect refreshes without skipping explicit hydration reports.
  final Set<HostId> _refreshing = {};

  /// Refresh on reconnect because project changes are absent from socket updates (ADR-14, `issues/09`).
  void _onEvent(HostEvent hostEvent) {
    final (host, event) = hostEvent;
    if (event is! HelloEvent) return;
    if (!_refreshing.add(host)) return;
    unawaited(
      refresh(host).whenComplete(() => _refreshing.remove(host)),
    );
  }

  /// One host, re-read. The collectors [hydrate] threads through are local here:
  /// nothing is reporting on a background refresh, and a failure has already done
  /// its visible work by marking the host stale.
  Future<void> refresh(HostId host) => _hydrateOne(host, [], {});

  /// Reconnect and hydrate independently; await HTTP so refresh reports actual responses (R-11).
  Future<HydrationReport> refreshAll() async {
    registry.connectAll();
    return hydrate();
  }

  void dispose() {
    _hellos.cancel();
  }

  /// Load hosts independently and without project filtering so the full fleet remains visible (R-11, ADR-3).
  Future<HydrationReport> hydrate() async {
    final answered = <HostId>[];
    final failed = <HostId, HostFailure>{};

    await Future.wait(
      registry.hosts.map((host) => _hydrateOne(host.id, answered, failed)),
    );

    return HydrationReport(answered: answered, failed: failed);
  }

  Future<void> _hydrateOne(
    HostId host,
    List<HostId> answered,
    Map<HostId, HostFailure> failed,
  ) async {
    final api = registry.apiFor(host);
    if (api == null) {
      failed[host] = const HostUnknownFailure();
      return;
    }

    try {
      final boot = await api.bootstrap();
      // `workspaces` stays unstored — it is grouped from the same cells `adopt` is
      // taking, so keeping it would be a second source for a question already answered.
      // `projects` is a different question, and the one the switcher could not answer:
      // what exists here, running or not (ADR-14). A host too old to send it yields an
      // empty list, and the phone behaves exactly as it did before.
      store.adoptProjects(host, boot.projects);
      store.adoptRunners(host, boot.runners);
      store.adopt(host, boot.cells);
      answered.add(host);
    } on TransportUnavailable catch (failure) {
      _lose(host, HostFailure.fromCause(failure.cause), failed);
    } on HostUnauthorized {
      registry.reportUnauthorized(host, tokenStillValid: credentials.isUsable(host));
      _lose(host, registry.statusOf(host)?.failure ?? const HostUnknownFailure(), failed);
    } on ApiFailure {
      _lose(host, const HostUnknownFailure(), failed);
    }
  }

  /// Retain and label stale cells so a quiet host does not appear to lose work (R-9).
  void _lose(HostId host, HostFailure failure, Map<HostId, HostFailure> failed) {
    failed[host] = failure;
    store.markUnreachable(host);
  }
}
