import 'dart:async';

import 'package:flutter/material.dart';

// Re-exported so the moods stay one import away from the widget that takes them: every
// caller already says `composer.dart`, and a split file should not become a second thing
// to remember.
export 'composer_keys.dart';
export 'composer_mood.dart';

import '../../data/dictation.dart';
import '../../models/host_id.dart';
import 'composer_box.dart';
import 'composer_field.dart';
import 'composer_footer.dart';
import 'composer_keys.dart';
import 'composer_mood.dart';
import 'dictation_row.dart';
import 'draft_editor.dart';
import 'held_paste.dart';
import 'mic_button.dart';
import 'send_button.dart';
import 'tactile.dart';

/// The one control on both faces of the Agent page.
///
/// **A capsule, one row** — `V4 Composer` in `mockups/lotus-pocket.pen` (v4 tiket 09).
/// A filled box with a 22px corner holds the field and the send slot beside it, both
/// riding the field's base (R04), so a five-line draft keeps the button where the thumb
/// already is. What describes the draft rather than dispatches it — the context the page
/// knows, the line count, ⤢ — sits on the line underneath ([ComposerFooter]).
///
/// It was outlined and two rows from 2026-09-17: the controls had crowded the field, and
/// a footer gave the words the full width. The capsule keeps that width by keeping only
/// one control in the row, the slot mic and send share.
///
/// [leading] sits in the capsule before the field — the mockup's `+`. Nothing hands one in
/// yet: there is no attachment a host can take, and a `+` that opens nothing is the dead
/// control ADR-14 forbids.
class Composer extends StatefulWidget {
  const Composer({
    required this.mood,
    required this.agent,
    required this.onSend,
    this.enabled = true,
    this.allowEmpty = false,
    this.placeholder,
    this.leading,
    this.above,
    this.about,
    this.controller,
    this.focusNode,
    this.onComposing,
    this.dictation,
    this.dictateOn,
    super.key,
  });

  final ComposerMood mood;
  final String agent;

  /// Sends the text, and answers whether it is now **accounted for somewhere the
  /// operator can see**. Gating happens above this widget — it decides nothing.
  ///
  /// True does not mean "it landed": on the agent page a refused dispatch still becomes
  /// a line in the transcript carrying its own retry, so the words are on screen and the
  /// field is right to be empty. False means nothing took responsibility for them.
  ///
  /// Home is why this is not a `void`: it has no transcript to move the words into, so
  /// clearing unconditionally deleted a paragraph every time a machine happened to be
  /// asleep — seen for real on 2026-08-09.
  final Future<bool> Function(String text) onSend;

  /// False while a send is in flight, so one tap cannot become two dispatches.
  final bool enabled;

  /// Whether pressing send with nothing typed means something. False where words are
  /// the payload (an empty dispatch is a 400, refused here to save the round trip); true
  /// when starting an agent, where *no brief* is a perfectly good instruction.
  final bool allowEmpty;

  /// Overrides what the empty field says. Given only where the mood's own sentence
  /// would be wrong: starting an agent, where `placeholderFor` would compose
  /// `Reply to …` around a phrase that is not a name.
  final String? placeholder;

  /// The microphone, or null on a build or a host that has none. Both this and
  /// [dictateOn] must be present for the mic to appear: one says *can we record*, the
  /// other *which machine turns it into words*. A Standalone Host does not advertise
  /// `stt`, and this app hides what a host cannot do rather than offering it to fail.
  final Dictation? dictation;

  /// Where the audio is transcribed. Never on the phone — that is where the key is not
  /// (ADR-11).
  final HostId? dictateOn;

  /// Sits inside the pill, before the field. Absent on Home, which has one surface.
  final Widget? leading;

  /// Sits inside the pill, **above** the field — the quote `Add to chat` is holding.
  ///
  /// Inside rather than over: a strip floating above the composer would be a second
  /// container on a page that earns exactly one, and it would move independently of the
  /// shape the eye is holding on to while the keyboard comes up.
  final Widget? above;

  /// Under the capsule, on the left: what the page knows about where the words go. Only
  /// what the host reports — see `ComposerContext`. Null on Home.
  final Widget? about;

  /// The field's controller, when the owner needs to write into it — a snippet chosen
  /// in the terminal has to land somewhere. Null keeps the old shape: one is made here.
  final TextEditingController? controller;

  /// The composer is this app's prompt, so something outside it can ask for the keyboard —
  /// which is what a question's `Type something.` and `Chat about this` end in.
  final FocusNode? focusNode;

  /// Field ini berpindah antara kosong dan berisi. Sudah dilacak untuk tombol kirimnya;
  /// yang baru hanya bahwa ia terlihat dari luar — alasannya di `HomeScreen._typingAt`.
  final ValueChanged<bool>? onComposing;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  /// Whoever made it disposes it: handing back a dead field to a caller that still
  /// holds the controller is the one way this can go wrong.
  late final TextEditingController _controller =
      widget.controller ?? TextEditingController();

  bool get _owned => widget.controller == null;

  /// Whether there is anything worth sending — watched rather than read at tap time, so
  /// the button can *look* the way it will *behave*.
  bool _hasText = false;

