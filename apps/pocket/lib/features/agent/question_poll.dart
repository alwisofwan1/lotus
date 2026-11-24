import 'dart:async';

import '../../data/live_conversation.dart';
import '../../models/conversation.dart';
import '../../models/host_id.dart';

/// Reads a cell again while it is holding a question nobody has answered yet.
///
/// **The one moment nothing pushes.** A cell with a terminal reports its steps through hooks,
/// and neither way a question can end fires one: answering at the keyboard writes only to the
/// runner's own file, and Esc writes an interruption and nothing else. So the card stayed on
/// screen until the operator pulled to refresh — reported from a device 2026-09-09.
///
/// `bb` never has this gap: its server pushes `interactions-changed` and the client refetches
/// the interaction (`domain/change-kinds.ts`). Until Lotus has such a push, reading again while
/// a question is open is the honest stand-in — narrow on purpose, because it is polling: it
/// runs only while a card is actually on screen, and it gives up after [_limit].
class QuestionPoll {
  QuestionPoll({
    required LiveConversation live,
    required this.ref,
    required this.reload,
    this.hostAwaiting,
    this.every = const Duration(seconds: 3),
  }) : _live = live {
    _live.addListener(_check);
    _check();
  }

  final LiveConversation _live;
  final CellRef ref;

  /// Re-reads the cell. Awaited, so a slow read cannot stack up behind itself.
  final Future<void> Function() reload;

  /// Whether the **host** still says this cell is holding a question.
  ///
  /// The local turns are not enough to decide when to stop, and that cost a real bug
  /// (2026-09-10). Answering settles the card here first — that is the whole point of
  /// `LiveConversation.settleQuestion` — which notified this poll, which saw no open question
  /// and stopped **one read before** the host had written its own record. `/permission` then
  /// stayed `awaiting: true` in the page's view with nothing left to refresh it, and
  /// `chat_body`'s footer drew a *permission* card in the answered question's place. It took
  /// leaving the page and coming back.
  ///
  /// So the two sides have to agree before this gives up. Null means "no second opinion" —
  /// the old behaviour, for a caller that has no snapshot to offer.
  final bool Function()? hostAwaiting;

  final Duration every;

  /// A question nobody answers is not a reason to keep asking the host all day. Two minutes
  /// is long enough to cover a person walking back to their desk; past that, pull to refresh.
  static const int _limit = 40;

  Timer? _timer;
  int _reads = 0;
  bool _reading = false;

  void dispose() {
    _live.removeListener(_check);
    _stop();
  }

  /// Whether anyone still thinks a question is open — this app, or the host.
  bool get _asking {
    final open = _live.turnsFor(ref).any(
          (t) => t.parts.any((p) => p is QuestionPart && p.isOpen),
        );
    return open || (hostAwaiting?.call() ?? false);
  }

  void _check() {
    if (!_asking) return _stop();
    if (_timer != null || _reads >= _limit) return;
    _timer = Timer.periodic(every, (_) => _tick());
  }

  Future<void> _tick() async {
    if (_reading) return;
    // Checked on the tick and not only on a notification: nothing on the wire announces a
    // question ending, which is this class's reason for existing — so the host agreeing is
    // something only the next read can discover.
    if (!_asking) return _stop();
    if (_reads >= _limit) return _stop();
    _reads++;
    _reading = true;
    try {
      await reload();
    } finally {
      _reading = false;
    }
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
    // The count is not reset: it bounds this page's whole visit, so a question that keeps
    // being asked and refused cannot restart the clock each time.
  }
}
