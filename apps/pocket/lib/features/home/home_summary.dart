import '../../models/cell.dart';

/// The one sentence under the project title: *"**Atlas is waiting.** Chess and Koda
/// are working."*
///
/// Two parts, because the mockup gives them different colours — [waiting] is amber
/// and weighted, [rest] is muted. Kept as data rather than a formatted string so the
/// widget can style each half without parsing a sentence back apart.
class HomeSummary {
  const HomeSummary({required this.waiting, required this.rest});

  /// The amber half. Empty when nothing is waiting — then the line is only [rest].
  final String waiting;

  /// The muted half. Empty when every cell here is waiting.
  final String rest;

  bool get isEmpty => waiting.isEmpty && rest.isEmpty;

  /// Builds the sentence for the cells of **one** project.
  ///
  /// [cells] is expected in `FleetStore` order (waiting first), which is also the
  /// order names are read out in — so the first name in the sentence is the first row
  /// in the list, and the sentence never points somewhere the eye has to hunt for.
  factory HomeSummary.of(List<Cell> cells) {
    if (cells.isEmpty) return const HomeSummary(waiting: '', rest: '');

    final waiting = cells.where((c) => c.needsInput).toList(growable: false);
    final others = cells.where((c) => !c.needsInput).toList(growable: false);

    return HomeSummary(
      waiting: waiting.isEmpty
          ? ''
          : '${_names(waiting)} ${_verb(waiting)} waiting.',
      rest: others.isEmpty ? '' : _restClause(others),
    );
  }

  /// Names up to two agents, then falls back to a count.
  ///
  /// Three names in one line is already a list the eye has to parse rather than read,
  /// and the list itself is directly below — so past two, the count is the more useful
  /// sentence and the names stay where they are addressable.
  static String _names(List<Cell> cells) {
    final titles = cells.map((c) => c.title).toList(growable: false);
    return switch (titles.length) {
      1 => titles.first,
      2 => '${titles[0]} and ${titles[1]}',
      _ => '${titles.length} agents',
    };
  }

  static String _verb(List<Cell> cells) => cells.length == 1 ? 'is' : 'are';

  /// The non-waiting half.
  ///
  /// **Deviates from the mockup's literal copy, on purpose.** That example reads
  /// "Chess and Koda are working." while Koda is a `codex` cell the same screen
  /// labels `unknown` — and `MVP.md` §2 calls exactly that claim the most expensive
  /// lie in the product, because "working" reads as "fine" about an agent that may be
  /// mid-edit. So a cell whose turn is unknown is described as **quiet**, the word
  /// the mockup's own row copy already uses (`never asks · quiet 4m`).
  ///
  /// **Three buckets, not two, since 2026-08-09 — and the third was a real defect
  /// caught on a phone, not a refinement.** This split on [Cell.turnKnown] alone, so a
  /// cell reporting `idle` landed in the same bucket as one reporting `running` and
  /// both were called *working*. A screenshot of a live fleet showed the summary
  /// reading **"Atlas and Nova are working."** directly above two rows both labelled
  /// **`IDLE`** — the screen asserting two contradictory things about the same agents,
  /// forty pixels apart.
  ///
  /// It is the same lie this function already deviated from the mockup to avoid, only
  /// applied to a different state: "working" reads as *busy on my behalf*, and an idle
  /// agent is not. The tests covered `running` and no-turn and never `idle`, which is
  /// why it survived.
  ///
  /// Order is working → quiet → idle: `unknown` stays ahead of `idle` because
  /// `MVP.md` §2 ranks an uninterpretable silence as worse than a reported one.
  static String _restClause(List<Cell> others) {
    final working = others
        .where((c) => c.turnKnown && !c.isIdle)
        .toList(growable: false);
    final idle = others.where((c) => c.isIdle).toList(growable: false);
    final unknown = others.where((c) => !c.turnKnown).toList(growable: false);

    final clauses = <String>[
      if (working.isNotEmpty) '${_names(working)} ${_verb(working)} working.',
      if (unknown.isNotEmpty) '${_names(unknown)} ${_verb(unknown)} quiet.',
      if (idle.isNotEmpty) '${_names(idle)} ${_verb(idle)} idle.',
    ];
    return clauses.join(' ');
  }
}
