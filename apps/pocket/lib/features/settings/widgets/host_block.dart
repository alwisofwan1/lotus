import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../data/diagnostics.dart';
import '../../shared/runway_label.dart';

/// One host on the diagnostics screen: who it is, then four labelled answers.
///
/// A block of `label   value` rows rather than cards, chips or status dots. The
/// mockup's rule holds here too — the only filled shapes in this app are the two
/// things you press — and a coloured dot would have to mean something, when the whole
/// reason this screen exists is that "reachable" is four different situations.
class HostBlock extends StatelessWidget {
  const HostBlock({
    required this.host,
    required this.onUnpair,
    required this.onReaddress,
    required this.onRename,
    required this.onPairAgain,
    super.key,
  });

  final HostDiagnosis host;
  final VoidCallback onUnpair;

  /// Points this host at a new address without giving up the pairing.
  ///
  /// It sits beside Unpair rather than under an "advanced" disclosure because it is
  /// the *cheaper* of the two answers to the commonest failure on this screen: the
  /// host binds a literal IP, so a DHCP lease moving leaves a perfectly good
  /// credential pointing nowhere, and unpairing to fix that costs a walk to the
  /// machine and a new code.
  final VoidCallback onReaddress;

  /// Changes what this phone calls the machine. Local, unlike its two neighbours —
  /// nothing is sent anywhere — which is why it is the quiet one of the three
  /// (`issues/11`).
  final VoidCallback onRename;

  /// Opens pairing at this host's address. Shown only when [HostDiagnosis.needsPairing]
  /// — and first, because then it is the one action here that fixes anything.
  final VoidCallback onPairAgain;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Flexible(
                child: Text(
                  // The operator's word for the machine leads when there is one; the
                  // hostname keeps its place below, because that is what tells two
                  // MacBooks apart when the names do not.
                  host.nickname ?? host.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.ui.copyWith(fontSize: 16, fontWeight: FontWeight.w500, color: t.text),
                ),
              ),
              const SizedBox(width: 9),
              Text(host.mode, style: t.mono.copyWith(fontSize: 11.5, color: t.muted)),
            ],
          ),
          const SizedBox(height: 3),
          Text(
            host.nickname == null ? host.origin : '${host.label} · ${host.origin}',
            style: t.mono.copyWith(fontSize: 11, color: t.muted),
          ),
          const SizedBox(height: 16),
          _Row(label: 'reach', value: host.reach, mono: true, quiet: host.connected),
          _Row(
            // Verbatim, in the order the host sent them. Sorting would hide that this
            // is a transcript of one `hello` frame and not a checklist we authored.
            label: 'features',
            value: host.features.isEmpty ? 'none advertised' : host.features.join(' · '),
            mono: true,
          ),
          _Row(label: 'credential', value: _credential(host.credential)),
          _Row(label: 'push', value: _push(host.push)),
          const SizedBox(height: 6),
          // A `Wrap` rather than a `Row`: three actions no longer fit on one line on a
          // narrow phone, and a fourth would not fit on any of them. What must never
          // happen here is the third one being clipped — `Unpair` is the action an
          // operator comes to this screen for when a machine is gone.
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              if (host.needsPairing) _OutlinedAction(label: 'Pair again', onTap: onPairAgain),
              // Ordered by cost, cheapest first. `Rename` changes a word on this phone,
              // `Change address` changes where a live token gets sent, and `Unpair`
              // needs a code from a machine the operator may not be sitting at.
              _OutlinedAction(label: 'Rename', onTap: onRename),
              _OutlinedAction(label: 'Change address', onTap: onReaddress),
              _OutlinedAction(label: 'Unpair', onTap: onUnpair),
            ],
          ),
        ],
      ),
    );
  }

  /// Both clocks on one line, because they are only meaningful against each other:
  /// `19h left · repair in 12d` says the token is fine and the pairing is not forever.
  static String _credential(CredentialRunway? runway) {
    if (runway == null) return 'missing — this host has no stored token';
    if (runway.pastCeiling) return 'past the 30-day ceiling — pair again';
    if (runway.expired) return 'expired — pair again';
    final left = runwayLabel(runway.tokenLeft);
    final ceiling = runwayLabel(runway.ceilingLeft);
    return runway.refreshDue
        // Named before it happens, so the biometric prompt on the next foreground is
        // something the operator was told about rather than something going wrong.
        ? 'renews on next unlock · ceiling $ceiling'
        : '$left left · ceiling $ceiling';
  }

  static String _push(PushState push) => switch (push) {
        PushState.hostCannotSend => 'this host cannot send — no service account on it',
        PushState.phoneHasNoToken => 'no token on this phone',
        PushState.tokenSent => 'token sent to this host',
      };
}

/// `credential    19h left · ceiling 29d`
class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.mono = false, this.quiet = false});

  final String label;
  final String value;
  final bool mono;

  /// Dims the value when it is the unremarkable answer. Only `reach` uses it: a
  /// connected host is the state you are not reading this screen about.
  final bool quiet;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final base = mono ? t.mono : t.ui;

    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 88,
            child: Text(label, style: t.mono.copyWith(fontSize: 12, color: t.muted)),
          ),
          Expanded(
            child: Text(
              value,
              style: base.copyWith(
                fontSize: mono ? 11.5 : 12.5,
                height: 1.4,
                color: quiet ? t.muted : t.dim,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Outlined, never filled — the two filled shapes in this app are the send button and
/// the composer, and neither of those destroys anything. Red would also be the third
/// colour on a screen whose palette allows two, so the word carries it instead.
///
/// Both actions on this block share the treatment, which is a claim rather than
/// laziness: they are alternatives to each other, and making Unpair look heavier would
/// suggest it is the more thorough fix when it is usually just the more expensive one.
class _OutlinedAction extends StatelessWidget {
  const _OutlinedAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            border: Border.all(color: t.lineStrong),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            label,
            style: t.ui.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500, color: t.dim),
          ),
        ),
      ),
    );
  }
}
