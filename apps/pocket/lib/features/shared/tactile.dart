import 'package:flutter/services.dart';

/// What the phone does in the hand, named by what happened rather than by how hard it
/// buzzes.
///
/// **Pocket had no haptics at all until 2026-08-09**, which is a strange gap for the
/// one surface in this product that is held. `map.md` describes the operator as away
/// from the laptop — walking, in a pocket, glancing — and every other decision on these
/// screens follows from that: the amber ration, the one-line rows, the summary
/// sentence. All of them assume the screen is being *looked* at. A dispatch fired while
/// walking gets no confirmation the eye is guaranteed to catch.
///
/// The vocabulary is three verbs, not three intensities, and that is the point of this
/// file existing rather than `HapticFeedback` being called directly at six call sites:
/// the question at a call site is *what did the operator just do*, and the answer must
/// be the same everywhere for the same kind of act. Picking `mediumImpact` by feel each
/// time is how a product ends up buzzing identically for choosing a name and for
/// approving a file deletion.
///
/// Deliberately not covered: arrival of a `waiting` cell while the app is foregrounded.
/// That is the phone interrupting rather than answering, it belongs with the push path
/// (ADR-4), and buzzing on a three-second fleet snapshot is how an operator learns to
/// ignore the buzz.
///
/// Every method is fire-and-forget. These call into the platform's own feedback
/// constants — no `VIBRATE` permission, and a device or a user that has haptics turned
/// off simply does nothing, which is why none of them is awaited or checked.
abstract final class Tactile {
  /// The operator moved a selection: a different target, a different project, a swipe
  /// to the next agent in the pager. Nothing has been committed and nothing has left
  /// the phone — the lightest thing the platform offers, and the same one the OS uses
  /// for a picker wheel.
  static void chose() => HapticFeedback.selectionClick();

  /// Words left for a machine. The confirmation the eye may not be on the screen to
  /// receive — this is the moment the composer clears, and until now that was the only
  /// signal a dispatch had started at all.
  static void sent() => HapticFeedback.mediumImpact();

  /// A permission was answered.
  ///
  /// **The heaviest, and it is the one place the weight is an argument rather than a
  /// preference.** This is the single irreversible act the app can perform from a
  /// pocket: the option under the thumb can delete a file on a machine the operator is
  /// not standing at, and `ADR-8` gives every answer equal visual weight precisely so
  /// that Allow is not the easy one. A distinctly heavier response than [chose] is what
  /// makes an accidental answer *felt* — the one channel still open when the screen is
  /// being read at arm's length, in daylight, while walking.
  static void answered() => HapticFeedback.heavyImpact();
}
