import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/theme.dart';
import '../../../models/app_build.dart';

/// Which build of Pocket this phone is running — the line to compare against the one
/// `scripts/release.sh` printed, to know the update landed.
///
/// Last on the screen, under everything measured about the machines: it describes the
/// phone, not a host, and nobody comes to Diagnostics for it first. Long-press copies
/// it, because the place this line is needed is a bug report.
class AppBuildBlock extends StatelessWidget {
  const AppBuildBlock({required this.running, super.key});

  final AppBuild running;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final detail = describe(running);

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.only(top: 22),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPress: () => _copy(context, '${running.label} $detail'.trim()),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Lotus Pocket ${running.label}',
              style: t.ui.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500, color: t.muted),
            ),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(detail, style: t.mono.copyWith(fontSize: 11, color: t.muted)),
            ],
          ],
        ),
      ),
    );
  }

  /// `997b9c90 · built 2026-10-03 23:28 · sideload` — the commit first, because it is
  /// what tells two builds of the same version apart. Local time, since the operator
  /// compares it against a clock on the wall, not against UTC.
  static String describe(AppBuild build) {
    final at = build.builtAt?.toLocal();
    return [
      ?build.commit,
      if (at != null) 'built ${_date(at)}',
      build.channel,
    ].join(' · ');
  }

  static String _date(DateTime at) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${at.year}-${two(at.month)}-${two(at.day)} ${two(at.hour)}:${two(at.minute)}';
  }

  Future<void> _copy(BuildContext context, String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(const SnackBar(content: Text('Build copied')));
  }
}