  /// Whether the draft has outgrown the field and is being offered the whole screen.
  bool _outgrew = false;

  /// Watches the field for a block too big to have been typed into it. Built in
  /// [initState] so its idea of *before* is fixed at whatever the field opened with.
  late final PasteCatch _paste = PasteCatch(_controller);

  /// What the return key does here, and how tall the field may get — see [ComposerKeys].
  static const ComposerKeys _keys = ComposerKeys.chat;

  /// Apakah tombol kirimnya berarti sesuatu kalau ditekan sekarang.
  bool get _live =>
      widget.enabled && (_hasText || _paste.held != null || widget.allowEmpty);

  @override
  void initState() {
    super.initState();
    // **Read once before listening.** A controller handed in already holding a restored
    // draft never fires a change, so a composer that learned only from changes began life
    // believing the field was empty — a dead send button over a paragraph already typed.
    _paste;
    _hasText = _controller.text.trim().isNotEmpty;
    _outgrew = draftOutgrewField(_controller.text);
    _controller.addListener(_watch);
  }

  void _watch() {
    // Its own `setState`: taking a block out usually leaves the field as empty as it
    // already was, so the rest of this method would see nothing change.
    if (!_paste.quiet && _paste.take()) setState(() {});
    final has = _controller.text.trim().isNotEmpty;
    final outgrew = draftOutgrewField(_controller.text);
    if (has == _hasText && outgrew == _outgrew) return;
    // Asked before the assignment: `onComposing` reports the empty/filled flip, and
    // firing it again because the draft merely grew a line would tell Home that
    // something changed which did not.
    final flipped = has != _hasText;
    setState(() {
      _hasText = has;
      _outgrew = outgrew;
    });
    if (flipped) widget.onComposing?.call(has);
  }

  @override
  void dispose() {
    _controller.removeListener(_watch);
    if (_owned) _controller.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    final block = _paste.held;
    final payload = withHeld(block, text);
    // An empty dispatch would be refused by the host with a 400; refusing it here keeps
    // that round trip off a cellular link.
    if ((payload.isEmpty && !widget.allowEmpty) || !widget.enabled) return;

    // Cleared *before* the await, buzz on the same frame: a field that empties on tap
    // reads as sent, one that empties on reply reads as laggy. See [Tactile.sent].
    setState(() => _paste.hold(null));
    _paste.write('');
    Tactile.sent();
    final taken = await widget.onSend(payload);
    if (taken || !mounted) return;

    // Nothing took them, so they come back — unless something was typed meanwhile, which
    // restoring over would be its own kind of loss. Each half returns to the shape it was
    // in: the block held, the sentence in the field.
    if (_controller.text.isEmpty) {
      setState(() => _paste.hold(block));
      _paste.write(text);
    }
  }

  @override
  Widget build(BuildContext context) {
    final dictation = widget.dictation;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
      child: dictation == null
          ? _capsule(null)
          : ListenableBuilder(
              listenable: dictation,
              // The whole capsule is rebuilt rather than only its row: what is *above* the
              // field depends on dictation too, and a quote left standing over a
              // waveform would describe a field nobody can see.
              builder: (context, _) => _capsule(dictation),
            ),
    );
  }

  Widget _capsule(Dictation? dictation) {
    final busy = dictation?.isBusy ?? false;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ComposerBox(
          top: [
            if (widget.above case final above? when !busy) above,
            if (_paste.held case final held? when !busy)
              HeldPaste(text: held, onDrop: () => setState(() => _paste.hold(null))),
          ],
          busy: busy
              ? DictationRow(
                  state: dictation!.state,
                  onCancel: () => unawaited(dictation.cancel()),
                  onStop: _finishDictating,
                )
              : null,
          leading: widget.leading,
          field: ComposerField(
            controller: _controller,
            keys: _keys,
            focusNode: widget.focusNode,
            enabled: widget.enabled,
            hint: widget.placeholder ?? placeholderFor(widget.mood, widget.agent),
          ),
          trailing: _trailing(),
        ),
        if (!busy)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: ComposerFooter(
              about: widget.about,
              // Said only when it says something. One line is the shape of the field, not
              // news about it; a held block is news, because its own size is invisible.
              lines: _hasText && (_lines > 1 || _paste.held != null) ? _lines : null,
              onExpand: _outgrew ? _expand : null,
            ),
          ),
      ],
    );
  }

  int get _lines => draftLines(_controller.text);

  /// **One slot, never two.** Empty field → the microphone; anything typed → send.
  /// The reasoning for the two treatments is on [MicButton].
  Widget _trailing() {
    if (_hasText || widget.dictation == null || widget.dictateOn == null) {
      return SendButton(live: _live, onSend: _send);
    }
    return MicButton(dictation: widget.dictation!, enabled: widget.enabled);
  }

  /// Hands the draft the whole screen, on the field it already had — see [DraftEditor].
  void _expand() => unawaited(openDraftEditor(context,
      controller: _controller, agent: widget.agent, onSend: _send));

  Future<void> _finishDictating() async {
    final dictation = widget.dictation;
    final host = widget.dictateOn;
    if (dictation == null || host == null) return;
    await appendDictated(dictation: dictation, on: host, into: _paste);
  }
}
