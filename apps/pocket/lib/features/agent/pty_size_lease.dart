import 'dart:async';

/// Asks the host to hold the pane at `cols × rows`, renewing with [token] once it has one.
typedef HoldSize = Future<SizeAnswer?> Function(int cols, int rows, int? token);

/// The host's answer, as a record so features need no core type.
typedef SizeAnswer = ({bool held, int? token});

/// Hands the pane's size back to the desktop.
typedef ReleaseSize = Future<void> Function(int token);

/// The phone's side of the size lease (v4 tiket 11, ADR-6 addendum 2026-10-05).
///
/// **One PTY, one size, last touch wins.** Opening Terminal is the phone's touch: the pane
/// redraws at the phone's width. Typing at the desk is the desktop's, and the host answers
/// the next renewal `held: false`. That is final for this visit — renewing anyway would
/// take the pane back from a person sitting at it, every ten seconds. Opening Terminal
/// again is a new touch, and it wins.
///
/// The host lets a lease lapse after 30 s, so a renewal every [renewEvery] survives two
/// lost requests on a cellular link. A phone that drops off without a word is what the
/// lapse is for; leaving Terminal releases at once.
class PtySizeLease {
  PtySizeLease({required this.hold, required this.release});

  final HoldSize hold;
  final ReleaseSize release;

  static const renewEvery = Duration(seconds: 10);

  /// A keyboard opening or a turn of the phone resizes the area over several frames;
  /// the TUI should redraw once, at the size it ends on.
  static const settle = Duration(milliseconds: 250);

  bool _wanted = false;

  /// The host said someone at the desk took the pane back. Cleared by the next visit.
  bool _lost = false;

  (int, int)? _grid;
  int? _token;
  Timer? _settleTimer;
  Timer? _renewTimer;
  bool _sending = false;
  bool _again = false;
  bool _disposed = false;

  /// Whether the phone wants the size: the page is in front **and** on Terminal.
  void want(bool on) {
    if (on == _wanted || _disposed) return;
    _wanted = on;
    if (on) {
      _lost = false;
      _schedule();
    } else {
      _settleTimer?.cancel();
      _renewTimer?.cancel();
      _giveBack();
    }
  }

  /// The terminal's area, in cells at the font size it draws with.
  void grid(int cols, int rows) {
    if (cols < 1 || rows < 1 || _grid == (cols, rows) || _disposed) return;
    _grid = (cols, rows);
    if (_wanted && !_lost) _schedule();
  }

  void dispose() {
    want(false);
    _disposed = true;
  }

  void _schedule() {
    _settleTimer?.cancel();
    _settleTimer = Timer(settle, _send);
  }

  Future<void> _send() async {
    // One request at a time: two holds racing without a token would each start a lease,
    // and the one this phone kept might not be the one the host kept.
    if (_sending) {
      _again = true;
      return;
    }
    _renewTimer?.cancel();
    final grid = _grid;
    if (!_wanted || _lost || grid == null) return;

    _sending = true;
    final answer = await hold(grid.$1, grid.$2, _token);
    _sending = false;
    if (_disposed) return;

    if (answer != null) {
      if (!answer.held) {
        _token = null;
        _lost = true;
        return;
      }
      _token = answer.token;
    }
    // Left Terminal while the hold was in flight: the hold landed after the release
    // would have, so give it back now.
    if (!_wanted) return _giveBack();
    if (_again) {
      _again = false;
      return _send();
    }
    // A failed request keeps its token: the lease outlives two missed renewals.
    _renewTimer = Timer(renewEvery, _send);
  }

  void _giveBack() {
    final token = _token;
    _token = null;
    _again = false;
    if (token != null) unawaited(release(token));
  }
}
