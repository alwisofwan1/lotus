import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../models/browse.dart';

/// The list inside one directory, or the roots this host opens.
///
/// **A folder this host already holds is drawn, not hidden** — dimmed, and saying so. A list
/// that hides what is on disk sends the operator looking for something they saw over SSH five
/// minutes ago. It is simply not enterable: there is nothing to do inside it here.
class BrowseList extends StatelessWidget {
  const BrowseList({required this.page, required this.onEnter, super.key});

  final BrowsePage page;
  final void Function(BrowseEntry entry) onEnter;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    if (page.path == null) {
      return ListView(
        children: [
          for (final root in page.roots)
            _row(
              t,
              name: root.name,
              blurb: root.path,
              onTap: () => onEnter(BrowseEntry(
                name: root.name,
                path: root.path,
                isRepo: false,
                branch: null,
                children: 0,
                isProject: false,
              )),
            ),
        ],
      );
    }
    return ListView(
      children: [
        for (final entry in page.entries)
          _row(
            t,
            name: entry.name,
            blurb: _blurb(entry),
            dim: entry.isProject,
            onTap: entry.isProject ? null : () => onEnter(entry),
          ),
      ],
    );
  }

  /// `GIT · MAIN`, `GIT · MAIN · ALREADY A PROJECT`, or `4 FOLDERS · NOT A REPO`.
  ///
  /// `branch` null on a repository is **not knowable here**, never *no branch* — a worktree,
  /// a detached head, or a clone still in flight, and the host says which by saying nothing.
  String _blurb(BrowseEntry entry) {
    final parts = <String>[
      if (entry.isRepo) 'GIT',
      if (entry.isRepo && entry.branch != null) entry.branch!.toUpperCase(),
      if (!entry.isRepo) '${entry.children} ${entry.children == 1 ? 'FOLDER' : 'FOLDERS'}',
      if (!entry.isRepo) 'NOT A REPO',
      if (entry.isProject) 'ALREADY A PROJECT',
    ];
    return parts.join(' · ');
  }

  Widget _row(
    AppTokens t, {
    required String name,
    required String blurb,
    required VoidCallback? onTap,
    bool dim = false,
  }) =>
      Opacity(
        opacity: dim ? 0.45 : 1,
        child: InkWell(
          onTap: onTap,
          splashColor: t.raise,
          highlightColor: t.raise,
          child: Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.serif.copyWith(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                          letterSpacing: -0.2,
                          color: t.text,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        blurb,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.mono.copyWith(fontSize: 10, color: t.faint),
                      ),
                    ],
                  ),
                ),
                if (onTap != null)
                  Text('›', style: TextStyle(color: t.faint, fontSize: 16)),
              ],
            ),
          ),
        ),
      );
}
