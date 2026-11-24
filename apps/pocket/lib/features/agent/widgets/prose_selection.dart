import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/tactile.dart';
import '../chat_transcript.dart';
import 'agent_prose.dart';
import 'prose_links.dart';

/// The agent's words, selectable, with one extra item in the menu the phone already
/// draws.
///
/// **Selection here is not a new idea, it is the one this app kept refusing.** Chat
/// rendered every reply through a plain [Text], so the only way to take a sentence out
/// of it was a long press that copied the *whole* message. The terminal had the better
/// answer all along — `SelectionBar` — and it was never brought to the side of the
/// screen where the prose lives.
///
/// Two decisions, and the first one was wrong for a whole day:
///
/// * **Pocket draws the toolbar, rather than contributing one item to the phone's.**
///   The first version added `Add to chat` to `AdaptiveTextSelectionToolbar.buttonItems`,
///   reasoning that `Copy`, `Share` and `Select all` are the phone's own and already
///   known. Measured 2026-09-17 on the Infinix X6880 this app is tested on: the system
///   toolbar showed `Copy · Share · Select all · Ask Claude · Ask Bing · ⋮`, and the
///   overflow held seven more `PROCESS_TEXT` actions from other apps — `Ask ChatGPT`,
///   `Read aloud`, `Notes`, `Search in Truecaller`, `Translate`, `Ask Perplexity`,
///   `AI Writing`. Scrolled to the end: our item was in neither list. How many slots
///   exist is the OEM's decision, and on a phone with seven text-action apps installed
///   there are none left to give. `issues/08` records it.
///
///   So the toolbar is ours, on the anchors the platform still computes. `Copy` comes
///   with it — taking a fragment is the other half of why selection exists, and it may
///   not be the thing that gets dropped.
/// * **One [SelectionArea] per message, never one around the list.** A region spanning
///   the whole transcript lets a drag run from an agent's reply into the next turn's
///   bubble and hand back a paragraph nobody said; it also keeps a stale selection alive
///   while the list recycles rows underneath it.
class SelectableProse extends StatefulWidget {
  const SelectableProse({required this.item, this.onQuote, super.key});

  final ChatItem item;

  /// Quotes the selected run into the composer. Null removes the menu item — never an
  /// item that does nothing.
  final void Function(String text)? onQuote;

  @override
  State<SelectableProse> createState() => _SelectableProseState();
}

class _SelectableProseState extends State<SelectableProse> {
  /// What is under the handles right now, as the region last reported it. Held rather
  /// than read back at menu-build time because the menu is built from a state object
  /// whose selected content is not part of its public surface.
  ///
  /// **A notifier, not a field, and that is not a style choice.** The first version
  /// guarded the toolbar on this value being non-empty, and on the device the toolbar
  /// then never appeared at all: `contextMenuBuilder` can run before
  /// `onSelectionChanged` has reported the run, so the guard hid the pill at exactly the
  /// moment it was asked for. The pill is now built unconditionally and reads the text
  /// when a finger actually lands on it.
  final ValueNotifier<String> _selected = ValueNotifier<String>('');

  @override
  void dispose() {
    _selected.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SelectionArea(
      onSelectionChanged: (content) =>
          _selected.value = content?.plainText.trim() ?? '',
      contextMenuBuilder: (context, state) => SelectionPill(
        anchors: state.contextMenuAnchors,
        selected: _selected,
        onQuote: widget.onQuote,
        onDone: () {
          state.hideToolbar();
          state.clearSelection();
        },
      ),
      child: AgentProse(
        text: widget.item.text,
        // The sheet is opened from here rather than from inside the renderer so the
        // quote action it offers is the same one this message's row offers.
        onLink: (context, target) => showLinkActions(
          context,
          target: target,
          onQuote: widget.onQuote,
        ),
      ),
    );
  }
}

