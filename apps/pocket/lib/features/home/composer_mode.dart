import 'package:flutter/foundation.dart';

/// Whether Home's composer is talking to an agent or starting one.
///
/// **Shared because two surfaces set it and one renders it.** The composer's chip
/// switches the mode, and so does the row at the foot of the list — that row is the
/// discoverable half, and a mode that only the chip could reach was the half an
/// operator actually looked for and did not find.
///
/// A [ValueNotifier] rather than lifted state: `HomeScreen` owns which project is on
/// screen and whether a gesture is in flight, and threading a third kind of state
/// through the body's constructor would invite all three to be reasoned about
/// together. This is one bit with one meaning, passed to the two widgets that need it.
class ComposerMode extends ValueNotifier<bool> {
  ComposerMode() : super(false);

  bool get isStartingAgent => value;

  void startAgent() => value = true;

  /// How many times the operator asked to *choose* an agent, not merely to switch the
  /// composer. Both ways into this mode — the list's last row and the picker's — now
  /// open the runner sheet at once: the mode used to flip silently and leave the
  /// operator looking for what changed. A counter rather than a flag, so two summons
  /// in a row are two openings even when the mode was already on.
  int summons = 0;

  void summon() {
    summons++;
    if (value) {
      notifyListeners();
    } else {
      value = true;
    }
  }

  /// Back to talking. Called when the agent was made, when a cell is chosen instead,
  /// and when the project on screen turns out not to be able to start one at all.
  void talkToAgent() => value = false;
}
