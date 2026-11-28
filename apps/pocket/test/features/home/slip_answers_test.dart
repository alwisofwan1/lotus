import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/slip_answers.dart';
import 'package:lotus_pocket/models/permission.dart';

PermissionSnapshot snap(
  List<(String, String)> options, {
  String? ask,
  bool awaiting = true,
  bool hostSupports = true,
}) => PermissionSnapshot(
  paneId: 'p1',
  awaiting: awaiting,
  hostSupports: hostSupports,
  prompt: PermissionPrompt(
    question: 'Do you want to proceed?',
    ask: ask,
    options: [for (final (key, label) in options) PromptOption(key: key, label: label, selected: false)],
  ),
);

void main() {
  test('the usual three-option prompt maps plain Yes and No, by their printed digits', () {
    final a = slipAnswersFor(
      snap([
        ('1', 'Yes'),
        ('2', "Yes, and don't ask again for bun test commands"),
        ('3', 'No, and tell Claude what to do differently (esc)'),
      ]),
    )!;
    expect(a.yes.key, '1');
    expect(a.no.key, '3');
    expect(a.no.label, startsWith('No, and tell'));
  });

  test('the host bridge\'s own labels map too; the standing grant stays in Chat', () {
    final a = slipAnswersFor(
      snap([('1', 'Allow once'), ('2', 'Allow all Bash until this cell closes'), ('3', 'Deny')]),
    )!;
    expect((a.yes.key, a.no.key), ('1', '3'));
    expect(slipAnswersFor(snap([('1', 'Allow all Bash until this cell closes'), ('2', 'Deny')])), isNull);
  });

  test('a prompt that starts at 2 keeps its own digits', () {
    final a = slipAnswersFor(snap([('2', 'Yes'), ('3', 'No')]))!;
    expect((a.yes.key, a.no.key), ('2', '3'));
  });

  test('no plain Yes means no slider', () {
    expect(slipAnswersFor(snap([('1', 'Yes, allow all edits during this session'), ('2', 'No')])), isNull);
  });

  test('two plain yeses or two noes are ambiguous', () {
    expect(slipAnswersFor(snap([('1', 'Yes'), ('2', 'yes.'), ('3', 'No')])), isNull);
    expect(slipAnswersFor(snap([('1', 'Yes'), ('2', 'No'), ('3', 'No, cancel')])), isNull);
  });

  test('a word that only starts with "no" is not a No', () {
    expect(slipAnswersFor(snap([('1', 'Yes'), ('2', 'Nothing else')])), isNull);
  });

  test('a question is never a slider', () {
    expect(slipAnswersFor(snap([('1', 'Yes'), ('2', 'No')], ask: 'question')), isNull);
  });

  test('not answerable means no slider', () {
    expect(slipAnswersFor(snap([('1', 'Yes'), ('2', 'No')], awaiting: false)), isNull);
    expect(slipAnswersFor(snap([('1', 'Yes'), ('2', 'No')], hostSupports: false)), isNull);
    expect(slipAnswersFor(null), isNull);
  });
}
