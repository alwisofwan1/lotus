import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../models/cell_result.dart';
import '../shared/back_glyph.dart';
import '../../data/agent_repository.dart';
import '../../models/cell.dart';

/// Pushes [DiffScreen] for one of [cell]'s files, reading through [repository].
Future<void> openDiff(
  BuildContext context, {
  required Cell cell,
  required AgentRepository repository,
  required String path,
}) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DiffScreen(
          agent: cell.title,
          path: path,
          load: () => repository.diff(cell.ref, path),
        ),
      ),
    );

/// One file's diff against HEAD, read-only — `design/pocket-agent-done`, artboard 3.
///
/// Drawn as a page of the Agent surface, not a sheet: a diff is read top to bottom and
/// can be long, and the header names the file the way `AgentHeader` names an agent.
/// Read-only on purpose. Editing on a phone is the fastest way to break what the agent
/// just built, and the composer one screen back is the way to ask for a change.
class DiffScreen extends StatefulWidget {
  const DiffScreen({required this.agent, required this.path, required this.load, super.key});

  final String agent;
  final String path;

  /// Null when the host could not answer; the page says so rather than guessing.
  final Future<CellDiff?> Function() load;

  @override
  State<DiffScreen> createState() => _DiffScreenState();
}

class _DiffScreenState extends State<DiffScreen> {
  late final Future<CellDiff?> _diff = widget.load();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(context, t),
            Expanded(
              child: FutureBuilder<CellDiff?>(
                future: _diff,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
                    return Center(child: Text('reading…', style: t.mono.copyWith(fontSize: 12, color: t.muted)));
                  }
                  final diff = snap.data;
                  if (diff == null) {
                    return Center(
                      child: Text('the machine could not produce this diff',
                          style: t.mono.copyWith(fontSize: 12, color: t.muted)),
                    );
                  }
                  return _body(t, diff);
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 14),
              child: Text(
                'read-only here — edit on the machine',
                textAlign: TextAlign.center,
                style: t.mono.copyWith(fontSize: 11, color: t.muted),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _header(BuildContext context, AppTokens t) => Padding(
        padding: const EdgeInsets.only(left: 18, right: 18, top: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                BackGlyph(onTap: () => Navigator.of(context).pop(), label: 'Back to ${widget.agent}'),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    widget.path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.mono.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: t.text),
                  ),
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.only(left: 44, top: 3),
              child: Text('${widget.agent} · vs HEAD', style: t.mono.copyWith(fontSize: 11, color: t.muted)),
            ),
            Container(height: 1, margin: const EdgeInsets.only(top: 14), color: t.line),
          ],
        ),
      );

  /// The `_CodeBlock` look from `agent_prose.dart`: a raised block, mono 11.5, scrolling
  /// both ways so a long line never wraps into a different diff.
  Widget _body(AppTokens t, CellDiff diff) {
    final lines = diff.diff.split('\n');
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
      children: [
        Container(
          decoration: BoxDecoration(
            color: Color.alphaBlend(t.raise, t.bg),
            borderRadius: context.shape.radius(ShapeRole.chip),
          ),
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [for (final line in lines) _line(t, line)],
            ),
          ),
        ),
        if (diff.truncated)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              'cut at 64 KiB by the host — the rest is on the machine',
              style: t.mono.copyWith(fontSize: 11.5, height: 1.5, color: t.muted),
            ),
          ),
      ],
    );
  }

  /// Additions bright on a raised band, removals faint, hunk headers muted. Two shades of
  /// the one ink, never red and green: `MVP.md` rations colour to amber and error.
  Widget _line(AppTokens t, String line) {
    final kind = line.isEmpty ? ' ' : line[0];
    final (Color ink, Color? band) = switch (kind) {
      '+' when !line.startsWith('+++') => (t.text, t.raise),
      '-' when !line.startsWith('---') => (t.faint, null),
      '@' => (t.muted, null),
      _ => (t.dim, null),
    };
    return Container(
      color: band,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Text(line, softWrap: false, style: t.mono.copyWith(fontSize: 11.5, height: 1.5, color: ink)),
    );
  }
}
