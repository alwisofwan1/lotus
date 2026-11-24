import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/project_repository.dart';
import '../../models/clone_job.dart';
import '../../models/host_id.dart';
import '../shared/mutation_notice.dart';
import 'clone_form.dart';
import 'clone_watch.dart';

/// Sends the ask, then watches it happen — the same split `spawn_flow.dart` uses, and
/// for the same reason: "ask the machine, then watch it land" is one whole sequence with
/// a beginning, a wait and an end, while the screen that collected the ask has already
/// gone.
///
/// The poll lives here rather than in `data/` because it is a property of *this screen
/// being open*: nothing else in the app wants a clone's progress, and a repository that
/// polled on its own would keep doing it after the operator walked away.
Future<void> startCloneAndWatch(
  BuildContext context, {
  required ProjectRepository projects,
  required HostId host,
  required String machine,
  required CloneAsk ask,
  required Future<void> Function() onArrived,
  Duration poll = const Duration(seconds: 1),
}) async {
  var again = true;
  while (again) {
    again = false;

    final started = await projects.startClone(
      host,
      url: ask.url,
      branch: ask.branch,
      name: ask.name,
    );
    if (!context.mounted) return;

    final job = started.job;
    if (job == null) {
      // Refused, unreachable, or a name the host would not take. Every one of those is
      // a sentence `noticeFor` already owns, so this screen invents none of them.
      final notice = noticeFor(started.outcome, agent: ask.name ?? ask.url);
      if (notice != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(notice)));
      }
      return;
    }

    again = await _watch(
      context,
      projects: projects,
      host: host,
      machine: machine,
      first: job,
      onArrived: onArrived,
      poll: poll,
    );
    if (!context.mounted) return;
  }
}

/// Shows the clone until it is over, and answers whether the operator asked for another.
Future<bool> _watch(
  BuildContext context, {
  required ProjectRepository projects,
  required HostId host,
  required String machine,
  required CloneJob first,
  required Future<void> Function() onArrived,
  required Duration poll,
}) async {
  final navigator = Navigator.of(context);
  var landed = false;
  var retry = false;

  await navigator.push(MaterialPageRoute<void>(
    builder: (context) => _Polling(
      projects: projects,
      host: host,
      machine: machine,
      first: first,
      poll: poll,
      onSettled: (job) {
        landed = job.isDone;
        if (job.isDone && navigator.canPop()) navigator.pop();
      },
      onRetry: () {
        retry = true;
        if (navigator.canPop()) navigator.pop();
      },
    ),
  ));

  // Only when it actually landed: leaving early, or retrying, is not an arrival, and a
  // refresh is one `GET /m/bootstrap` to every paired machine.
  if (landed) await onArrived();
  return retry;
}

/// The screen while it runs, and the timer that belongs to it.
///
/// A [StatefulWidget] rather than a timer held by the flow above, because the timer has
/// to die when the screen does — measured on 2026-09-11, when leaving early left a
/// `Timer.periodic` running against a screen that no longer existed. `dispose` is the
/// only place that cannot be forgotten.
class _Polling extends StatefulWidget {
  const _Polling({
    required this.projects,
    required this.host,
    required this.machine,
    required this.first,
    required this.poll,
    required this.onSettled,
    required this.onRetry,
  });

  final ProjectRepository projects;
  final HostId host;
  final String machine;
  final CloneJob first;
  final Duration poll;

  /// Called once, with the job as it finally read — done or failed.
  final void Function(CloneJob job) onSettled;
  final VoidCallback onRetry;

  @override
  State<_Polling> createState() => _PollingState();
}

class _PollingState extends State<_Polling> {
  late CloneJob _job = widget.first;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(widget.poll, (_) => unawaited(_read()));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _read() async {
    final next = await widget.projects.cloneStatus(widget.host, widget.first.taskId);
    // A tick that brought nothing is not news — the screen keeps the last step it knew
    // rather than claiming the clone stopped.
    if (next == null || !mounted) return;
    setState(() => _job = next);
    if (next.isRunning) return;
    _timer?.cancel();
    widget.onSettled(next);
  }

  @override
  Widget build(BuildContext context) => CloneWatch(
        job: _job,
        machine: widget.machine,
        onDismiss: () => Navigator.of(context).pop(),
        onRetry: _job.isFailed ? widget.onRetry : null,
      );
}
