import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../data/diagnostics.dart';
import '../../data/measurement_log.dart';
import '../../data/readdress_outcome.dart';
import '../../models/app_build.dart';
import '../../models/host_id.dart';
import '../shared/host_label.dart';
import '../shared/refreshable.dart';
import '../shared/name_machine.dart';
import 'widgets/app_build_block.dart';
import 'widgets/host_block.dart';
import 'widgets/pair_another.dart';
import 'widgets/unreadable_entries.dart';
import 'widgets/measurement_log_block.dart';
import 'widgets/readdress_dialog.dart';

/// Diagnostics: the machines this phone is paired with, and what it knows about each.
///
/// The third surface `PLAN.md` §4.2 names, reached from the switcher sheet rather than
/// from a tab bar — the app has no tab bar, and adding one to reach a screen visited
/// twice a month would cost every screen a row of chrome.
///
/// **It answers questions the rest of the app deliberately cannot.** Everywhere else,
/// Pocket hides what a host does not advertise: no Chat on a Standalone Host, no push
/// registration where there is no service account. That rule is what keeps the other
/// screens calm, and it is also what makes an absent capability indistinguishable from
/// a broken one. This is where the difference is written down.
///
/// **No settings, despite the entry that opens it being called that.** There is
/// nothing here to configure: every value is measured, and the two controls act on a
/// pairing rather than on a preference — move a host to a new address, or give it up.
/// A preference would need a reason to exist, and none of the decisions this app makes
/// — TTL, gate, push scope — are the operator's to tune.
///
/// The address one earns its place here rather than in a settings screen that does not
/// exist: this is where a host reads `not connected`, and the commonest cause is that
/// the machine's IP moved. The fix belongs beside the symptom.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    required this.read,
    required this.revision,
    required this.onUnpair,
    required this.onReaddress,
    required this.onRename,
    required this.onPairAnother,
    required this.onPairAgain,
    required this.onRefresh,
    required this.measurements,
    required this.running,
    super.key,
  });

  /// Reads a fresh snapshot. A function rather than a `Diagnostics` value because two
  /// of its fields are clock-dependent — a credential's runway is wrong the moment it
  /// is captured — so it is recomputed on every rebuild.
  final Diagnostics Function() read;

  /// What makes those rebuilds happen: the registry and the credential store, merged
  /// by `app/`. Taken as a bare [Listenable] rather than as the two objects, so this
  /// screen cannot reach a socket through the thing it listens to (ADR-13 no. 1).
  final Listenable revision;

  /// Returns once the host is gone. Handed down rather than called on a repository
  /// here, for the same reason: unpairing is policy, and `data/` owns the order it
  /// happens in.
  final Future<void> Function(HostId host) onUnpair;

  /// Moves a host to a new address, keeping its credential.
  ///
  /// Handed down for the same reason [onUnpair] is: the gate, the parse and the order
  /// of the writes are policy, and `data/` owns all three. What comes back is the
  /// outcome rather than a sentence, because turning an outcome into words is copy —
  /// and every other line of copy in this app lives in `features/`.
  final Future<ReaddressOutcome> Function(HostId host, String address) onReaddress;

  /// Re-dials every socket and re-reads every host.
  ///
  /// **This screen reports the result without being told it.** Every row here is
  /// measured from the registry and the credential store, and [revision] already
  /// rebuilds when either changes — so a host that comes back flips its own `reach`
  /// line, and one that stays down keeps its cause. That is why there is no notice on
  /// this surface, unlike Home: the evidence the operator pulled to see *is* the list,
  /// and a snackbar would cover it.
  final Future<void> Function() onRefresh;

  /// Renames a machine on this phone, or clears the name with null. Handed down like
  /// its neighbours: the store belongs to `data/`, and a widget does not get to write
  /// to it (ADR-13 no. 1).
  final Future<void> Function(HostId host, String? nickname) onRename;

  /// Opens the pairing flow for an **additional** machine.
  ///
  /// This screen is where it lives because it is the only surface that already talks
  /// about the set of paired machines. Before this existed, `OnboardingScreen` was
  /// reachable only when that set was *empty*, so a phone with one machine had no way
  /// to add a second short of giving up the first — which ADR-3 makes a v1
  /// requirement, and which the data layer had supported all along.
  ///
  /// A bare callback: routing belongs to `app/`, and this screen decides nothing
  /// about what the flow does when it finishes.
  final VoidCallback onPairAnother;

  /// The same flow, at the address of a host whose credential has died.
  final void Function(String address) onPairAgain;

  /// Fase 0 counting (`plans/session-history-hardening/issues/01`) — read, not
  /// listened to: it is deliberately not a `ChangeNotifier` (see its own doc), so
  /// [MeasurementLogBlock] shows a snapshot rather than joining [revision].
  final MeasurementLog measurements;

  /// This phone's build, shown last (see [AppBuildBlock]).
  final AppBuild running;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: t.bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        title: Text(
          'Diagnostics',
          style: t.ui.copyWith(fontSize: 16, fontWeight: FontWeight.w500, color: t.text),
        ),
        iconTheme: IconThemeData(color: t.dim),
      ),
      body: SafeArea(
        top: false,
        child: ListenableBuilder(
          listenable: revision,
          builder: (context, _) => _body(context, read()),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, Diagnostics diagnostics) {
    final t = context.tokens;

    return Refreshable(
      onRefresh: onRefresh,
      child: ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
      children: [
        for (final (i, host) in diagnostics.hosts.indexed)
          DecoratedBox(
            decoration: BoxDecoration(
              border: Border(top: i == 0 ? BorderSide.none : BorderSide(color: t.line)),
            ),
            child: HostBlock(
              host: host,
              onUnpair: () => _confirmUnpair(context, host),
              onReaddress: () => _changeAddress(context, host),
              onRename: () => _rename(context, host),
              onPairAgain: () => onPairAgain(host.origin),
            ),
          ),
        PairAnother(onTap: onPairAnother),
        if (diagnostics.unreadableEntries.isNotEmpty)
          UnreadableEntries(keys: diagnostics.unreadableEntries),
        MeasurementLogBlock(measurements: measurements),
        AppBuildBlock(running: running),
      ],
      ),
    );
  }

  /// Asks what this phone should call the machine.
  ///
  /// **No gate and no confirmation.** ADR-8 gates what reaches a machine; this changes
  /// a word on this phone. It is also the one control here that is undone by using it
  /// again, so a confirmation step would cost more than the mistake it prevents.
  ///
  /// The same sheet the pairing screen shows, deliberately: naming a machine is one
  /// thing, and two versions of it would be two places for the wording to drift.
  Future<void> _rename(BuildContext context, HostDiagnosis host) async {
    final chosen = await showNameMachine(
      context,
      hostLabel: host.label,
      // The name it already has, else the guess. Opening this on an empty field would
      // make a rename feel like starting over.
      suggestion: host.nickname ?? suggestedNickname(host.label),
    );
    if (chosen == null || !context.mounted) return;

    await onRename(host.host, switch (chosen) {
      MachineNamed(:final name) => name,
      // Clearing the field is how an operator goes back to the hostname.
      MachineUnnamed() => null,
    });
  }

  /// Asks where the host is now, and reports what came back.
  ///
  /// **No confirmation step, unlike unpairing.** The dialog *is* the deliberation —
  /// the operator types an address — and what follows is reversible by typing another
  /// one. The biometric prompt behind it (ADR-8) is the only gate this needs, and it
  /// happens after the address is known to be readable so a typo never costs a
  /// fingerprint.
  Future<void> _changeAddress(BuildContext context, HostDiagnosis host) async {
    final typed = await showDialog<String>(
      context: context,
      builder: (_) => ReaddressDialog(label: host.label, origin: host.origin),
    );
    // Null is Cancel. An empty string is a field the operator emptied, which
    // `readAddress` refuses with its own words — so it is still worth sending.
    if (typed == null || !context.mounted) return;

    final notice = _noticeFor(await onReaddress(host.host, typed));
    if (notice == null || !context.mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(notice)));
  }

  /// **Success says nothing.** The origin line and the `reach` row under it are already
  /// rebuilding from the registry, and a snackbar announcing victory would sit on top
  /// of the evidence the operator came here to read.
  static String? _noticeFor(ReaddressOutcome outcome) => switch (outcome) {
        ReaddressDone() => null,
        ReaddressRefused() => 'Not changed — the address stays as it was.',
        // The parser's own words. It is the only thing that knows which part of what
        // was typed it could not read.
        ReaddressUnreadable(:final reason) => reason,
      };

  /// Confirms, because the way back in is an 8-digit code from a machine the operator
  /// may not be sitting at.
  ///
  /// The dialog says what unpairing does *not* undo, since that is the part nobody
  /// guesses: the agents keep running. Pocket is a remote control, and putting the
  /// remote down does not stop the machine (`map.md` — work belongs to the host).
  Future<void> _confirmUnpair(BuildContext context, HostDiagnosis host) async {
    final t = context.tokens;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Color.alphaBlend(t.raise, t.bg),
        title: Text('Unpair ${host.label}?',
            style: t.ui.copyWith(fontSize: 16, fontWeight: FontWeight.w500, color: t.text)),
        content: Text(
          'This phone loses its key and stops showing this machine. Agents there keep '
          'running. Pairing again needs a new code from Lotus.',
          style: t.ui.copyWith(fontSize: 13, height: 1.5, color: t.muted),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('Cancel', style: t.ui.copyWith(fontSize: 13.5, color: t.dim)),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('Unpair',
                style: t.ui.copyWith(
                    fontSize: 13.5, fontWeight: FontWeight.w600, color: t.error)),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    await onUnpair(host.host);
  }
}
