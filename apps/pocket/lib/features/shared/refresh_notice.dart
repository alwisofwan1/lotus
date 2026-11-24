import 'package:flutter/material.dart';

import '../../data/fleet_repository.dart';
import '../../models/host_id.dart';

/// What to say after a pull-to-refresh, or null to say nothing.
///
/// **Success is silent, and that is a rule this app already follows.** The screen
/// behind the snackbar *is* the result — rows moved, the unreachable notice cleared, an
/// age reset to `now`. `SettingsScreen._noticeFor` makes the same argument for
/// re-addressing a host: a message announcing victory sits on top of the evidence the
/// operator pulled to see. So this speaks only when something did **not** answer.
///
/// Copy lives here rather than in `data/` for the reason the rest of this app splits
/// them: `HydrationReport` knows which hosts failed and why, and turning that into a
/// sentence is a decision about what the operator should read.
///
/// The phrases are deliberately shorter than [AgentFailure]'s. That one fills a centred
/// empty state and can afford a full sentence; this one has a snackbar's few seconds,
/// and it has to name **which machine** as well as what happened — a phone talks to
/// more than one, and "asleep" without a name is not something anyone can act on.
String? refreshNotice(
  HydrationReport report, {
  required String Function(HostId host) label,
}) {
  if (report.complete) return null;

  final failed = report.failed;
  if (failed.length == 1) {
    final entry = failed.entries.first;
    return '${label(entry.key)} ${_cause(entry.value.code)}';
  }

  // Past one, names stop helping: a snackbar cannot carry three of them and stay
  // readable, and the count plus Diagnostics is the honest short answer.
  return '${failed.length} machines did not answer. Diagnostics has the detail.';
}

/// The predicate half of the sentence, so the host's name can be the subject.
///
/// Reads as `mac is asleep.` — the machine first, then what is true of it, which is the
/// same order the Agent page's `TerminalOnlyNotice` uses and for the same reason.
String _cause(String? code) => switch (code) {
      'host_asleep' => 'is asleep.',
      'lotus_not_running' => 'answered, but Lotus is not running on it.',
      'tailnet_down' => 'is not reachable — check Tailscale.',
      'credential_expired' => 'needs unlocking — access expired while you were away.',
      'credential_revoked' => 'revoked this phone. Pair it again.',
      _ => 'did not answer.',
    };

/// Shows [refreshNotice], or nothing at all.
///
/// Lives beside the copy rather than in each screen so the "success is silent" rule is
/// one decision instead of one per surface — Home would otherwise be free to announce a
/// clean refresh while Diagnostics stayed quiet, and the difference would look like a
/// bug in whichever the operator saw second.
void showRefreshOutcome(
  BuildContext context,
  HydrationReport report, {
  required String Function(HostId host) label,
}) {
  final notice = refreshNotice(report, label: label);
  if (notice == null) return;
  ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(notice)));
}
