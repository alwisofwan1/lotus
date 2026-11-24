import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/transcript_pager.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/app/theme/surface_tokens.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/features/agent/agent_page.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_top_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/mini_bar.dart';
import 'package:lotus_pocket/features/shared/composer.dart';
import 'package:xterm/xterm.dart' show TerminalView;
import 'package:lotus_pocket/features/agent/widgets/view_switch.dart';
import 'package:lotus_pocket/data/agent_repository.dart';
import 'package:lotus_pocket/data/draft_keeper.dart';
import 'package:lotus_pocket/features/agent/widgets/answer_chips.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_lines.dart';
import 'package:lotus_pocket/features/agent/widgets/key_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/raw_terminal.dart';
import 'package:lotus_pocket/features/agent/widgets/find_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/quote_strip.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_dock.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/features/shared/send_button.dart';
import 'package:lotus_pocket/features/shared/field_glyphs.dart';

import '../../support/upright.dart';
import '../../support/agent_harness.dart';
import '../../support/fake_security.dart';
import '../../support/fake_transport.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');
final Directory fixtures = Directory('../../contract/fixtures');
String fixture(String name) => File('${fixtures.path}/$name.json').readAsStringSync();

final DateTime now = DateTime.utc(2026, 8, 6, 12);

Cell cell({
  HostId host = mac,
  String title = 'Atlas',
  String? turn,
  String? preview,
  String? gating,
  bool terminal = true,
}) =>
    Cell(
      host: host,
      paneId: 'p-1',
      workspaceId: 'CNVS',
      workspaceLabel: 'CNVS',
      agentType: 'claude',
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
      turnAgeMs: turn == null ? null : 120000,
      gating: gating,
      lastOutputPreview: preview,
      terminal: terminal,
    );

