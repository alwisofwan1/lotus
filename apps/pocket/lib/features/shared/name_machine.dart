import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';

/// What the sheet was closed with. `null` is a dismissal — the operator swiped it away
/// or pressed back — and changes nothing.
sealed class MachineName {
  const MachineName();
}

/// Use this word for the machine from now on.
class MachineNamed extends MachineName {
  const MachineNamed(this.name);

  final String name;
}

/// Leave it as the machine calls itself.
///
/// A distinct outcome rather than an empty [MachineNamed], because clearing a name
/// that was set and never setting one must both be possible and must both mean the
/// same thing: fall back to the hostname.
class MachineUnnamed extends MachineName {
  const MachineUnnamed();
}

/// Asks what this phone should call a machine.
///
/// **Shown right after pairing, not before it.** The name has to be about a specific
/// machine, and until `/m/pair` answers there is no machine — only an address and
/// eight digits. Pre-filled with a guess so the common case is one tap.
///
/// **Skipping is a first-class answer**, and on a phone paired with one machine it is
/// the *right* one: the name is not drawn anywhere until a second machine exists to
/// confuse it with (`hostQualifier`). That is why this sheet says what the name is
/// for rather than demanding it — an operator who skips loses nothing today, and can
/// name the machine from Diagnostics the day it starts to matter.
Future<MachineName?> showNameMachine(
  BuildContext context, {
  required String hostLabel,
  required String suggestion,
  bool isFirstMachine = false,
}) {
  final sheet = context.components.sheet;

  return showModalBottomSheet<MachineName>(
    context: context,
    // Fill and shape come from the theme, so they follow it while open.
    barrierColor: sheet.barrier,
    // The keyboard covers a sheet that does not ask to be measured against it, and a
    // field the operator cannot see is a field they cannot correct.
    isScrollControlled: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: NameMachine(
        hostLabel: hostLabel,
        suggestion: suggestion,
        isFirstMachine: isFirstMachine,
      ),
    ),
  );
}

/// The sheet's contents. Separate from [showNameMachine] so a widget test can pump it
/// directly, without a route.
class NameMachine extends StatefulWidget {
  const NameMachine({
    required this.hostLabel,
    required this.suggestion,
    this.isFirstMachine = false,
    super.key,
  });

  /// What the machine calls itself. Printed under the field, because the operator is
  /// naming *this* machine and the hostname is how they tell which one it was.
  final String hostLabel;

  final String suggestion;

  /// Changes only the sentence, never the controls: with one machine paired the name
  /// is not drawn anywhere yet, and saying so is more honest than implying the phone
  /// needs an answer it will not use.
  final bool isFirstMachine;

  @override
  State<NameMachine> createState() => _NameMachineState();
}

class _NameMachineState extends State<NameMachine> {
  late final TextEditingController _name =
      TextEditingController(text: widget.suggestion);

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _save() {
    final typed = _name.text.trim();
    Navigator.of(context)
        .pop(typed.isEmpty ? const MachineUnnamed() : MachineNamed(typed));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 34,
                height: 4,
                margin: const EdgeInsets.only(bottom: 18),
                decoration: BoxDecoration(
                  color: t.lineStrong,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            Text(
              'What do you call this machine?',
              style: t.ui.copyWith(
                fontSize: 17,
                fontWeight: FontWeight.w500,
                letterSpacing: -0.3,
                color: t.text,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              widget.isFirstMachine
                  // True, and worth saying: the sheet is asking for something it will
                  // not show yet. Pretending otherwise would make the skip look lossy.
                  ? 'Only used once a second machine is paired, to tell two projects '
                      'with the same name apart. You can set it later in Diagnostics.'
                  : 'Shown beside project names, to tell this machine apart from the '
                      'others you have paired.',
              style: t.ui.copyWith(fontSize: 13, height: 1.5, color: t.muted),
            ),
            const SizedBox(height: 20),
            TextField(
              controller: _name,
              autofocus: true,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _save(),
              style: t.ui.copyWith(fontSize: 15, color: t.text),
              cursorColor: t.dim,
              decoration: InputDecoration(
                isDense: true,
                filled: true,
                fillColor: t.raise,
                hintText: widget.suggestion,
                hintStyle: t.ui.copyWith(fontSize: 15, color: t.muted),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                border: OutlineInputBorder(
                  borderRadius: context.shape.radius(ShapeRole.field),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              // Which machine this is, in its own words. Two MacBooks on one tailnet
              // are told apart here and nowhere else on this sheet.
              widget.hostLabel,
              style: t.mono.copyWith(fontSize: 12, color: t.muted),
            ),
            const SizedBox(height: 22),
            _SaveButton(onTap: _save),
            const SizedBox(height: 4),
            Center(
              child: TextButton(
                onPressed: () =>
                    Navigator.of(context).pop(const MachineUnnamed()),
                child: Text(
                  'Use its own name',
                  style: t.ui.copyWith(fontSize: 13, color: t.muted),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Inverted, the way the pairing button is: ink on the text colour, never a new
/// accent — amber has one meaning in this app and this is not it.
class _SaveButton extends StatelessWidget {
  const _SaveButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      child: Material(
        color: t.text,
        borderRadius: context.shape.radius(ShapeRole.button),
        child: InkWell(
          onTap: onTap,
          borderRadius: context.shape.radius(ShapeRole.button),
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 15),
            child: Text(
              'Save',
              style: t.ui.copyWith(
                fontSize: 14.5,
                fontWeight: FontWeight.w600,
                color: t.bg,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
