import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../shared/lotus_mark.dart';
import 'widgets/intro_glyphs.dart';
import 'widgets/intro_pane.dart';

/// Three panes, shown once, in front of the pairing form on a phone that has never
/// been paired.
///
/// Each answers a question the operator currently answers by guessing:
///
/// 1. **What is this?** — Pocket attaches to agents already running elsewhere. Said
///    first because everything after it depends on that model being right, and a
///    pairing form implies a very different one.
/// 2. **What does it need?** — a machine with Lotus open, the camera, and a
///    fingerprint. The third is the reason this pane exists at all: ADR-8 gates every
///    mutation behind biometrics, and today that sheet arrives unannounced on the
///    operator's first dispatch.
/// 3. **What does amber mean?** — `MVP.md` gives this app one coloured meaning, and
///    the whole screen design depends on the operator knowing it. Teaching it costs
///    one pane; discovering it costs a missed agent.
///
/// **Nothing here collects anything.** No account, no email, no telemetry consent —
/// there is nothing to opt into, and a pane that asked would stand between the
/// operator and the only thing they came to do.
class IntroPages extends StatefulWidget {
  const IntroPages({required this.onDone, super.key});

  /// Finished, or skipped. They are the same answer, and `app/` decides what follows.
  final VoidCallback onDone;

  @override
  State<IntroPages> createState() => _IntroPagesState();
}

class _IntroPagesState extends State<IntroPages> {
  final _pages = PageController();
  int _index = 0;

  static const int _count = 3;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  void _next() {
    if (_index == _count - 1) {
      widget.onDone();
      return;
    }
    _pages.nextPage(
      // A plain horizontal slide, unlike the splash's cross-fade. These *are*
      // different pages, and disguising that would take away the sense of progress
      // the pips are there to give.
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final last = _index == _count - 1;

    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: Column(
          children: [
            _header(t, last: last),
            Expanded(
              child: PageView(
                controller: _pages,
                onPageChanged: (i) => setState(() => _index = i),
                children: [_what(t), _needs(t), _amber(t)],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 4, 22, 22),
              child: IntroButton(
                label: last ? 'Pair a machine' : 'Continue',
                onTap: _next,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Pips on the left, Skip on the right — and Skip disappears on the last pane,
  /// where it and the button below would be the same tap with two names.
  Widget _header(AppTokens t, {required bool last}) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22),
        child: SizedBox(
          height: kMinHitTarget,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _pips(t),
              if (!last)
                Material(
                  color: Colors.transparent,
                  borderRadius: BorderRadius.circular(10),
                  child: InkWell(
                    onTap: widget.onDone,
                    borderRadius: BorderRadius.circular(10),
                    child: Container(
                      height: kMinHitTarget,
                      alignment: Alignment.centerRight,
                      padding: const EdgeInsets.only(left: 18),
                      child: Text(
                        'Skip',
                        style: t.ui.copyWith(fontSize: 12, color: t.dim),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      );

  Widget _pips(AppTokens t) => Semantics(
        label: 'Page ${_index + 1} of $_count',
        child: Row(
          children: List.generate(_count, (i) {
            final on = i == _index;
            return AnimatedContainer(
              duration: const Duration(milliseconds: 220),
              curve: Curves.easeOut,
              margin: const EdgeInsets.only(right: 6),
              width: on ? 18 : 5,
              height: 5,
              decoration: BoxDecoration(
                // `faint` is ornament-only, and a pip is exactly that.
                color: on ? t.text.withValues(alpha: 0.82) : t.faint,
                borderRadius: BorderRadius.circular(3),
              ),
            );
          }),
        ),
      );

  /// Pane 1. The sentence is `apps/pocket/README.md`'s own, verbatim — it is already
  /// the agreed description, and it heads off the expectation a pairing form creates.
  Widget _what(AppTokens t) => IntroPane(
        mark: LotusMark(color: t.text.withValues(alpha: 0.82), size: 52),
        title: 'A remote control for a machine that is already running.',
        body: 'Pocket attaches to agents running on your Mac or your server. It never '
            'clones a repo and it never runs one here — your phone stays a screen and '
            'a keyboard.',
      );

  /// Pane 2. The camera line primes the OS permission sheet one screen before it
  /// appears; the fingerprint line is the one that has no other home.
  Widget _needs(AppTokens t) => IntroPane(
        eyebrow: 'Before you pair',
        title: 'Three things need to be true.',
        rows: [
          IntroRow(
            glyph: IntroGlyph.machine,
            title: 'Lotus is open on that machine',
            body: 'Settings → Mobile access → Pair a phone. It shows a QR and an '
                'eight-digit code.',
          ),
          IntroRow(
            glyph: IntroGlyph.camera,
            title: 'The camera reads that QR',
            body: 'Android asks for it on the next screen. Refuse and you can still '
                'type the address by hand — nothing is locked behind the camera.',
          ),
          IntroRow(
            glyph: IntroGlyph.fingerprint,
            title: 'Your fingerprint approves actions',
            body: 'Reading is free. Sending anything to an agent asks for it once, '
                'then stays open for a few minutes.',
          ),
        ],
      );

  /// Pane 3, and the only place in this app where amber appears without an agent
  /// actually waiting. That is allowed here and nowhere else: it is being defined,
  /// not reported. `intro_pages_test.dart` pins the count at one.
  Widget _amber(AppTokens t) => IntroPane(
        eyebrow: 'One colour, one meaning',
        title: 'When something turns amber, an agent is waiting on you.',
        samples: [
          IntroSample(
            dot: t.waiting,
            title: 'Nara is waiting',
            body: 'Lotus · vps — “Overwrite config.toml?”',
          ),
          IntroSample(
            dot: t.live,
            title: 'Bima is working',
            body: 'CNVS · mac — editing pty.rs',
          ),
        ],
        body: 'Nothing else on that screen is ever coloured. That is the whole trick: '
            'if you see amber, you are the one holding it up.',
      );
}
