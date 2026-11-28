import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../../models/permission.dart';
import '../../shared/age_label.dart';
import '../../shared/runner_mark.dart';
import '../slip_answers.dart';
import 'slide_to_answer.dart';

/// Reads what one waiting agent is asking right now; null when it cannot be read.
typedef LoadAsk = Future<PermissionSnapshot?> Function(Cell cell);

/// Sends one of the prompt's own options; returns whether it landed.
typedef AnswerAsk = Future<bool> Function(BuildContext context, Cell cell, PromptOption option);

/// The agents that wait on the operator, at the top of the first screen, one slip each.
///
/// Only built when something waits, so `Nobody needs you` in the strap stays a fact. The
/// slip is `DESIGN.md` §8 (chosen 2026-11-28): amber head, the ask, a tear, then a stub
/// that answers from here when [slipAnswersFor] can map the prompt safely, else opens Chat.
class NeedsYou extends StatelessWidget {
  const NeedsYou({
    required this.waiting,
    required this.onOpen,
    required this.where,
    this.loadAsk,
    this.onAnswer,
    super.key,
  });

  /// In `FleetStore` order, so the most urgent sits nearest the thumb. Never empty.
  final List<Cell> waiting;
  final void Function(Cell cell) onOpen;

  /// The project, with the machine only where it tells two apart.
  final String Function(Cell cell) where;

  /// Both null (tests, an older wiring) means every slip opens Chat instead of answering.
  final LoadAsk? loadAsk;
  final AnswerAsk? onAnswer;

  /// The share of the screen the slips may take; past it they scroll, so three waiting
  /// agents never push the project index (or the dock) off a small phone.
  static const double maxShare = 0.5;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * maxShare),
    child: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(12, 18, 12, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, cell) in waiting.indexed) ...[
            if (i > 0) const SizedBox(height: 10),
            _Slip(
              key: ValueKey(cell.paneId),
              cell: cell,
              where: where(cell),
              onOpen: () => onOpen(cell),
              loadAsk: loadAsk,
              onAnswer: onAnswer,
            ),
          ],
        ],
      ),
    ),
  );
}

class _Slip extends StatefulWidget {
  const _Slip({
    required this.cell,
    required this.where,
    required this.onOpen,
    required this.loadAsk,
    required this.onAnswer,
    super.key,
  });

  final Cell cell;
  final String where;
  final VoidCallback onOpen;
  final LoadAsk? loadAsk;
  final AnswerAsk? onAnswer;

  @override
  State<_Slip> createState() => _SlipState();
}

class _SlipState extends State<_Slip> {
  PermissionSnapshot? _ask;
  int _reads = 0;

  @override
  void initState() {
    super.initState();
    _read();
  }

  @override
  void didUpdateWidget(_Slip old) {
    super.didUpdateWidget(old);
    // A new line on screen can be a new prompt; the old answers must not survive it.
    if (old.cell.lastOutputPreview != widget.cell.lastOutputPreview) _read();
  }

  void _read() {
    final load = widget.loadAsk;
    if (load == null) return;
    final ticket = ++_reads;
    unawaited(
      load(widget.cell).then((s) {
        if (mounted && ticket == _reads) setState(() => _ask = s);
      }, onError: (Object _) {}),
    );
  }

  Future<bool> _send(PromptOption option) async {
    final answer = widget.onAnswer;
    if (answer == null) return false;
    final landed = await answer(context, widget.cell, option);
    if (landed && mounted) _read();
    return landed;
  }

  bool get _question => _ask?.prompt?.isQuestion ?? false;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final answers = widget.onAnswer == null ? null : slipAnswersFor(_ask);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: t.raise,
        borderRadius: context.shape.radius(ShapeRole.card),
        border: Border.all(color: t.waitingRule.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: widget.onOpen,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [_head(context, t), _askLine(t)]),
          ),
          const _Tear(),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: answers == null ? _pills(t) : _slider(answers),
          ),
        ],
      ),
    );
  }

  Widget _head(BuildContext context, AppTokens t) {
    final cell = widget.cell;
    final age = ageLabel(cell.turnAgeMs);
    final meta = age == null ? widget.where : '${widget.where} · $age';
    final word = _ask == null ? 'Needs you' : (_question ? 'Needs an answer' : 'Wants your OK');
    return Container(
      color: t.waitingTint,
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Row(
        children: [
          SizedBox.square(
            dimension: 24,
            child: Center(
              child: RunnerMarkGlyph(
                agentType: cell.agentType,
                color: brandColorFor(cell.agentType, Theme.of(context).brightness) ?? t.dim,
                size: 20,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  cell.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.ui.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: t.text),
                ),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.ui.copyWith(fontSize: 13, height: 18 / 13, color: t.muted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: t.waitingRule, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text(
            word,
            style: t.ui.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: t.waiting),
          ),
        ],
      ),
    );
  }

  Widget _askLine(AppTokens t) {
    final text = widget.cell.lastOutputPreview ?? _ask?.prompt?.question ?? '';
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Text(
        text,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: t.ui.copyWith(fontSize: 15, height: 22 / 15, fontWeight: FontWeight.w600, color: t.text),
      ),
    );
  }

  Widget _slider(SlipAnswers a) => SlideToAnswer(
    yesLabel: _short(a.yes.label),
    noLabel: _short(a.no.label),
    yesHint: a.yes.label,
    noHint: a.no.label,
    onYes: () => _send(a.yes),
    onNo: () => _send(a.no),
  );

  Widget _pills(AppTokens t) => Row(
    children: [
      Expanded(child: _pill(t, 'View', widget.onOpen)),
      const SizedBox(width: 10),
      Expanded(child: _pill(t, _question ? 'Answer' : 'Answer in Chat', widget.onOpen)),
    ],
  );

  Widget _pill(AppTokens t, String label, VoidCallback onTap) => SizedBox(
    height: 44,
    child: OutlinedButton(
      onPressed: onTap,
      style: OutlinedButton.styleFrom(
        foregroundColor: t.text,
        side: BorderSide(color: t.lineStrong),
        shape: const StadiumBorder(),
      ),
      child: Text(
        label,
        style: t.ui.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: t.text),
      ),
    ),
  );
}

/// The prompt's own first words, before any comma: "No, and tell Claude…" draws as "No".
String _short(String label) {
  final head = label.split(RegExp(r'[,(]')).first.trim();
  return head.isEmpty ? label.trim() : head;
}

/// A 1 px dashed line with a notch cut at each edge, like a ticket's tear-off.
class _Tear extends StatelessWidget {
  const _Tear();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return SizedBox(
      height: 12,
      child: CustomPaint(
        painter: _TearPainter(dash: t.lineStrong, notch: t.bg),
      ),
    );
  }
}

class _TearPainter extends CustomPainter {
  const _TearPainter({required this.dash, required this.notch});

  final Color dash;
  final Color notch;

  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    final line = Paint()
      ..color = dash
      ..strokeWidth = 1;
    for (var x = 12.0; x < size.width - 12; x += 8) {
      canvas.drawLine(Offset(x, y), Offset(x + 4, y), line);
    }
    final fill = Paint()..color = notch;
    canvas
      ..drawCircle(Offset(0, y), 6, fill)
      ..drawCircle(Offset(size.width, y), 6, fill);
  }

  @override
  bool shouldRepaint(_TearPainter old) => old.dash != dash || old.notch != notch;
}
