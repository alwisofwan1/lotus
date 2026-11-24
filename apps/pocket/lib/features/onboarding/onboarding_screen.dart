import 'package:flutter/material.dart';

import '../../app/theme/app_tokens.dart';
import '../../data/pairing_outcome.dart';
import '../../data/pairing_repository.dart';
import '../../models/pairing.dart';
import '../../models/pairing_invite.dart';
import '../shared/back_glyph.dart';
import '../shared/host_label.dart';
import '../shared/name_machine.dart';
import 'pairing_diagnosis.dart';
import 'widgets/diagnosis_block.dart';
import 'widgets/pair_button.dart';
import 'widgets/pairing_code_cells.dart';
import 'widgets/pairing_field.dart';
import 'widgets/scan_prompt.dart';
import 'widgets/scan_screen.dart';

/// The first screen: pair this phone with a machine running Lotus (ADR-5).
///
/// **Scan, with typing as the fallback — and the order of those two took a while to
/// earn.** ADR-5 step 1 always said a QR; its 2026-08-06 addendum recorded that nothing
/// in the repo rendered one, so a scanner here would have been a consumer with no
/// producer — the same shape of bug as `cell.output` (commit `dab5261e`). The producer
/// exists now (`apps/desktop/…/settings/tabs/MobileTab.tsx`), and the payload both
/// sides agree on is pinned by `contract/fixtures/pairing-invite.json`, so this screen
/// finally gets to consume something real.
///
/// The typed fields did **not** go away, and they are not a legacy path:
///
/// * A Standalone Host on a VPS shows its QR in a terminal (`deploy/pair.sh`), and
///   the terminal may be on this very phone, where there is nothing to point it at.
/// * The camera permission can be refused, and a pairing screen that then offers
///   nothing is a phone that can never be paired.
/// * The desktop deliberately hides the QR while it is bound to loopback, because
///   that payload would send the phone to its own `127.0.0.1`.
///
/// So a scan **fills the same two fields and submits them**. There is one pairing path,
/// one set of failures, and one diagnosis — the scanner is an input method, not a
/// second flow.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({
    required this.pairing,
    required this.onPaired,
    this.scanner,
    this.onBack,
    this.initialAddress,
    super.key,
  });

  final PairingRepository pairing;

  /// Builds a live camera view, or null in a build that has no camera behind it.
  ///
  /// A bare function rather than a `QrScanner`, because `features/` may not import
  /// `core/` — see [ScanScreen], which explains the same seam from the other end.
  /// Null is a real state and not just a test affordance: the button is absent rather
  /// than present-and-broken.
  final Widget Function(void Function(String payload) onPayload)? scanner;

  /// Called once a credential is stored and its host is dialling. Routing belongs to
  /// `app/`, so this screen reports the fact and decides nothing about what follows.
  final VoidCallback onPaired;

  /// Non-null when this screen was **pushed** to add a machine alongside the ones
  /// already paired, rather than shown as the first screen of an unpaired phone.
  ///
  /// It changes two things. A pushed route needs a way out — changing your mind is
  /// not a failed pairing. And the title stops saying *Pair this phone*, which is the
  /// first-run sentence and false here: the phone is already paired with something.
  ///
  /// Null rather than a `bool` because the two facts are one — there is a route
  /// beneath this or there is not — and a flag plus a callback could disagree.
  final VoidCallback? onBack;

  /// Filled in when re-pairing a machine whose credential lapsed: only the code is new.
  final String? initialAddress;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  late final _address = TextEditingController(text: widget.initialAddress);
  final _code = TextEditingController();
  final _name = TextEditingController(text: 'Lotus Pocket');
  final _addressFocus = FocusNode();
  final _nameFocus = FocusNode();

  bool _busy = false;
  PairingDiagnosis? _diagnosis;

  /// The host refused the code on screen (401). Drives the cells' red and their one
  /// shake; a throttled or unreachable host leaves it false — that code may be good.
  bool _codeRefused = false;

  @override
  void dispose() {
    _address.dispose();
    _code.dispose();
    _name.dispose();
    _addressFocus.dispose();
    _nameFocus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      // Cleared on submit, not on keystroke: a diagnosis that vanishes as the
      // operator edits takes the instructions away exactly while they are acting on
      // them.
      _diagnosis = null;
      _codeRefused = false;
    });

    final outcome = await widget.pairing.pair(
      address: _address.text,
      code: _code.text,
      deviceName: _name.text,
    );
    if (!mounted) return;

    setState(() {
      _busy = false;
      _diagnosis = PairingDiagnosis.of(outcome);
      _codeRefused = outcome is PairingCodeRefused;
    });
    if (outcome is PairingSucceeded) {
      await _nameMachine(outcome.device);
      if (!mounted) return;
      widget.onPaired();
    }
  }

  /// Asks what to call the machine that just paired.
  ///
  /// **After the pairing, and before leaving this screen.** Before would be asking
  /// about a machine that does not exist yet — there is only an address and eight
  /// digits until `/m/pair` answers — and later would mean the operator names it from
  /// a diagnostics screen while looking at a list of hostnames, which is the moment
  /// they know least about which one is which.
  ///
  /// Dismissing or skipping stores nothing, which is a complete answer: the hostname
  /// stands, and with one machine paired it is not drawn anywhere anyway (`issues/11`).
  /// The pairing itself is already done and stored — nothing here can undo it, and
  /// nothing here is allowed to hold it up.
  Future<void> _nameMachine(PairedDevice device) async {
    // Counted before the sheet; the credential for this one is already stored.
    final isFirst = widget.pairing.pairedCount <= 1;

    final chosen = await showNameMachine(
      context,
      hostLabel: device.hostLabel,
      suggestion: suggestedNickname(device.hostLabel),
      isFirstMachine: isFirst,
    );
    if (!mounted) return;

    switch (chosen) {
      case MachineNamed(:final name):
        await widget.pairing.rename(device.hostId, name);
      case MachineUnnamed():
        await widget.pairing.rename(device.hostId, null);
      case null:
        break; // Swiped away. Not an answer, and not a reason to store one.
    }
  }

  /// A typed code is complete: hand the keyboard to the next field that needs it.
  ///
  /// **Never a submit.** "This phone" sits below the code and names the device in the
  /// desktop's revoke list; pairing on the eighth digit would register every phone as
  /// "Lotus Pocket" before the operator reached it. So focus moves on — to the address
  /// if it is still empty, otherwise to the name — and Pair stays a deliberate tap.
  void _codeFilled() {
    (_address.text.trim().isEmpty ? _addressFocus : _nameFocus).requestFocus();
  }

  /// Opens the camera, and pairs with whatever it reads.
  ///
  /// **The fields are filled before submitting, and stay filled afterwards.** A QR is
  /// opaque — the operator cannot check what they pointed at — so writing the scanned
  /// address and code into the two inputs is what turns "it failed" into "it failed
  /// with *this* address", which is the whole difference on a screen whose job is to
  /// name the cause. It also means a scan that lands on an unreachable host can be
  /// corrected by editing one character rather than by scanning again.
  Future<void> _scan() async {
    final scanner = widget.scanner;
    if (scanner == null || _busy) return;

    final payload = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => ScanScreen(scanner: scanner)),
    );
    // Null is the operator pressing back — not a failure, so no diagnosis for one.
    if (payload == null || !mounted) return;

    switch (readInvite(payload)) {
      case InviteUnreadable(:final title, :final detail):
        setState(() => _diagnosis = PairingDiagnosis(title: title, detail: detail));
      case InviteReadable(:final invite):
        _address.text = invite.address;
        _code.text = invite.code;
        await _submit();
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 28, 20, 28),
          children: [
            if (widget.onBack != null) ...[
              Padding(
                // Above the title, not beside it: the title wraps on a narrow phone, and
                // a glyph centred against two lines of 23px type reads as floating.
                padding: const EdgeInsets.only(bottom: 14),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: BackGlyph(onTap: widget.onBack!, label: 'Back to diagnostics'),
                ),
              ),
            ],
            Text(
              widget.initialAddress != null
                  ? 'Pair this machine again'
                  : (widget.onBack == null ? 'Pair this phone' : 'Pair another machine'),
              style: t.ui.copyWith(
                fontSize: 23,
                fontWeight: FontWeight.w500,
                letterSpacing: -0.55,
                color: t.text,
              ),
            ),
            const SizedBox(height: 9),
            Text(
              // The exact path on the other screen: the operator holds two devices, and
              // "check your settings" sends them hunting on the one they cannot see.
              'On the machine running Lotus: Settings → Mobile access → Pair a phone. '
              'On a VPS: run deploy/pair.sh.',
              style: t.ui.copyWith(fontSize: 13, height: 1.45, color: t.muted),
            ),
            const SizedBox(height: 24),
            if (widget.scanner != null) ...[
              ScanPrompt(onScan: _scan, busy: _busy),
              const SizedBox(height: 20),
            ] else
              const SizedBox(height: 4),
            PairingField(
              label: 'Address',
              controller: _address,
              focusNode: _addressFocus,
              hint: '100.64.0.3:8787',
              mono: true,
              // Only when typing is the whole story: with a camera, a keyboard over half
              // the screen pre-empts a choice the operator has not made yet.
              autofocus: widget.scanner == null,
              keyboardType: TextInputType.url,
            ),
            const SizedBox(height: 18),
            PairingCodeCells(
              label: 'Pairing code',
              controller: _code,
              refused: _codeRefused,
              enabled: !_busy,
              onFilled: _codeFilled,
            ),
            const SizedBox(height: 18),
            PairingField(
              label: 'This phone',
              controller: _name,
              focusNode: _nameFocus,
              hint: 'Lotus Pocket',
              // The name the desktop's revoke list shows — "Revoke Lotus Pocket" is
              // useless with two phones paired, which is why the operator chooses it.
            ),
            const SizedBox(height: 24),
            PairButton(busy: _busy, onTap: _submit),
            if (_diagnosis != null) ...[
              const SizedBox(height: 22),
              DiagnosisBlock(diagnosis: _diagnosis!),
            ],
          ],
        ),
      ),
    );
  }
}
