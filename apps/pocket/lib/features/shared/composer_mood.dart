/// What the composer says when it is empty, which depends on what it is talking into.
///
/// Split out of `composer.dart` when that file crossed this repo's 300-line rule, and the
/// cut is where it is because these two answer *what the field says* while everything
/// left behind answers how the strip is built and what pressing send does.
enum ComposerMood {
  /// The agent is working. `Reply to Atlas`.
  working,

  /// The agent is asking permission. The ellipsis matters — see [placeholderFor].
  asking,
}

/// The placeholder for a mood, naming the agent.
///
/// `asking` carries the most weight, and the leading ellipsis is the reason: **two
/// buttons look like the only two answers**, when the right one is often a third — not
/// yes, not no, but *"don't do that, do this"*. The ellipsis continues their sentence,
/// so it reads as another option rather than as a separate field.
String placeholderFor(ComposerMood mood, String agent) => switch (mood) {
      ComposerMood.working => 'Reply to $agent',
      ComposerMood.asking => '…or tell $agent what to do instead',
    };

