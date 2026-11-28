import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../data/agent_repository.dart';
import '../../../hosts/host_failure.dart';
import '../../../models/cell.dart';
import '../../shared/host_label.dart';
import '../../shared/state_shapes.dart';

/// The read could not complete.
///
/// The cause was already named by `hosts/`; this only renders it, and offers the one
/// thing that might change the answer.
class AgentFailure extends StatelessWidget {
  const AgentFailure({required this.failure, required this.onRetry, super.key});

  final HostFailure? failure;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final (:icon, :title, :body, :tone) = stateFor(failure?.code);
    return OrbHero(
      icon: icon,
      title: title,
      body: body,
      tone: tone,
      primary: (label: 'Try again', onTap: onRetry),
    );
  }

  /// Grey when it fixes itself or waits on the world; red ink when the operator must act.
  static ({IconData icon, String title, String body, StateTone tone}) stateFor(String? code) => switch (code) {
        'host_asleep' => (
            icon: Icons.bedtime_outlined,
            title: 'Your Mac is asleep',
            body: 'This agent shows up again when it wakes.',
            tone: StateTone.quiet,
          ),
        'lotus_not_running' => (
            icon: Icons.power_settings_new,
            title: 'Lotus is not running',
            body: 'The machine answered, but Lotus is closed on it.',
            tone: StateTone.quiet,
          ),
        'tailnet_down' => (
            icon: Icons.cloud_off_outlined,
            title: 'No route to your Mac',
            body: 'Check Tailscale on this phone and on the Mac.',
            tone: StateTone.quiet,
          ),
        'credential_expired' => (
            icon: Icons.key_off_outlined,
            title: 'Access expired',
            body: 'Pair this phone again from your Mac.',
            tone: StateTone.act,
          ),
        'credential_revoked' => (
            icon: Icons.phonelink_erase_outlined,
            title: 'This phone was removed',
            body: 'It was revoked on the desktop. Pair it again to come back.',
            tone: StateTone.act,
          ),
        _ => (
            icon: Icons.error_outline,
            title: 'Could not read this agent',
            body: 'Try again in a moment.',
            tone: StateTone.quiet,
          ),
      };
}

/// This host records no hook events, so Chat has nothing to draw — and says which of
/// the two reasons it is.
///
/// The reason is stated **once**, with nouns the operator recognises — an empty Chat
/// would leave them guessing whether the agent is silent or the app is broken
/// (`MVP.md`, §7 no. 10). Drawn as a separator with a rule beneath it, never a block
/// with a coloured stripe down its left: that shape is banned in this design.
class TerminalOnlyNotice extends StatelessWidget {
  const TerminalOnlyNotice({
    required this.cell,
    required this.reason,
    required this.onOpenTerminal,
    super.key,
  });

  final Cell cell;

  /// Decides the sentence. Both readings end at the raw terminal, but only one of them
  /// is worth walking to the desktop over.
  final ChatBlocked reason;

  final VoidCallback onOpenTerminal;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(left: 18, right: 18, top: 16),
      children: [
        Container(
          margin: const EdgeInsets.only(bottom: 18),
          padding: const EdgeInsets.only(bottom: 14),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.waiting))),
          child: Text(
            copyFor(reason, cell),
            style: t.mono.copyWith(fontSize: 11.5, height: 1.6, color: t.waiting),
          ),
        ),
        TextButton(
          onPressed: onOpenTerminal,
          child: Text(
            'RAW TERMINAL',
            style: t.mono.copyWith(fontSize: 11, letterSpacing: 1.76, color: t.dim),
          ),
        ),
      ],
    );
  }

  /// **Names the machine, then what is true of it** — in that order, because the
  /// operator is holding a phone that talks to more than one.
  ///
  /// [ChatBlocked.notRecording] deliberately does not say "hooks": that word means
  /// nothing on this screen, and the sentence has to survive being read by the person
  /// who will act on it. What it does say is that the desktop is where the fix is,
  /// which is the one thing distinguishing it from a Standalone Host.
  static String copyFor(ChatBlocked reason, Cell cell) {
    final machine = '${cell.projectName} · ${shortHostLabel(cell.host.value)}';
    return switch (reason) {
      ChatBlocked.noPipeline => '$machine has no hook pipeline, so there is no '
          'transcript to show. The raw terminal is the way through.',
      ChatBlocked.notRecording => '$machine is not recording what its agents do, so '
          'there is no transcript to show — check Lotus on that desktop. The raw '
          'terminal still works.',
      // Names the CLI, not the machine: nothing is wrong with the desktop, and sending
      // the operator there to look would waste the trip.
      ChatBlocked.runnerSilent => '${cell.runner} does not report the steps it takes, '
          'so there is no transcript to show. The raw terminal is the way through.',
      // Says "cannot tell yet", not "nothing is coming". The previous sentence sends the
      // operator away for good; this one must not, because the answer usually arrives on
      // its own once the desktop has a board on screen. Naming the desktop is what makes
      // the wait make sense instead of reading as a stuck screen.
      ChatBlocked.outlookUnknown => '$machine cannot tell yet whether ${cell.runner} '
          'reports its steps, so there is nothing to show. Pull to refresh, or use the '
          'raw terminal.',
    };
  }
}
