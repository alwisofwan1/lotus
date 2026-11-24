import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/features/agent/question_poll.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_id.dart';

final ref = CellRef(const HostId('mac'), 'p-1');

QuestionPart question({bool open = true}) => QuestionPart(
      id: 'q1',
      ts: DateTime.fromMillisecondsSinceEpoch(1),
      seq: 1,
      provenance: Provenance.derived,
      questions: const [
        UserQuestion(question: 'Tabs?', options: [UserQuestionOption(label: 'Tabs')]),
      ],
      cancelled: !open,
    );

LiveConversation holding(List<Part> parts) {
  final live = LiveConversation(const Stream.empty())..follow([ref]);
  live.seed(ref, [
    Turn(turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: parts),
  ]);
  return live;
}

/// **The one moment nothing pushes.** A cell with a terminal reports its steps through hooks,
/// and neither of the two ways a question can end fires one: answering at the keyboard writes
/// only to the runner's own file, and Esc writes an interruption and nothing else. So the card
/// stayed up until the operator pulled to refresh. `bb` never has this gap — its server pushes
/// `interactions-changed` and the client refetches (`change-kinds.ts`) — and until Lotus has
/// such a push, reading again *while a question is open* is the honest stand-in.
void main() {
  test('reads again while a question is open', () {
    fakeAsync((async) {
      var reads = 0;
      final live = holding([question()]);
      final poll = QuestionPoll(live: live, ref: ref, reload: () async => reads++);
      addTearDown(poll.dispose);

      async.elapse(const Duration(seconds: 7));

      expect(reads, 2, reason: 'every three seconds, and not before the first');
    });
  });

  test('stops the moment the question is over', () {
    fakeAsync((async) {
      var reads = 0;
      final live = holding([question()]);
      final poll = QuestionPoll(live: live, ref: ref, reload: () async => reads++);
      addTearDown(poll.dispose);

      async.elapse(const Duration(seconds: 4));
      live.settleQuestion(ref, 'Tabs');
      final settled = reads;
      async.elapse(const Duration(seconds: 30));

      expect(reads, settled);
    });
  });

  test('never starts for a cell with nothing to answer', () {
    fakeAsync((async) {
      var reads = 0;
      final live = holding([question(open: false)]);
      final poll = QuestionPoll(live: live, ref: ref, reload: () async => reads++);
      addTearDown(poll.dispose);

      async.elapse(const Duration(minutes: 2));

      expect(reads, 0);
    });
  });

  test('gives up rather than reading forever', () {
    fakeAsync((async) {
      var reads = 0;
      final live = holding([question()]);
      final poll = QuestionPoll(live: live, ref: ref, reload: () async => reads++);
      addTearDown(poll.dispose);

      async.elapse(const Duration(minutes: 10));

      expect(reads, lessThanOrEqualTo(40), reason: 'a question nobody answers is not a reason to poll all day');
    });
  });

  test('lets go of the store when the page does', () {
    fakeAsync((async) {
      var reads = 0;
      final live = holding([question()]);
      QuestionPoll(live: live, ref: ref, reload: () async => reads++).dispose();

      async.elapse(const Duration(seconds: 30));

      expect(reads, 0);
    });
  });

  /// The one read the old gate could never take.
  ///
  /// Answering settles the card locally (`LiveConversation.settleQuestion`), which notified
  /// this poll, which saw no open question and stopped — one read before the host had written
  /// its own record. `/permission` then stayed `awaiting: true` in the page's view forever,
  /// and `chat_body`'s footer drew a **permission** card in the question's place. Reported
  /// from a device on 2026-09-10: it took leaving the page and coming back.
  test('keeps reading after a local answer, until the host stops saying awaiting', () {
    fakeAsync((async) {
      var reads = 0;
      var hostAwaiting = true;
      final live = holding([question()]);
      final poll = QuestionPoll(
        live: live,
        ref: ref,
        reload: () async => reads++,
        hostAwaiting: () => hostAwaiting,
      );
      addTearDown(poll.dispose);

      // The operator answers: the card comes down here, the host has not caught up.
      live.settleQuestion(ref, 'Tabs');
      async.elapse(const Duration(seconds: 7));

      expect(reads, greaterThan(0),
          reason: 'the host is still holding the question; someone has to ask again');

      // The host finally writes it. The next tick is what notices — no listener has to
      // fire, because nothing on the wire announces a question ending (that is this whole
      // class's reason for existing).
      hostAwaiting = false;
      async.elapse(const Duration(seconds: 4));
      final settled = reads;
      async.elapse(const Duration(seconds: 12));

      expect(reads, settled, reason: 'both sides agree, so the polling is over');
    });
  });
}
