import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../home/widgets/start_button.dart';
import '../shared/back_glyph.dart';

/// What the operator filled in. Nothing is sent from this screen.
class CloneAsk {
  const CloneAsk({required this.url, this.branch, this.name});

  final String url;

  /// Null means the repository's default branch — one `git` argument, chosen here
  /// because that is cheap. A worktree per branch is not, and is deferred (ADR-F).
  final String? branch;

  /// The folder this becomes. Derived from the url unless the operator typed one.
  final String? name;
}

/// Screen 07 of `plans/pocket-vps-project-checkout/design/add-project.html`.
///
/// Returns the ask and closes; the sending belongs to `clone_flow.dart`, the same split
/// `showRunnerSheet` and `startAgentAndWatch` already use. A screen that both collected
/// and sent would be the only surface in this app where those two live together.
Future<CloneAsk?> showCloneForm(BuildContext context, {required String machine}) =>
    Navigator.of(context).push<CloneAsk>(
      MaterialPageRoute<CloneAsk>(builder: (_) => _CloneForm(machine: machine)),
    );

class _CloneForm extends StatefulWidget {
  const _CloneForm({required this.machine});

  /// The machine, **already qualified** — empty when naming it distinguishes nothing.
  final String machine;

  @override
  State<_CloneForm> createState() => _CloneFormState();
}

class _CloneFormState extends State<_CloneForm> {
  final _url = TextEditingController();
  final _branch = TextEditingController();
  final _name = TextEditingController();

  @override
  void initState() {
    super.initState();
    // The derived name follows the url until the operator types one of their own, at
    // which point it stops moving — a field that keeps rewriting what was just typed is
    // a field nobody can finish filling in.
    _url.addListener(() => setState(() {}));
    _name.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _url.dispose();
    _branch.dispose();
    _name.dispose();
    super.dispose();
  }

  String get _derived => folderNameFrom(_url.text);
  String get _folder => _name.text.isEmpty ? _derived : _name.text;
  bool get _canSend => _url.text.trim().isNotEmpty && _folder.isNotEmpty;

  void _send() {
    if (!_canSend) return;
    Navigator.of(context).pop(CloneAsk(
      url: _url.text.trim(),
      branch: _branch.text.trim().isEmpty ? null : _branch.text.trim(),
      name: _folder,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _bar(t),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                children: [
                  _label(t, 'REPOSITORY'),
                  _field(t, const Key('clone-url'), _url, 'https, ssh, or owner/repo'),
                  _hint(t, 'The machine resolves it — gh is what reaches a private repo.'),
                  _label(t, 'BRANCH'),
                  _field(t, const Key('clone-branch'), _branch, 'default branch'),
                  _label(t, 'FOLDER NAME'),
                  _field(t, const Key('clone-name'), _name, _derived),
                  if (_folder.isNotEmpty)
                    _hint(t, 'Becomes the project $_folder${_on()}.'),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
              child: Column(
                children: [
                  StartButton(
                    onStart: _send,
                    label: 'Clone',
                    semanticsLabel: _canSend
                        ? 'Clone ${_url.text} into $_folder'
                        : 'Clone — a repository is needed first',
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'YOU CAN LEAVE THIS SCREEN',
                    style: t.mono.copyWith(
                      fontSize: 10,
                      letterSpacing: 0.14 * 10,
                      color: t.faint,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _on() => widget.machine.isEmpty ? '' : ' on ${widget.machine}';

  Widget _bar(AppTokens t) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'Clone',
                style: t.serif.copyWith(
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.4,
                  color: t.text,
                ),
              ),
            ),
            // The app's one way back, not a `Cancel` word: `back_glyph.dart` exists
            // because three screens once drew that affordance three different ways.
            BackGlyph(onTap: () => Navigator.of(context).pop(), label: 'Cancel'),
          ],
        ),
      );

  Widget _label(AppTokens t, String text) => Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 8),
        child: Text(
          text,
          style: t.mono.copyWith(
            fontSize: 9.5,
            letterSpacing: 0.14 * 9.5,
            color: t.faint,
          ),
        ),
      );

  Widget _field(
    AppTokens t,
    Key key,
    TextEditingController controller,
    String hint,
  ) =>
      Container(
        height: 46,
        padding: const EdgeInsets.symmetric(horizontal: 13),
        decoration: BoxDecoration(
          color: t.raise,
          borderRadius: context.shape.radius(ShapeRole.field),
        ),
        alignment: Alignment.centerLeft,
        child: TextField(
          key: key,
          controller: controller,
          autocorrect: false,
          enableSuggestions: false,
          style: t.mono.copyWith(fontSize: 12.5, color: t.text),
          cursorColor: t.waiting,
          cursorWidth: 1.5,
          decoration: InputDecoration(
            isDense: true,
            border: InputBorder.none,
            hintText: hint,
            hintStyle: t.mono.copyWith(fontSize: 12.5, color: t.muted),
          ),
        ),
      );

  Widget _hint(AppTokens t, String text) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(text, style: t.mono.copyWith(fontSize: 10, color: t.faint)),
      );
}

/// The last path segment of a repository url, without its `.git` suffix.
///
/// The same rule the host applies (`server/projects/clone.ts`), repeated here for one
/// reason only: this screen has to *show* the name before anything is sent. The host
/// stays the one that decides — a name it refuses comes back as a refusal, not as a
/// field this screen greyed out on a guess.
String folderNameFrom(String url) {
  final trimmed = url.trim().replaceAll(RegExp(r'/+$'), '');
  if (trimmed.isEmpty) return '';
  final last = trimmed.split('/').last;
  return last.endsWith('.git') ? last.substring(0, last.length - 4) : last;
}
