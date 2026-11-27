import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:xterm/xterm.dart';

/// One match: where it starts, and how wide it is.
@immutable
class SearchHit {
  const SearchHit({required this.line, required this.start, required this.end});

  /// Absolute row in the buffer, which is what a scroll offset is derived from.
  final int line;

  final int start;
  final int end;
}

/// Finding a word in what the pane has printed.
///
/// **The matching is ours, and that is not a shortcut.** `xterm.dart` 4.0.0 has no
/// search — it has `TerminalTheme.searchHit*` colours and a `TerminalHighlight`
/// mechanism, and nothing that puts one on the other. An earlier draft of the plan said
/// "the library's search just needs wiring up"; reading the package proved that wrong,
/// and the honest version costs a scan of the buffer.
///
/// Kept out of the widget because it owns three things a `State` should not have to hold
/// beside its build: the query, the hits, and the highlights' lifetimes. A highlight is
/// removed by disposing it, so losing track of one leaves a stripe on the screen that
/// nothing can clear.
class TerminalSearch extends ChangeNotifier {
  TerminalSearch({
    required this.terminal,
    required this.controller,
    required this.otherHit,
    required this.currentHit,
  });

  final Terminal terminal;
  final TerminalController controller;

  /// Two weights of the app's own ink: a hit is neither "needs you" nor "failed".
  final Color otherHit;
  final Color currentHit;

  /// A ceiling on the work, not on the operator. A 4000-line buffer of a screen-painting
  /// CLI can hold thousands of matches for `e`, and drawing them all costs more than it
  /// tells anyone. The count still reports what was found up to here.
  static const int maxHits = 500;

  String _query = '';
  String get query => _query;

  List<SearchHit> _hits = const [];
  List<SearchHit> get hits => _hits;

  int _at = 0;

  /// Which match is current, 1-based for the bar to print. Zero when there are none.
  int get position => _hits.isEmpty ? 0 : _at + 1;

  /// The absolute buffer row the viewport should be showing, or null when there is
  /// nothing to show. Read by the surfaces, which each know how to get there.
  int? get focusLine => _hits.isEmpty ? null : _hits[_at].line;

  final List<TerminalHighlight> _painted = [];

  /// Re-runs the current query. Called when the query changes and when new bytes land,
  /// because a match that scrolled past is no longer where it was.
  void search(String query) {
    _query = query;
    final was = _hits.isEmpty ? null : _hits[_at].line;
    _hits = _find(query);
    // Stay on the match nearest where the operator already was, rather than snapping
    // back to the first one every time the pane prints a line.
    _at = 0;
    if (was != null) {
      for (var i = 0; i < _hits.length; i++) {
        if (_hits[i].line >= was) {
          _at = i;
          break;
        }
      }
    }
    _paint();
    notifyListeners();
  }

  void next() => _step(1);

  void previous() => _step(-1);

  /// Wraps, because a phone screen holds a dozen lines and walking off the end of a
  /// four-thousand-line buffer to a dead button helps nobody.
  void _step(int by) {
    if (_hits.isEmpty) return;
    _at = (_at + by) % _hits.length;
    if (_at < 0) _at += _hits.length;
    _paint();
    notifyListeners();
  }

  void clear() {
    _query = '';
    _hits = const [];
    _at = 0;
    _paint();
    notifyListeners();
  }

  List<SearchHit> _find(String query) {
    final needle = query.trim().toLowerCase();
    if (needle.isEmpty) return const [];

    final found = <SearchHit>[];
    final lines = terminal.buffer.lines;
    for (var y = 0; y < lines.length; y++) {
      final used = lines[y].getTrimmedLength();
      if (used == 0) continue;
      final text = lines[y].getText(0, used).toLowerCase();
      var from = 0;
      while (true) {
        final at = text.indexOf(needle, from);
        if (at < 0) break;
        found.add(SearchHit(line: y, start: at, end: at + needle.length));
        if (found.length >= maxHits) return found;
        from = at + needle.length;
      }
    }
    return found;
  }

  /// Repaints every highlight from scratch.
  ///
  /// Wholesale rather than diffed on purpose: anchors are attached to buffer lines, and
  /// a line that scrolled out of a full buffer takes its anchor with it. Reconciling
  /// that is more code than re-creating a few hundred cheap objects.
  void _paint() {
    for (final highlight in _painted) {
      highlight.dispose();
    }
    _painted.clear();

    final buffer = terminal.buffer;
    for (var i = 0; i < _hits.length; i++) {
      final hit = _hits[i];
      if (hit.line >= buffer.lines.length) continue;
      _painted.add(controller.highlight(
        p1: buffer.createAnchor(hit.start, hit.line),
        p2: buffer.createAnchor(hit.end, hit.line),
        color: i == _at ? currentHit : otherHit,
      ));
    }
  }

  @override
  void dispose() {
    for (final highlight in _painted) {
      highlight.dispose();
    }
    _painted.clear();
    super.dispose();
  }
}
