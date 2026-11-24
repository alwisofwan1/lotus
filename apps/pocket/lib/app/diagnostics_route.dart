import 'dart:async';

import 'package:flutter/material.dart';

import '../data/diagnostics.dart';
import '../features/onboarding/onboarding_screen.dart';
import '../features/settings/settings_screen.dart';
import 'composition_root.dart';

/// The two routes reached from Diagnostics, and the reason they are one file.
///
/// Diagnostics is the only surface that talks about the *set* of paired machines, so
/// it owns both ends of changing that set: giving one up, and adding one. Splitting
/// them would put the pairing push somewhere that does not know why it is reachable.
///
/// Lifted out of `pocket_app.dart` when adding the second route pushed that file past
/// the 300-line limit — which is the limit doing its job: this was already a
/// collaborator hiding inside a widget.
  /// Pushes the diagnostics screen, which is where the object graph gets joined up.
  ///
  /// The `read` closure is what keeps three `ChangeNotifier`s out of a widget: it is
  /// evaluated on every rebuild, so a socket dropping and a token renewing both land on
  /// screen without that screen ever holding a registry (ADR-13 no. 1).
  ///
  /// Unpairing pops **only when nothing is left to diagnose**. With another host still
  /// paired, staying is right: the list rebuilds without the one that went, which is
  /// the confirmation. With none left, `Credentials.forget` has already notified and
  /// onboarding has replaced Home underneath this route, so leaving the operator on an
  /// empty Diagnostics with a back button would hide the screen they now need.
  void openDiagnostics(BuildContext context, CompositionRoot root) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsScreen(
          read: () => Diagnostics.of(
            registry: root.registry,
            credentials: root.credentials,
            push: root.push,
            now: root.now(),
          ),
          revision: Listenable.merge([root.registry, root.credentials]),
          onUnpair: (host) async {
            await root.pairing.unpair(host);
            if (root.credentials.devices.isEmpty && context.mounted) {
              Navigator.of(context).pop();
            }
          },
          // Straight through: the gate, the parse and the write order are all inside
          // `readdress`, and the words for what came back belong to the screen.
          onReaddress: (host, address) =>
              root.pairing.readdress(host: host, address: address),
          // The rename notifies `Credentials`, which this route already listens to —
          // so the block redraws, and so does Home behind it, without either being
          // told about the other.
          onRename: root.pairing.rename,
          // Pushed on top of Diagnostics rather than replacing it: the operator is
          // adding to the list they are looking at, and coming back to see the new
          // machine in it is the confirmation. `LaunchShell` cannot do this — it only
          // ever shows the pairing screen to a phone with *no* machines.
          onPairAnother: () => _pairAnother(context, root),
          // Re-pairing replaces the entry in place: the host answers with the same id,
          // and both `Credentials` and `HostRegistry` key by it.
          onPairAgain: (address) => _pairAnother(context, root, address: address),
          // The same operation Home's pull runs. Diagnostics is where an operator lands
          // *because* something is wrong, so the ability to ask again belongs here at
          // least as much as it does there.
          onRefresh: root.fleetRepository.refreshAll,
          measurements: root.measurements,
          running: root.buildSeen.current,
        ),
      ),
    );
  }

  /// Pushes the pairing screen to add a machine beside the ones already paired.
  ///
  /// **The same screen the first run shows**, with `onBack` supplied — one pairing
  /// path, one set of failures, one diagnosis, exactly as `OnboardingScreen` argues
  /// for the typed fields. A second screen here would be a second place for the
  /// address parser and the four-way diagnosis to drift.
  ///
  /// It pops itself on success. Diagnostics rebuilds from `Credentials`, which the
  /// pairing already notified, so the machine is in the list by the time the route is
  /// gone — no refresh, and no empty beat where the operator wonders if it worked.
  void _pairAnother(BuildContext context, CompositionRoot root, {String? address}) {
    final navigator = Navigator.of(context);
    navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => OnboardingScreen(
          pairing: root.pairing,
          scanner: root.scanner.view,
          onBack: navigator.pop,
          initialAddress: address,
          onPaired: () {
            // Same two follow-ups the first pairing does: a freshly joined host has a
            // socket but no cells until something moves, and it has never been told
            // where to ring.
            unawaited(root.fleetRepository.hydrate());
            unawaited(root.push.start());
            navigator.pop();
          },
        ),
      ),
    );
  }