void main() {
  late AgentHarness harness;
  late FakeHttpTransport http;
  late FakeBiometrics biometrics;
  late HostRegistry registry;
  late AgentRepository repository;
  late DraftKeeper drafts;

  setUp(() async {
    harness = await AgentHarness.paired(at: now);
    // Settles instantly: a widget test runs on a fake clock, so the real settle window
    // would be a wait no `pump` ever finishes.
    drafts = DraftKeeper(InMemorySecureStore(), sleep: (_) async {});
    await drafts.load();
    http = harness.http;
    biometrics = harness.biometrics;
    registry = harness.registry;
    repository = harness.repository;
  });

  tearDown(() => harness.dispose());

  var backs = 0;

  Future<void> show(WidgetTester tester, Cell c, {String hostLabel = 'mac'}) async {
    backs = 0;
    holdUpright(tester);
    // What `AgentScreen` does before it builds a page, and it has to be done here for
    // the same reason it moved there: a page no longer points the transcript store at
    // itself. Two live pages each doing that is the defect `issues/12` names — so a
    // page mounted without its pager has to be told, exactly as the pager tells it.
    harness.live.follow([c.ref]);
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: AgentPage(
          cell: c,
          repository: repository,
          live: harness.live,
          pager: TranscriptPager(fetch: (_, _) async => null),
          snippets: harness.snippets,
          drafts: drafts,
          index: 0,
          total: 3,
          hostLabel: hostLabel,
          waitingAt: const {0},
          onBack: () => backs++,
        ),
      ),
    ));
    await tester.pumpAndSettle();
  }

  group('an unsent draft', () {
    testWidgets('is waiting in the composer when the agent is opened again',
        (tester) async {
      await drafts.keep(cell().ref, 'setengah kalimat yang belum');
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');

      await show(tester, cell(turn: 'running'));

      // A paragraph typed while walking is the thing this page can least afford to
      // throw away, and backing out to check another agent used to do exactly that.
      expect(find.text('setengah kalimat yang belum'), findsOne);
    });

    testWidgets('is forgotten once it has been sent', (tester) async {
      await drafts.keep(cell().ref, 'setengah kalimat yang belum');
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(turn: 'running'));

      http
        ..enqueue('{"ok":true}')
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(drafts.draftFor(cell().ref), isNull,
          reason: 'the sent draft would be restored over the next thing typed');
    });
  });

  group('the same actions are reachable without going back to the list', () {
    /// The title is the drawer's handle (v4 tiket 03) — there is no separate disclosure.
    Future<void> openDrawer(WidgetTester tester) async {
      await tester.tap(find.text('Atlas'));
      await tester.pumpAndSettle();
    }

    testWidgets('stop is one tap from the page, and it is gated', (tester) async {
      await show(tester, cell(title: 'Atlas', turn: 'running'));
      http.sent.clear();

      await openDrawer(tester);
      expect(find.text('Stop turn'), findsOne);
      // Not on this page: the composer below is already aimed at this agent, so a
      // *Send here* button would be a label over a no-op.
      expect(find.text('Send here'), findsNothing);

      await tester.tap(find.text('Stop turn'));
      await tester.pumpAndSettle();

      expect(http.last.uri.path, '/m/cell/p-1/stop');
      expect(biometrics.prompts, greaterThan(0));
    });

    testWidgets('and close stays hidden on a host that cannot end a cell',
        (tester) async {
      await show(tester, cell(title: 'Atlas', turn: 'running'));

      await openDrawer(tester);

      expect(find.text('Close'), findsNothing);
    });
  });

  group('the header names who, where, and what is happening', () {
    Future<void> openDrawer(WidgetTester tester) async {
      await tester.tap(find.text('Atlas'));
      await tester.pumpAndSettle();
    }

    testWidgets('one row: persona, then a state word and the project', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      await show(tester, cell(turn: 'running', preview: 'reading the legacy shim'));

      expect(find.text('Atlas'), findsOne);
      expect(find.text('working'), findsOne);
      expect(find.text(' 2m · CNVS'), findsOne);
      // ≤ 56px was the target; the pips under the title are what this page adds to it.
      expect(tester.getSize(find.byType(AgentTopBar)).height, lessThanOrEqualTo(66));
    });

    testWidgets('the context behind the title: project, host, runner and age', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      await show(tester, cell(turn: 'running'));
      expect(find.text('CNVS · mac · claude · 2m'), findsNothing);

      await openDrawer(tester);

      // One mono run rather than a stacked corner: a stacked corner truncated away the
      // project, the half that keeps two same-named repositories apart (R-10). And the
      // runner is named, which a constant `∗` glyph only ever claimed to do.
      expect(find.text('CNVS · mac · claude · 2m'), findsOne);
    });

    testWidgets('the machine is named only when it distinguishes something',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      // What `CompositionRoot.hostLabel` hands down with a single machine paired:
      // `hostQualifier` returns empty, because a word every screen shares distinguishes
      // nothing (`issues/11`).
      await show(tester, cell(turn: 'running'), hostLabel: '');
      await openDrawer(tester);

      expect(find.text('CNVS · claude · 2m'), findsOne);
      expect(find.textContaining('mac'), findsNothing);
    });

    testWidgets('a waiting agent says "needs you" in amber — a different word, not only a colour',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      await show(tester, cell(turn: 'needs-input'));

      final doing = tester.widget<Text>(find.text('needs you'));
      expect(doing.style!.color, AppTokens.dark.waiting);
      // The word itself changes too, so the state survives a screen reader and a
      // colour-blind eye (a11y): nothing else on the bar says `working` meanwhile.
      expect(find.text('working'), findsNothing);
    });

    testWidgets('a working agent is not amber', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');

      await show(tester, cell(turn: 'running'));

      final doing = tester.widget<Text>(find.text('working'));
      expect(doing.style!.color, isNot(AppTokens.dark.waiting));
    });

    testWidgets('back is reported to the caller, not handled here', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));
      await show(tester, cell(turn: 'running'));

      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pumpAndSettle();

      expect(backs, 1);
    });
  });

  group('Chat: three kinds of line, and no colour at all', () {
    testWidgets('renders the prompt bubble, the steps, and the diff badge',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');

      await show(tester, cell(turn: 'running'));

      expect(find.text('clean up the legacy files'), findsOne);
      expect(find.text('edit'), findsOne);
      expect(find.text('read'), findsOne);
      // Absent is not zero: only the Edit entry carries counts in the fixture.
      expect(find.textContaining('−34', findRichText: true), findsOne);
    });

    /// The door into raw output is the header's `Chat | Terminal` switch (ADR-6 addendum
    /// 2026-10-04, v4 tiket 03): reachable from wherever the operator has scrolled to.
    /// The composer's `TERM` button went with the sheet it raised.
    testWidgets('the way into raw output is the header switch', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');

      await show(tester, cell(turn: 'running'));

      expect(find.byType(ViewSwitch), findsOne);
      expect(find.text('TERM'), findsNothing);
      // And not a second one buried in the transcript, competing with the answer.
      expect(find.text('RAW TERMINAL'), findsNothing);
    });

    /// Fase 5 smoke (2026-11-17): a Chat agent's Terminal tab opened onto nothing.
    testWidgets('a Chat cell, which has no terminal, offers no switch', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');

      await show(tester, cell(turn: 'running', terminal: false));

      expect(find.byType(ViewSwitch), findsNothing);
    });
  });

  group('the permission card', () {
    Future<void> showAsking(WidgetTester tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));
      await show(tester, cell(turn: 'needs-input'));
    }

    /// **The card only ever appeared if you arrived after the question did.**
    ///
    /// Reported from a real device on 2026-09-09: the header said `needs you`, the step
    /// `askuserquestion` was in the transcript, and there was no card at all. The page had
    /// the fleet's new word for the cell — that is where `needs you` comes from — but
    /// `/permission` had been read once, when the page opened and nothing was being asked.
    /// Nothing read it again, so the answer the card is drawn from stayed `awaiting: false`.
    testWidgets('appears when the cell starts asking while the page is already open',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission-unsupported'));
      await show(tester, cell(turn: 'running'));
      expect(find.text('Do you want to delete src/legacy/shim.ts?'), findsNothing);

      // The agent stops and asks. This is the fleet's word arriving, not the operator
      // doing anything — no tap, no pull, no send.
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));
      await show(tester, cell(turn: 'needs-input'));
      await tester.pumpAndSettle();

      expect(find.text('Do you want to delete src/legacy/shim.ts?'), findsOne);
    });

    testWidgets('renders the question and every option verbatim', (tester) async {
      await showAsking(tester);

      expect(find.text('Do you want to delete src/legacy/shim.ts?'), findsOne);
      // Labels are never paraphrased — the mockup once invented one that does not exist.
      expect(find.text('Yes'), findsOne);
      expect(find.text('Yes, allow all edits during this session (shift+tab)'), findsOne);
      expect(find.text('No'), findsOne);
    });

    testWidgets('every answer carries identical weight — yes is not the easy path',
        (tester) async {
      await showAsking(tester);

      TextStyle styleOf(String label) => tester.widget<Text>(find.text(label)).style!;

      // ADR-8's reason, as an assertion: a filled Allow beside an outlined Deny makes yes
      // the path of least resistance, and this button can delete a file.
      expect(styleOf('Yes').fontSize, styleOf('No').fontSize);
      expect(styleOf('Yes').fontWeight, styleOf('No').fontWeight);
    });

    /// Answering goes to `/input`, not `/dispatch`, and the difference is not cosmetic.
    ///
    /// Measured against a real VPS host on 2026-09-05: the operator tapped an answer, it
    /// left as `/dispatch`, the host answered 200, and **nothing happened** — a structured
    /// cell (`tui: false`) treats a dispatch as a new user message, and the approval it was
    /// holding stayed open. The phone kept saying "needs you", honestly, and the operator
    /// answered eight more times. The same digit sent to `/input` unblocked it at once.
    ///
    /// `/input` is also what the routes mean: dispatch is *a sentence* and the host appends
    /// a submit key to it; input is *a key press*, sent exactly as given. An answer to a
    /// prompt is a key press in both worlds.
    testWidgets('answering sends the printed digit, never the position', (tester) async {
      await showAsking(tester);
      // The answer, then the transcript+permission reload it triggers. Scripting all
      // three keeps the assertion about the answer rather than about the reload.
      http
        ..enqueue('{"ok":true}')
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      // Scrolled to first, and that is not test scaffolding — it is the honest shape of
      // the screen. The permission card sits *after* the transcript, so a long enough
      // transcript puts the thing the operator was woken up for below the fold. Sticky
      // scroll is what fixes that in the product; here it only has to be reachable.
      await tester.ensureVisible(find.text('No'));
      await tester.pumpAndSettle();

      // `No` is printed as `3`. A button that sent its index would send `2` and answer a
      // different question than the one shown.
      await tester.tap(find.text('No'));
      await tester.pumpAndSettle();

      // Found by route, not by taking the last request: a landed answer is followed by a
      // transcript+permission reload, so `last` is that reload rather than the answer.
      final answer = http.sent.firstWhere((r) => r.uri.path == '/m/cell/p-1/input');
      expect(answer.json, {'data': '3'});
      // And it must not ALSO arrive as prose. A structured cell would file that as a new
      // user message while the approval stayed open.
      expect(http.sent.any((r) => r.uri.path == '/m/cell/p-1/dispatch'), isFalse);
    });

    /// Temuan §9 no. 3 di `revamp-audit.html`: *menjawab izin adalah interaksi paling
    /// penting di alur inti.* Yang tes di atas sebut apa adanya — "sticky scroll is what
    /// fixes that in the product; here it only has to be reachable" — sampai 2026-08-12
    /// tidak pernah dijamin siapa pun. Ini yang menjaminnya.
    ///
    /// Kartu izinnya adalah **footer** daftar, jadi transkrip yang panjang bisa menaruh
    /// satu-satunya hal yang membangunkan operator di bawah lipatan. `_stickToBottom`
    /// yang mencegahnya, dan ia bekerja dalam empat lintasan pasca-frame justru karena
    /// `ListView` membangun lambat — angka yang sudah diukur (`chat_view.dart`).
    ///
    /// Diuji di 360×800 dengan transkrip 40 langkah: jauh lebih panjang dari layarnya,
    /// jadi lipatan itu nyata dan bukan hipotesis.
    testWidgets('terlihat tanpa digeser, bahkan di bawah transkrip yang panjang',
        (tester) async {
      tester.view.physicalSize = const Size(360 * 3, 800 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final entries = [
        for (var i = 0; i < 40; i++)
          '{"event":"tool-post","status":"done","title":"Edit",'
              '"body":"src/step-$i.ts","userPrompt":"clean up the legacy files",'
              '"toolTarget":"src/step-$i.ts","linesAdded":3,"linesRemoved":1,'
              '"timestamp":1785664800000}',
      ].join(',');
      http
        ..enqueue('{"paneId":"p-1","total":40,"entries":[$entries]}')
        ..enqueue(fixture('rest-permission'));
      await show(tester, cell(turn: 'needs-input'));
      await tester.pumpAndSettle();

      // Tanpa satu geseran pun: jawabannya harus sudah berada di dalam layar.
      final screen = tester.view.physicalSize.height / tester.view.devicePixelRatio;
      for (final label in ['Yes', 'No']) {
        final box = tester.getRect(find.text(label));
        expect(box.top, greaterThanOrEqualTo(0), reason: label);
        expect(box.bottom, lessThanOrEqualTo(screen), reason: label);
      }
    });

    testWidgets('answering passes the biometric gate first', (tester) async {
      await showAsking(tester);
      biometrics.answer = false;
      final before = http.sent.length;

      await tester.tap(find.text('Yes'));
      await tester.pumpAndSettle();

      // Refused proof means the request is never made, not merely ignored.
      expect(http.sent, hasLength(before));
      expect(find.textContaining('Not sent'), findsOne);
    });

    testWidgets('waiting with unreadable options points at the terminal, not at buttons',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":true,"prompt":null}');

      await show(tester, cell(turn: 'needs-input'));

      // An honest answer with its own meaning: waiting, but the options could not be read.
      expect(find.textContaining('options could not be read'), findsOne);
      expect(find.text('Yes'), findsNothing);
      expect(find.text('READ IT IN FULL'), findsOne);
    });
  });

  group('the composer', () {
    testWidgets('copy follows the state — asking continues the buttons above',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));
      await show(tester, cell(turn: 'needs-input'));

      // The leading ellipsis is load-bearing: two buttons look like the only two answers,
      // and the answer that is often right is a third one.
      expect(find.text('…or tell Atlas what to do instead'), findsOne);
    });

    testWidgets('a working agent gets the plain reply prompt', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(turn: 'running'));

      expect(find.text('Reply to Atlas'), findsOne);
    });

    testWidgets('typing and sending dispatches, gated', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(turn: 'running'));

      await tester.enterText(find.byType(TextField), 'run the tests');
      http
        ..enqueue('{"ok":true}')
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(biometrics.prompts, 1);
      expect(http.sent.any((r) => r.uri.path == '/m/cell/p-1/dispatch'), isTrue);
    });

    testWidgets('an empty send never leaves the device', (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(turn: 'running'));
      final before = http.sent.length;

      await tester.enterText(find.byType(TextField), '   ');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      // The host would answer 400; refusing here keeps that round trip off a cellular link.
      expect(http.sent, hasLength(before));
      expect(biometrics.prompts, 0);
    });
  });

  group('a host that cannot do Chat says why, once', () {
    testWidgets('names the project and host, and offers the terminal', (tester) async {
      registry.add(harness.host(vps, mode: 'standalone', features: const ['fleet', 'dispatch']));

      await show(tester, cell(host: vps, turn: null, gating: Cell.gatingRunnerCannot));

      // Nouns the operator recognises, rather than an empty Chat that leaves them guessing
      // whether the agent is silent or the app is broken (§7 no. 10).
      expect(find.textContaining('has no hook pipeline'), findsOne);
      expect(find.textContaining('CNVS · vps'), findsOne);
      expect(find.text('RAW TERMINAL'), findsOne);
      // And no request was spent on routes the host does not advertise.
      expect(http.sent, isEmpty);
    });
  });

  group('Chat and Terminal are two equal views, one tap apart', () {
    Future<void> showChatting(WidgetTester tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(turn: 'running'));
    }

    Finder segment(String label) =>
        find.descendant(of: find.byType(ViewSwitch), matching: find.text(label));

    Future<void> showTerminal(WidgetTester tester) async {
      await tester.tap(segment('Terminal'));
      await tester.pumpAndSettle();
    }

    Future<void> showChat(WidgetTester tester) async {
      await tester.tap(segment('Chat'));
      await tester.pumpAndSettle();
    }

    testWidgets('one tap on Terminal shows it, one tap on Chat comes back — no drag',
        (tester) async {
      await showChatting(tester);
      expect(find.text('clean up the legacy files'), findsOne);
      expect(find.byType(RawTerminal), findsNothing);

      await showTerminal(tester);
      expect(find.byType(RawTerminal), findsOne);
      // Chat is not dimmed underneath any more: it is the other view, kept but not shown.
      expect(find.text('clean up the legacy files'), findsNothing);

      await showChat(tester);
      expect(find.text('clean up the legacy files'), findsOne);
      expect(find.byType(RawTerminal), findsNothing);
    });

    testWidgets('the view left behind is kept, not rebuilt', (tester) async {
      await showChatting(tester);
      await showTerminal(tester);
      final emulator = tester.state(find.byType(RawTerminal));

      await showChat(tester);
      // Still in the tree, offstage — so its scroll and zoom are where they were left.
      expect(
        tester.state(find.byType(RawTerminal, skipOffstage: false)),
        same(emulator),
      );
      expect(find.text('clean up the legacy files', skipOffstage: false), findsOne);

      await showTerminal(tester);
      expect(tester.state(find.byType(RawTerminal)), same(emulator));
    });

    testWidgets('the composer\'s TERM button and the sheet\'s grip are gone', (tester) async {
      await showChatting(tester);
      expect(find.text('TERM'), findsNothing);
      await showTerminal(tester);
      expect(find.text('CHAT'), findsNothing);
    });

    testWidgets('showing Terminal starts the tail, and going to Chat keeps it', (tester) async {
      await showChatting(tester);
      // Nothing is streamed for a page the operator merely swiped past — `MVP.md`
      // counts ~13 KB for one trivial prompt.
      expect(harness.output.watching, isNull);

      await showTerminal(tester);
      expect(harness.output.watching, CellRef(mac, 'p-1'));

      final tails = harness.output.epoch;

      await showChat(tester);
      // The emulator outlives the visit, so there is nothing to refill and nothing to
      // stop: the tail follows the page in front, not the view.
      expect(harness.output.watching, CellRef(mac, 'p-1'));

      await showTerminal(tester);
      expect(harness.output.epoch, tails, reason: 'showing it again did not tail again');
    });

    testWidgets('leaving the page lets go of the tail', (tester) async {
      await showChatting(tester);
      await showTerminal(tester);
      expect(harness.output.watching, CellRef(mac, 'p-1'));

      await tester.pumpWidget(const SizedBox());
      expect(harness.output.watching, isNull);
    });

    testWidgets('Terminal paints its own ground into the header', (tester) async {
      await showChatting(tester);
      Color ground() => (tester
              .widget<AnimatedContainer>(find.descendant(
                of: find.byType(AgentTopBar),
                matching: find.byType(AnimatedContainer),
              ).first)
              .decoration! as BoxDecoration)
          .color!;

      expect(ground(), AppTokens.dark.bg);
      await showTerminal(tester);
      expect(ground(), AppTokens.dark.termBg);
    });

    testWidgets('system back goes to Chat before it leaves the page', (tester) async {
      await showChatting(tester);
      await showTerminal(tester);

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      // The tail stays: this page is still the one in front.
      expect(find.text('clean up the legacy files'), findsOne);
      expect(find.byType(RawTerminal), findsNothing);
      expect(harness.output.watching, CellRef(mac, 'p-1'));
      expect(backs, 0);
    });

    testWidgets('the header\'s back leaves the page from Terminal too, and only ever means that',
        (tester) async {
      await showChatting(tester);
      await showTerminal(tester);

      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pumpAndSettle();

      // `agent_page_test.dart:596` before v4: `‹` once meant *leave the mode* here and
      // *leave the page* everywhere else. It still has only the second meaning.
      expect(backs, 1);
    });

    testWidgets('back is layered: keys off, Chat, then the page',
        (tester) async {
      // A host that takes keys, so the `⌨` exists.
      registry.add(harness.host(vps, features: const [
        'fleet', 'dispatch', 'transcript', 'permission', 'input',
      ]));
      await harness.pair(vps);
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(host: vps, turn: 'running'));
      await showTerminal(tester);
      await tester.tap(find.ancestor(of: find.byType(KeyboardGlyph), matching: find.byType(InkWell)).first);
      await tester.pumpAndSettle();
      expect(find.byType(KeyBar), findsOne);
      expect(find.byType(MiniBar), findsOne);

      // 1. keys off
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(KeyBar), findsNothing);
      expect(find.byType(AgentTopBar), findsOne);
      expect(find.byType(RawTerminal), findsOne);

      // 2. back to Chat
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(RawTerminal), findsNothing);

      // 3. Chat has nothing left to undo, so the page may pop.
      final scope = tester.widget<PopScope>(find.byWidgetPredicate((w) => w is PopScope).last);
      expect(scope.canPop, isTrue);
      expect(backs, 0);
    });

    testWidgets('a host without keys offers no way to type from Terminal', (tester) async {
      await showChatting(tester);
      await showTerminal(tester);
      // A host that does not advertise `input` gets no `Type to session`, which is the
      // case this harness pairs. Since v4 tiket 04 there is no composer here either:
      // writing to that agent is Chat's job, one tap away.
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(KeyboardGlyph), findsNothing);
    });

    group('quick answers live in Terminal (v4 tiket 06)', () {
      // Scoped to the chips, because the card they mirror is still kept in Chat.
      Finder chip(String label) =>
          find.descendant(of: find.byType(AnswerChips), matching: find.text(label));

      testWidgets('three options are three chips, above the dock', (tester) async {
        http
          ..enqueue(fixture('rest-transcript'))
          ..enqueue(fixture('rest-permission'));
        await show(tester, cell(turn: 'needs-input'));
        await showTerminal(tester);

        // Verbatim and by printed digit — ADR-8's rules are inherited from the same
        // `PermissionPrompt`, not restated.
        expect(chip('Yes'), findsOne);
        expect(chip('Yes, allow all edits during this session (shift+tab)'), findsOne);
        expect(chip('No'), findsOne);
        expect(find.descendant(of: find.byType(RawTerminal), matching: find.byType(AnswerChips)),
            findsOne);
        expect(tester.getBottomLeft(find.byType(AnswerChips)).dy,
            lessThanOrEqualTo(tester.getTopLeft(find.byType(TerminalDock)).dy));
      });

      testWidgets('chip 2 sends 2 to the session', (tester) async {
        http
          ..enqueue(fixture('rest-transcript'))
          ..enqueue(fixture('rest-permission'));
        await show(tester, cell(turn: 'needs-input'));
        await showTerminal(tester);

        await tester.tap(chip('Yes, allow all edits during this session (shift+tab)'));
        await tester.pumpAndSettle();

        // Same route as the card's own buttons: these are the same answer.
        final answer = http.sent.firstWhere((r) => r.uri.path == '/m/cell/p-1/input');
        expect(answer.json, {'data': '2'});
      });

      testWidgets('options nobody could read are no chips (ADR-8)', (tester) async {
        http
          ..enqueue(fixture('rest-transcript'))
          ..enqueue('{"paneId":"p-1","awaiting":true,"prompt":null}');
        await show(tester, cell(turn: 'needs-input'));
        await showTerminal(tester);

        expect(find.byType(AnswerChips), findsNothing);
      });

      testWidgets('a host that cannot tell is no chips either', (tester) async {
        http
          ..enqueue(fixture('rest-transcript'))
          // Options read, but the host cannot tell whether the cell is waiting at all.
          ..enqueue(fixture('rest-permission')
              .replaceFirst('"awaiting": true', '"awaiting": true, "hostSupports": false'));
        await show(tester, cell(turn: 'needs-input'));
        await showTerminal(tester);

        expect(find.byType(AnswerChips), findsNothing);
      });

      /// The device, 2026-10-04: a question's options carry description rows, so the host
      /// names no prompt — but the screen still proves each digit, as Chat already uses.
      testWidgets('a question the screen proves gets chips too, and they send its digit',
          (tester) async {
        http
          ..enqueue(fixture('rest-transcript'))
          ..enqueue('''{"paneId":"p-1","awaiting":true,"prompt":null,
              "tail":"Mau lanjut kerja apa dulu?\\n\\n❯ 1. GitHub Issues source\\n     Mulai tambah.\\n  2. Tes APK di HP\\n     Cek fitur dock.\\n  3. Type something."}''');
        await show(tester, cell(turn: 'needs-input'));
        harness.live.seed(cell().ref, [
          Turn(turnId: 't9', startedAt: now, parts: [
            QuestionPart(
              id: 'q1',
              ts: now,
              seq: 1,
              provenance: Provenance.derived,
              questions: const [
                UserQuestion(question: 'Mau lanjut kerja apa dulu?', options: [
                  UserQuestionOption(label: 'GitHub Issues source'),
                  UserQuestionOption(label: 'Tes APK di HP'),
                ]),
              ],
            ),
          ]),
        ]);
        await tester.pumpAndSettle();
        await showTerminal(tester);

        expect(chip('GitHub Issues source'), findsOne);
        expect(chip('Tes APK di HP'), findsOne);
        // The terminal's own choice hands over to typing — `Type to session` does that here.
        expect(chip('Type something.'), findsNothing);

        await tester.tap(chip('Tes APK di HP'));
        await tester.pumpAndSettle();

        final answer = http.sent.firstWhere((r) => r.uri.path == '/m/cell/p-1/input');
        expect(answer.json, {'data': '2'});
      });

      testWidgets('no chips while keys are live — a digit is typed then', (tester) async {
        registry.add(harness.host(vps, features: const [
          'fleet', 'dispatch', 'transcript', 'permission', 'input',
        ]));
        await harness.pair(vps);
        http
          ..enqueue(fixture('rest-transcript'))
          ..enqueue(fixture('rest-permission'));
        await show(tester, cell(host: vps, turn: 'needs-input'));
        await showTerminal(tester);
        expect(find.byType(AnswerChips), findsOne);

        await tester.tap(find.descendant(
          of: find.bySemanticsLabel('Type to session'),
          matching: find.byType(InkWell),
        ));
        await tester.pumpAndSettle();

        expect(find.byType(KeyBar), findsOne);
        expect(find.byType(AnswerChips), findsNothing);
      });
    });

    testWidgets('Terminal carries no composer, whatever the host can do', (tester) async {
      await showChatting(tester);
      expect(find.byType(Composer), findsOne);

      await showTerminal(tester);
      // v4 tiket 04: one way to type into a PTY. Long prompts are written in Chat, one
      // tap away on the switch.
      expect(find.byType(Composer), findsNothing);
      expect(find.byType(TextField), findsNothing);
    });

    /// v4 tiket 07, B4: a search costs no row of output — the bar takes the header's.
    testWidgets('find takes the header\'s place, and Done gives it back', (tester) async {
      await showChatting(tester);
      await showTerminal(tester);
      expect(find.byType(AgentTopBar), findsOne);

      await tester.tap(find.descendant(
        of: find.bySemanticsLabel('Find in output'),
        matching: find.byType(InkWell),
      ));
      await tester.pump();
      expect(find.byType(FindBar), findsOne);
      expect(find.byType(AgentTopBar), findsNothing);

      await tester.tap(find.descendant(
        of: find.bySemanticsLabel('Done'),
        matching: find.byType(InkWell),
      ));
      await tester.pump();
      expect(find.byType(FindBar), findsNothing);
      expect(find.byType(AgentTopBar), findsOne);
    });

    testWidgets('ask on a selection quotes it in Chat, and sends nothing', (tester) async {
      await showChatting(tester);
      await showTerminal(tester);
      final before = http.sent.length;

      tester.widget<RawTerminal>(find.byType(RawTerminal)).onAsk!('TypeError: x is undefined');
      await tester.pumpAndSettle();

      expect(find.byType(RawTerminal), findsNothing, reason: 'Chat is shown');
      expect(
        find.descendant(of: find.byType(QuoteStrip), matching: find.textContaining('TypeError')),
        findsOne,
      );
      expect(http.sent.skip(before).where((r) => r.uri.path.endsWith('/dispatch')), isEmpty);
    });

    testWidgets('a failed read offers no switch', (tester) async {
      http.failWith = const TransportUnavailable('asleep', cause: TransportCause.timedOut);
      await show(tester, cell(turn: 'running'));

      // It would open a terminal for a host that just said it cannot be reached.
      expect(find.byType(ViewSwitch), findsNothing);
    });
  });

  group('typing into the session has one path (v4 tiket 04)', () {
    Future<void> showKeyedTerminal(WidgetTester tester) async {
      registry.add(harness.host(vps, features: const [
        'fleet', 'dispatch', 'transcript', 'permission', 'input',
      ]));
      await harness.pair(vps);
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
      await show(tester, cell(host: vps, turn: 'running'));
      await tester.tap(find.descendant(
        of: find.byType(ViewSwitch),
        matching: find.text('Terminal'),
      ));
      await tester.pumpAndSettle();
    }

    Finder typeToSession() => find.descendant(
          of: find.bySemanticsLabel('Type to session'),
          matching: find.byType(InkWell),
        );

    testWidgets('the dock offers it, and keys stay off until it is tapped', (tester) async {
      await showKeyedTerminal(tester);

      expect(typeToSession(), findsOne);
      expect(find.byType(KeyBar), findsNothing);
      expect(find.byType(AgentTopBar), findsOne);
      expect(find.byType(MiniBar), findsNothing);
    });

    testWidgets('tapping it makes keys live and shrinks the header to a 36px mini bar',
        (tester) async {
      await showKeyedTerminal(tester);

      await tester.tap(typeToSession());
      await tester.pumpAndSettle();

      expect(find.byType(KeyBar), findsOne);
      expect(find.byType(AgentTopBar), findsNothing);
      expect(find.byType(MiniBar), findsOne);
      expect(tester.getSize(find.byType(MiniBar)).height, MiniBar.height);
      // The dock gives its row to the keys.
      expect(typeToSession(), findsNothing);
    });

    testWidgets('the mini bar lowers the keyboard, and the full header comes back',
        (tester) async {
      await showKeyedTerminal(tester);
      await tester.tap(typeToSession());
      await tester.pumpAndSettle();

      await tester.tap(find.descendant(
        of: find.bySemanticsLabel('Hide keyboard'),
        matching: find.byType(InkWell),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(KeyBar), findsNothing);
      expect(find.byType(MiniBar), findsNothing);
      expect(find.byType(AgentTopBar), findsOne);
      expect(find.byType(RawTerminal), findsOne);
    });

    testWidgets('the mini bar\'s switch goes back to Chat', (tester) async {
      await showKeyedTerminal(tester);
      await tester.tap(typeToSession());
      await tester.pumpAndSettle();

      await tester.tap(find.descendant(of: find.byType(MiniBar), matching: find.text('Chat')));
      await tester.pumpAndSettle();

      expect(find.byType(RawTerminal), findsNothing);
      expect(find.byType(AgentTopBar), findsOne);
    });

    testWidgets('letters reach /input, never /dispatch', (tester) async {
      await showKeyedTerminal(tester);
      await tester.tap(typeToSession());
      await tester.pumpAndSettle();

      http.enqueue('{"ok":true}');
      tester.widget<TerminalView>(find.byType(TerminalView)).terminal.textInput('ls');
      await tester.pumpAndSettle();

      final input = http.sent.where((r) => r.uri.path == '/m/cell/p-1/input').toList();
      expect(input.map((r) => r.json), [
        {'data': 'ls'},
      ]);
      expect(http.sent.where((r) => r.uri.path == '/m/cell/p-1/dispatch'), isEmpty);
    });
  });

  group('what the operator said appears before the host has echoed it', () {
    const String noPermission = '{"paneId":"p-1","awaiting":false,"prompt":null}';

    /// Opens on a working agent, then scripts the three replies a landed dispatch
    /// costs: the dispatch itself, and the transcript + permission reload it triggers.
    ///
    /// Scripting the reload is not ceremony. An unscripted queue answers `{}`, which
    /// `TranscriptSnapshot.fromJson` rejects, so the whole page turns into the read
    /// failure — and every assertion about a bubble then fails for a reason that has
    /// nothing to do with bubbles.
    Future<void> openThenScriptSend(WidgetTester tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(noPermission);
      await show(tester, cell(turn: 'running'));
      http
        ..enqueue('{"ok":true}')
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(noPermission);
    }

    testWidgets('the bubble is there while the biometric sheet is still up',
        (tester) async {
      await openThenScriptSend(tester);
      // Held open, because this is the moment the whole feature exists for: before it,
      // what the operator typed was on screen nowhere at all.
      final sheet = Completer<void>();
      biometrics.holdPrompt = sheet;

      await tester.enterText(find.byType(TextField), 'run the tests');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pump();
      await tester.pump();

      expect(find.text('run the tests'), findsOne);
      expect(find.text('sending…'), findsOne);

      sheet.complete();
      await tester.pumpAndSettle();

      // And once the host has it, the line stops claiming anything.
      expect(find.text('sending…'), findsNothing);
      expect(find.text('run the tests'), findsOne);
    });

    testWidgets('a landed dispatch stops claiming anything and simply stays',
        (tester) async {
      await openThenScriptSend(tester);

      await tester.enterText(find.byType(TextField), 'run the tests');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      // The host took it, so `sending…` would now be false — but the agent has filed no
      // hook carrying it, so dropping the line would make what was said disappear.
      expect(find.text('run the tests'), findsOne);
      expect(find.text('sending…'), findsNothing);
    });

    testWidgets('a refusal leaves the sentence on screen with its own retry',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(noPermission);
      await show(tester, cell(turn: 'running'));
      // Refused proof means no request is made at all, so there is no reload to script.
      biometrics.answer = false;

      await tester.enterText(find.byType(TextField), 'run the tests');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(find.text('run the tests'), findsOne);
      expect(find.text('not sent · tap to retry'), findsOne);
    });

    testWidgets('a refused dispatch leaves the field empty, because the line holds it',
        (tester) async {
      // The mirror of Home, where the same failure puts the words back. Here they are
      // already on screen as a bubble with its own retry, so restoring them as well
      // would show one message twice and invite it being sent twice.
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(noPermission);
      await show(tester, cell(turn: 'running'));
      biometrics.answer = false;

      await tester.enterText(find.byType(TextField), 'run the tests');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
    });

    testWidgets('answering a permission draws no bubble — a digit is not a sentence',
        (tester) async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));
      await show(tester, cell(turn: 'needs-input'));

      http
        ..enqueue('{"ok":true}')
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));
      await tester.ensureVisible(find.text('No'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('No'));
      await tester.pumpAndSettle();

      // Back to the top, because a waiting page opens at the permission card and a
      // `ListView` never builds what is far above the viewport — counting there would
      // count nothing and pass for the wrong reason.
      await tester.drag(find.byType(ListView), const Offset(0, 3000));
      await tester.pumpAndSettle();

      // Exactly one bubble, and it is the fixture's own prompt. An answer is a button
      // that was pressed, not a thing that was said, and the transcript already carries
      // the step it causes.
      expect(find.byType(MineBubble), findsOne);
      expect(find.text('clean up the legacy files'), findsOne);
    });
  });


  testWidgets('an unreachable host names the cause and offers a retry', (tester) async {
    http.failWith = const TransportUnavailable('asleep', cause: TransportCause.timedOut);

    await show(tester, cell(turn: 'running'));

    expect(find.text('That machine is asleep.'), findsOne);
    expect(find.text('TRY AGAIN'), findsOne);
  });
}