/// The two things worth doing with a run of text the operator just held.
///
/// Drawn by this app rather than requested from the platform — see [SelectableProse] for
/// the measurement that forced that. It sits on `contextMenuAnchors`, which is what the
/// system toolbar would have used, so it lands in the same place the operator expects and
/// flips above or below the selection the same way.
///
/// Two actions and no more. The mockup drew four (`COPY`, `TO CHAT`, `SHARE`, `✕`); a
/// dismiss button is what tapping elsewhere already does, and `SHARE` is a sheet this app
/// has never owned. What is left is the pair that the terminal's `SelectionBar` also
/// settled on, which is not a coincidence: it is the same question about a different
/// surface.
class SelectionPill extends StatelessWidget {
  const SelectionPill({
    required this.anchors,
    required this.selected,
    required this.onDone,
    this.onQuote,
    super.key,
  });

  /// Where the platform says a toolbar belongs: above the selection when there is room,
  /// below it otherwise.
  final TextSelectionToolbarAnchors anchors;

  /// What is under the handles, read when an action is pressed rather than when the pill
  /// is built — see [SelectableProse] for the frame-ordering this survives.
  final ValueListenable<String> selected;

  /// Clears the selection and takes the pill down, after either action.
  final VoidCallback onDone;

  final void Function(String text)? onQuote;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final quote = onQuote;

    return CustomSingleChildLayout(
      delegate: TextSelectionToolbarLayoutDelegate(
        anchorAbove: anchors.primaryAnchor,
        anchorBelow: anchors.secondaryAnchor ?? anchors.primaryAnchor,
      ),
      child: Material(
        color: Color.alphaBlend(t.raise, Color.alphaBlend(t.raise, t.bg)),
        borderRadius: BorderRadius.circular(12),
        clipBehavior: Clip.antiAlias,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _PillAction(
              label: 'COPY',
              onTap: () {
                final text = selected.value;
                if (text.isEmpty) return;
                // Down on the tap, not on the clipboard's answer — `Composer._send`
                // settled this for the whole app: a control that waits for a platform
                // channel before it reacts reads as laggy, and the copy is not in doubt.
                Tactile.sent();
                onDone();
                unawaited(Clipboard.setData(ClipboardData(text: text)));
              },
            ),
            if (quote != null)
              _PillAction(
                label: 'ADD TO CHAT',
                onTap: () {
                  final text = selected.value;
                  if (text.isEmpty) return;
                  Tactile.chose();
                  quote(text);
                  onDone();
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _PillAction extends StatelessWidget {
  const _PillAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: label,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: kMinHitTarget,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(
            label,
            style: t.mono.copyWith(
              fontSize: 11,
              letterSpacing: 0.12 * 11,
              color: t.text,
            ),
          ),
        ),
      ),
    );
  }
}

/// What can be done with the whole reply, said once under it.
///
/// **Labels, not icons**, and that is this repo's rule rather than a preference:
/// `glyphs.dart` states why there is no icon set on this screen, and the terminal's own
/// `SelectionBar` already spends mono caps on exactly these two verbs. bb draws the same
/// row as four glyphs because it has an icon set to draw them from; the words carry the
/// same meaning here and cost no new dependency.
///
/// Quiet on purpose: `faint` is the ornament tier, which is what an affordance sitting
/// under every single reply has to be — this screen's argument is that it stays silent
/// until something is asked of you.
class ProseActions extends StatelessWidget {
  const ProseActions({required this.text, this.onQuote, super.key});

  final String text;
  final void Function(String text)? onQuote;

  @override
  Widget build(BuildContext context) {
    final quote = onQuote;

    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        children: [
          _Action(
            label: 'COPY',
            onTap: () async {
              Tactile.sent();
              await Clipboard.setData(ClipboardData(text: text.trimRight()));
            },
          ),
          if (quote != null)
            _Action(
              label: 'ADD TO CHAT',
              onTap: () {
                Tactile.chose();
                quote(text);
              },
            ),
        ],
      ),
    );
  }

  /// Unused today, kept as the one place that knows what this row is worth in height —
  /// `TurnGap` sizes itself against the blocks around it and this is one of them.
  static const double height = kMinHitTarget;
}

class _Action extends StatelessWidget {
  const _Action({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: Container(
          height: kMinHitTarget,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          margin: const EdgeInsets.only(right: 2),
          child: Text(
            label,
            style: t.mono.copyWith(
              fontSize: 10.5,
              letterSpacing: 0.12 * 10.5,
              color: t.faint,
            ),
          ),
        ),
      ),
    );
  }
}
