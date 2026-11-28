import '../../models/permission.dart';

/// The two ends of the Home slider, each one of the prompt's own options.
typedef SlipAnswers = ({PromptOption yes, PromptOption no});

/// Maps a prompt onto a two-ended slider, or null when that cannot be done safely.
///
/// Safe means: a permission (not a question), exactly one plain "Yes" (or the host bridge's
/// "Allow once") and exactly one "No…" (or "Deny"). A standing grant such as "Allow all Bash
/// until this cell closes" never maps; it is answered in Chat, never guessed here.
SlipAnswers? slipAnswersFor(PermissionSnapshot? snapshot) {
  if (snapshot == null || !snapshot.answerable) return null;
  final prompt = snapshot.prompt!;
  if (prompt.isQuestion) return null;
  final yes = prompt.options.where((o) => _plainYes(o.label)).toList();
  final no = prompt.options.where((o) => _startsNo(o.label)).toList();
  if (yes.length != 1 || no.length != 1) return null;
  return (yes: yes.single, no: no.single);
}

String _norm(String label) => label.trim().toLowerCase();

// "Allow once" and "Deny" are the host bridge's own fixed labels (`claude/pending.ts`).
bool _plainYes(String label) => RegExp(r'^(yes|allow once)[.!]?$').hasMatch(_norm(label));

bool _startsNo(String label) => RegExp(r'^(no|deny)\b').hasMatch(_norm(label));
