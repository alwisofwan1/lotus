/// A place this host opens for browsing. There are never others (ADR-A).
class BrowseRoot {
  const BrowseRoot({required this.name, required this.path});

  final String name;
  final String path;

  factory BrowseRoot.fromJson(Map<String, Object?> json) => BrowseRoot(
        name: json['name']! as String,
        path: json['path']! as String,
      );
}

/// One directory inside a root. Never a file — the host sends none.
class BrowseEntry {
  const BrowseEntry({
    required this.name,
    required this.path,
    required this.isRepo,
    required this.branch,
    required this.children,
    required this.isProject,
  });

  final String name;
  final String path;
  final bool isRepo;

  /// The branch, or null where the host could not read it without shelling out — a
  /// worktree, a detached head, a clone still in flight. **Not knowable here**, never
  /// "no branch".
  final String? branch;

  /// Non-hidden directories inside it, which is what makes "worth entering" answerable
  /// for a folder that is not a repository.
  final int children;

  /// Whether this host already holds it. Answered by the host, not guessed here: the phone
  /// cannot see which root is scanned.
  final bool isProject;

  factory BrowseEntry.fromJson(Map<String, Object?> json) => BrowseEntry(
        name: json['name']! as String,
        path: json['path']! as String,
        isRepo: json['isRepo'] == true,
        branch: json['branch'] as String?,
        children: (json['children'] as num?)?.toInt() ?? 0,
        isProject: json['isProject'] == true,
      );
}

/// What one level of a directory looks like, plus every root the host opens.
class BrowsePage {
  const BrowsePage({
    required this.roots,
    required this.path,
    required this.parent,
    required this.entries,
    this.takeable = false,
    this.whyNot,
  });

  /// Always sent, so the top level can be drawn without a second call — and so "my folder
  /// is not here" reads as configuration rather than as a broken app.
  final List<BrowseRoot> roots;

  /// Null when nothing was asked for: the client is at the top level, choosing a root.
  final String? path;

  /// **Null at a root.** There is nothing above it to offer a way up to, and a disabled
  /// control would teach the operator that there is.
  final String? parent;

  final List<BrowseEntry> entries;

  /// Whether the directory on screen may be taken, and why not when it may not.
  ///
  /// The host decides. A client that guessed would draw a live button over a request the
  /// machine refuses — and the two reasons are different sentences, not one disabled state.
  final bool takeable;

  /// `workspace-root` or `already-a-project`, or null when [takeable].
  final String? whyNot;

  bool get isAtRoot => parent == null;

  factory BrowsePage.fromJson(Map<String, Object?> json) {
    final page = json['page'] as Map<String, Object?>?;
    return BrowsePage(
      roots: [
        for (final root in (json['roots']! as List<Object?>))
          BrowseRoot.fromJson(root! as Map<String, Object?>),
      ],
      path: page?['path'] as String?,
      parent: page?['parent'] as String?,
      entries: [
        for (final entry in (page?['entries'] as List<Object?>? ?? const []))
          BrowseEntry.fromJson(entry! as Map<String, Object?>),
      ],
      // False at the top level, where there is no directory on screen to take.
      takeable: page?['takeable'] == true,
      whyNot: page?['whyNot'] as String?,
    );
  }
}
