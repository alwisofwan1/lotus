import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../data/project_repository.dart';
import '../../models/browse.dart';
import '../../models/host_id.dart';
import '../home/widgets/start_button.dart';
import '../shared/back_glyph.dart';
import '../shared/mutation_notice.dart';
import 'browse_rows.dart';

/// Screens 05 and 06 of `plans/pocket-vps-project-checkout/design/add-project.html`.
///
/// **One touch target per row: tapping means going in.** Two targets (enter / take) on a
/// thumb-wide screen is the cheapest way to add the wrong repository, so the rule is one —
/// *you take the folder you are standing in* — and the button prints its path so nothing has
/// to be remembered (ADR-E).
///
/// The screen asks the host what may be taken rather than working it out: only the machine
/// knows which root is scanned, and a client that guessed would draw a live button over a
/// request the host refuses.
Future<void> showBrowseFolder(
  BuildContext context, {
  required ProjectRepository projects,
  required HostId host,
  required String machine,
  required Future<void> Function() onArrived,
}) =>
    Navigator.of(context).push<void>(MaterialPageRoute<void>(
      builder: (_) => _Browse(
        projects: projects,
        host: host,
        machine: machine,
        onArrived: onArrived,
      ),
    ));

class _Browse extends StatefulWidget {
  const _Browse({
    required this.projects,
    required this.host,
    required this.machine,
    required this.onArrived,
  });

  final ProjectRepository projects;
  final HostId host;
  final String machine;
  final Future<void> Function() onArrived;

  @override
  State<_Browse> createState() => _BrowseState();
}

class _BrowseState extends State<_Browse> {
  BrowsePage? _page;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load(null);
  }

  /// Reads one level. [path] null asks for the roots.
  ///
  /// **A host with exactly one root skips the choosing step**, because a list of one is not a
  /// choice — the same reading that makes the two-door sheet disappear when only one door
  /// exists (`add_project.dart`).
  Future<void> _load(String? path) async {
    setState(() => _loading = true);
    final page = await widget.projects.browse(widget.host, path);
    if (!mounted) return;
    if (path == null && page != null && page.roots.length == 1) {
      await _load(page.roots.single.path);
      return;
    }
    setState(() {
      _page = page;
      _loading = false;
    });
  }

  Future<void> _take(String path) async {
    final outcome = await widget.projects.takeFolder(widget.host, path);
    if (!mounted) return;
    if (!outcome.succeeded) {
      final notice = noticeFor(outcome, agent: path);
      if (notice != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(notice)));
      }
      return;
    }
    Navigator.of(context).pop();
    await widget.onArrived();
  }

  /// Back goes **up**, and at a root it leaves. There is nothing above a root to go to, so
  /// the same control never climbs past one.
  void _back() {
    final page = _page;
    final parent = page?.parent;
    if (parent != null) {
      unawaited(_load(parent));
      return;
    }
    if (page != null && page.roots.length > 1 && page.path != null) {
      unawaited(_load(null)); // back to choosing a root
      return;
    }
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final page = _page;

    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _bar(t, page),
            Expanded(
              child: _loading || page == null
                  ? const SizedBox.shrink()
                  : BrowseList(page: page, onEnter: (entry) => unawaited(_load(entry.path))),
            ),
            if (page != null) _note(t, page),
            _commit(t, page),
          ],
        ),
      ),
    );
  }

  Widget _bar(AppTokens t, BrowsePage? page) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    page?.path == null ? 'Pick a folder' : nameOf(page!.path!),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.serif.copyWith(
                      fontSize: 21,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.4,
                      color: t.text,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    page?.path ?? 'ON ${widget.machine.toUpperCase()}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.mono.copyWith(fontSize: 10.5, color: t.faint),
                  ),
                ],
              ),
            ),
            BackGlyph(onTap: _back, label: 'Back'),
          ],
        ),
      );

  /// The rule, said once, where the thumb is.
  Widget _note(AppTokens t, BrowsePage page) => Container(
        decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
        child: Text(
          page.path == null
              ? 'THIS HOST OPENS ${page.roots.length} ROOTS.\nNOTHING ABOVE THEM CAN BE READ FROM THE PHONE.'
              : 'TAP A FOLDER TO GO IN.\nTHE BUTTON TAKES THE FOLDER YOU ARE IN.',
          style: t.mono.copyWith(fontSize: 9.5, height: 1.7, color: t.faint),
        ),
      );

  Widget _commit(AppTokens t, BrowsePage? page) {
    final path = page?.path;
    final can = page != null && page.takeable && path != null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
      child: Column(
        children: [
          StartButton(
            onStart: can ? () => unawaited(_take(path)) : null,
            label: path == null ? 'Use this folder' : 'Use $path',
            semanticsLabel: can
                ? 'Add $path as a project on ${widget.machine}'
                : 'This folder cannot be added',
          ),
          const SizedBox(height: 10),
          Text(
            _why(page),
            textAlign: TextAlign.center,
            style: t.mono.copyWith(fontSize: 10, letterSpacing: 0.12 * 10, color: t.faint),
          ),
        ],
      ),
    );
  }

  /// Why the button is dead, in the host's own two reasons — never one flat "disabled".
  String _why(BrowsePage? page) => switch (page?.whyNot) {
        'workspace-root' => 'THIS IS THE WORKSPACE ROOT · PICK ONE INSIDE',
        'already-a-project' => 'ALREADY A PROJECT',
        _ => page?.path == null
            ? 'PICK A ROOT TO LOOK INSIDE'
            : 'ADDS IT AS A PROJECT · NOTHING IS COPIED',
      };
}

/// The last segment of a path — what the operator calls the folder they are standing in.
String nameOf(String path) {
  final trimmed = path.replaceAll(RegExp(r'/+$'), '');
  final at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.substring(at + 1);
}
