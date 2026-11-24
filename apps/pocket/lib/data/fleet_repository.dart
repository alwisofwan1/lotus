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

  /// Hosts with a reconnect-driven refresh already in flight.
  ///
  /// A socket that flaps says `hello` on every attach, and without this each one
  /// would start its own `GET /m/bootstrap` on a host that is evidently having a
  /// bad time. Deliberately **not** applied to [hydrate]: that one builds a
  /// report naming which hosts answered, and a silent skip would make it lie.
  final Set<HostId> _refreshing = {};

  /// Re-reads a host the moment its socket comes back.
  ///
  /// **`projects[]` arrives only in `GET /m/bootstrap`.** The live socket carries
  /// `fleet.changed`, which is cells and nothing else — so a project opened or
  /// closed on the machine after the phone's cold start stayed invisible until
  /// the app was killed and reopened. That is what made the switcher's dormant
  /// group read as frozen: it was, since boot (ADR-14, `issues/09`).
  ///
  /// `hello` is the right trigger because it is what a *reconnection* looks like
  /// from here, and a reconnection is exactly the moment the phone's picture of a
  /// machine may have gone stale — the socket was down, so no `fleet.changed`
  /// reached it either.
  ///
  /// One consequence, stated rather than hidden: at cold start `connectAll` and
  /// [hydrate] both run, so the first `hello` lands while the boot fetch may still
  /// be in flight and that host is read twice. Two parallel GETs once per launch
  /// is cheaper than the state it would take to tell the two apart.
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

  /// What a pull-to-refresh actually does.
  ///
  /// **Both halves, and the order matters.** [HostRegistry.connectAll] re-dials any
  /// socket that is down — which is the whole reason the operator pulled, since a live
  /// socket would already be delivering `fleet.changed` and there would be nothing to
  /// refresh. [hydrate] then fetches over HTTP without waiting for those dials to
  /// finish, because a socket that is going to come back may take a backoff cycle to do
  /// it and the operator is holding the screen open right now.
  ///
  /// `connectAll` returns immediately by design (R-11), so this is not a race being
  /// ignored: the two paths converge on the same store, and whichever answers first
  /// wins. A reconnect that lands later re-reads the host on its own `hello`, through
  /// the listener above.
  ///
  /// **Awaiting the HTTP half is what makes the gesture honest.** A refresh indicator
  /// that hides before anything arrived teaches the operator that pulling does nothing,
  /// and on a phone that is away from the machine, *did it work* is the entire question.
  /// So this resolves when the fetches do, and the report says which hosts answered.
  Future<HydrationReport> refreshAll() async {
    registry.connectAll();
    return hydrate();
  }

  void dispose() {
    _hellos.cancel();
  }

  /// Fills the store from every paired host.
  ///
  /// Each host lands in the store the moment it answers, so a fast VPS draws while a
  /// sleeping MacBook is still timing out — R-11 is about exactly this, and awaiting a
  /// set would hold the whole screen hostage on the slowest machine.
  ///
  /// **No `workspaceId` filter, deliberately.** The route narrows its cells when given
  /// one, and Home needs the *whole* fleet: the `elsewhere` row exists to keep a waiting
  /// agent in another project visible, and it cannot be built from a list that was
  /// filtered to the current project (ADR-3, second revision).
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

  /// Marks a host as stale rather than dropping its cells.
  ///
  /// Whatever it last told us stays on screen: a fleet that suddenly empties reads as
  /// "all my work is gone", which is worse than showing something old and labelled
  /// (R-9). On a genuinely first cold start there is nothing to keep, and the mark is
  /// then what the empty state is built from.
  void _lose(HostId host, HostFailure failure, Map<HostId, HostFailure> failed) {
    failed[host] = failure;
    store.markUnreachable(host);
  }
}
