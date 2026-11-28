import '../../models/permission.dart';

/// The two ends of the Home slider, each one of the prompt's own options.
typedef SlipAnswers = ({PromptOption yes, PromptOption no});

/// Maps a prompt onto a two-ended slider, or null when that cannot be done safely.
///
/// Safe means: a permission (not a question), exactly one option that is a plain "Yes",
/// and exactly one that starts with "No". Anything else, such as two plain yeses or a
/// "Yes, and don't ask again" with no plain one, is answered in Chat, never guessed here.
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

bool _plainYes(String label) => RegExp(r'^yes[.!]?$').hasMatch(_norm(label));

bool _startsNo(String label) => RegExp(r'^no\b').hasMatch(_norm(label));
