import '../../models/bootstrap.dart';

/// The sentence under the permission track: what this stop lets the agent do, and **who
/// hears it when it asks**.
///
/// Two halves, because they answer to two different owners. The first is what the CLI does
/// and belongs to the stop. The second is what Lotus can do about it, and belongs to the
/// runner — a Claude cell's question arrives here as `needs-input`, a Codex cell in a
/// terminal asks the machine it is running on, and a headless Codex asks *this phone*
/// (`structured-sessions.ts`, `approvalPolicy: "on-request"`). The same word — `read only` —
/// therefore means something different depending on the terminal, and the operator cannot be
/// expected to know that. So it is said out loud.
///
/// **The copy lives here rather than on the wire.** The host advertises ids and labels; it
/// does not write this app's sentences, for the same reason `runner_description.dart` exists.
/// A stop this app has never heard of still renders — its label is the host's — it just gets
/// no sentence, which is the honest thing to show for a consequence nobody here can state.
String? permissionBlurb(
  RunnerPermission stop, {
  required bool gates,
  required bool headless,
}) {
  final does = _does[stop.id];
  if (does == null) return null;
  return '$does · ${_heard(stop.id, gates: gates, headless: headless)}';
}

/// What the agent may do, per stop. Single-clause on purpose: the second half is joined on,
/// and a first half that already branched would read as three facts rather than two.
const Map<String, String> _does = {
  'plan': 'reads and plans, changing nothing',
  'manual': 'asks before every action',
  'acceptEdits': 'writes files on its own, asks before it runs anything',
  'bypassPermissions': 'never asks',
  'read-only': 'reads only',
  'auto': 'writes inside the project, asks for the rest',
  'full-access': 'no sandbox, no asking',
  // The pair that predates the scale, still reachable from an older host.
  'safe': 'asks before every action',
  'yolo': 'never asks',
};

/// The stops on which nothing will ever be asked, so there is nothing for anyone to hear.
const Set<String> _silent = {'bypassPermissions', 'full-access', 'yolo'};

String _heard(String id, {required bool gates, required bool headless}) {
  // Not a warning and not a hedge: it is the one thing this phone loses by choosing it, and
  // the sheet is the last place that fact is worth anything.
  if (_silent.contains(id)) return 'the phone will not hear it';
  // A Claude-family cell raises `needs-input`, which is the notification this app is built
  // around. A headless cell has no terminal to ask into, so its approval comes here too.
  if (gates || headless) return 'this phone answers';
  return 'it asks on the machine, not here';
}
