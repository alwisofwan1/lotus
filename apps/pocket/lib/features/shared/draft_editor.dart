import 'package:flutter/material.dart';

import '../../app/theme/app_tokens.dart';
import 'glyphs.dart';
import 'tactile.dart';

/// Above how many lines a draft has outgrown the composer and is offered the whole
/// screen.
///
/// Three, not [kComposerMaxLines]: the offer should arrive while the field still fits,
/// not at the moment it stops fitting. A control that appears exactly when the text
/// starts scrolling is a control the operator meets *after* the problem.
const int kDraftOutgrowsAt = 3;

/// How many lines a draft occupies, counted the way the operator typed them.
///
/// Newlines only — a single long wrapped paragraph is not counted here, and that is a
/// known gap rather than an oversight: the field wraps it and the operator can still see
/// the tail. What this catches is the shape the return key made possible, which is the
/// one that used to be impossible to type at all.
int draftLines(String text) => text.isEmpty ? 1 : '\n'.allMatches(text).length + 1;

/// Whether a draft is long enough that the whole screen is worth offering.
bool draftOutgrewField(String text) => draftLines(text) > kDraftOutgrowsAt;

/// The draft with the whole screen to itself.
///
/// **It writes into the composer's own controller**, so nothing is copied in and nothing
/// is copied back: the same characters and the same caret are simply being shown on a
/// larger surface. Leaving is free — there is no save, because there was never a second
/// copy to reconcile.
///
/// The transcript is gone while this is up, which is the trade being made: a long reply
/// is written *about* something already read, and re-reading it costs a tap. A field that
/// grew to fill the page instead would have pushed that same transcript off screen
/// anyway, and taken the send button with it.
class DraftEditor extends StatelessWidget {
  const DraftEditor({
    required this.controller,
    required this.agent,
    required this.onSend,
    super.key,
  });

  final TextEditingController controller;

  /// Who the draft is for. Printed, because the screen it replaced was the only thing
  /// naming the agent — an editor with no transcript behind it has to say it itself.
  final String agent;

  /// Dispatches, exactly as the composer's own button would. It clears the shared
  /// controller, so this page has nothing left to hold once it returns.
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Head(agent: agent, onSend: onSend),
            Container(height: 1, color: t.line),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: TextField(
                  controller: controller,
                  autofocus: true,
                  expands: true,
                  maxLines: null,
                  minLines: null,
                  keyboardType: TextInputType.multiline,
                  textInputAction: TextInputAction.newline,
                  textAlignVertical: TextAlignVertical.top,
                  style: t.ui.copyWith(fontSize: 15, height: 1.6, color: t.text),
                  cursorColor: t.text,
                  decoration: const InputDecoration(
                    isDense: true,
                    border: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The editor's own header. It carries the only two controls this screen has: the way
/// back down, and the dispatch.
class _Head extends StatelessWidget {
  const _Head({required this.agent, required this.onSend});

  final String agent;
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 4, 14, 10),
      child: Row(
        children: [
          CollapseDraftButton(onPressed: () => Navigator.of(context).maybePop()),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Draf', style: t.serif.copyWith(fontSize: 17, color: t.text)),
                const SizedBox(height: 2),
                Text('untuk $agent',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.ui.copyWith(fontSize: 11.5, color: t.muted)),
              ],
            ),
          ),
          const SizedBox(width: 12),
          _SendPill(onSend: onSend),
        ],
      ),
    );
  }
}

/// The one filled shape on this screen, for the same reason it is the one filled shape
/// on the composer: it is the only control here that leaves the phone.
class _SendPill extends StatelessWidget {
  const _SendPill({required this.onSend});

  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: 'Send',
      child: Material(
        color: t.text,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () async {
            final navigator = Navigator.of(context);
            await onSend();
            // Closed after the dispatch rather than before it, so a composer that hands
            // the words back has somewhere to hand them: this page still holds the field.
            await navigator.maybePop();
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 36),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Center(
                widthFactor: 1,
                child: Text('Kirim',
                    style: t.ui.copyWith(
                        fontSize: 13.5, fontWeight: FontWeight.w500, color: t.bg)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Opens the editor over the current screen, on the composer's own field.
Future<void> openDraftEditor(
  BuildContext context, {
  required TextEditingController controller,
  required String agent,
  required Future<void> Function() onSend,
}) =>
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) =>
          DraftEditor(controller: controller, agent: agent, onSend: onSend),
    ));

/// The way out of a small field: hands the draft the whole screen.
///
/// A bare glyph, not a filled shape. Only two things in this app are filled — the send
/// button and a permission's answers — and changing which surface you are writing on is
/// not a commitment to anything.
class ExpandDraftButton extends StatelessWidget {
  const ExpandDraftButton({required this.onPressed, super.key});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: 'Expand draft',
      child: InkResponse(
        onTap: () {
          Tactile.chose();
          onPressed();
        },
        radius: 20,
        child: SizedBox(
          width: kMinHitTarget,
          height: kMinHitTarget,
          child: Center(
            child: ExpandGlyph(color: t.dim),
          ),
        ),
      ),
    );
  }
}

/// The way back down, and the twin of [ExpandDraftButton] — same target, same weight,
/// the glyph mirrored. Named rather than inlined into the editor's header because a
/// control the operator has to find in order to leave should be a thing, not a `Text`.
class CollapseDraftButton extends StatelessWidget {
  const CollapseDraftButton({required this.onPressed, super.key});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: 'Collapse draft',
      child: InkResponse(
        onTap: onPressed,
        radius: 20,
        child: SizedBox(
          width: kMinHitTarget,
          height: kMinHitTarget,
          child: Center(
            child: ExpandGlyph(color: t.dim, direction: ExpandDirection.into),
          ),
        ),
      ),
    );
  }
}
