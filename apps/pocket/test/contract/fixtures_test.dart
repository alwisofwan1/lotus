import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/models/cell_result.dart';
import 'package:lotus_pocket/models/browse.dart';
import 'package:lotus_pocket/models/clone_job.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/conversation_update.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';
import 'package:lotus_pocket/models/pairing_invite.dart';
import 'package:lotus_pocket/models/permission.dart';
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/models/transcript.dart';
import 'package:lotus_pocket/models/voice.dart';

/// The Dart half of ADR-10: `packages/host` proves it *produces* these payloads,
/// this proves Pocket *parses* the same files. Change a shape on either side
/// without updating the fixture and the other side goes red.
///
/// Read from disk rather than bundled as an asset: the fixtures belong to the
/// contract, not to this app, and a copy inside `assets/` would be a second
/// source that drifts.
final Directory fixtures = Directory('../../contract/fixtures');

/// Frames arrive on a socket that belongs to a known host, so parsing takes one.
const HostId onMac = HostId('mac');

Map<String, Object?> read(String name) =>
    jsonDecode(File('${fixtures.path}/$name.json').readAsStringSync()) as Map<String, Object?>;

void main() {
  test('the contract directory is where we think it is', () {
    expect(fixtures.existsSync(), isTrue,
        reason: 'run from apps/pocket; fixtures live at repo-root contract/fixtures');
  });

  group('stream events', () {
    test('hello carries host identity and capabilities', () {
      final event = ServerEvent.fromJson(read('stream-hello'), host: onMac);

      expect(event, isA<HelloEvent>());
      final hello = event! as HelloEvent;
      expect(hello.hostId, onMac);
      expect(hello.mode, 'client');
      expect(hello.caps.supports('transcript'), isTrue);
      expect(hello.caps.protocol, 1);
    });

    test('a standalone host announces fewer features, and that is the §7 no. 10 answer', () {
      final hello = ServerEvent.fromJson(read('stream-hello-standalone'), host: const HostId('vps'))! as HelloEvent;

      expect(hello.mode, 'standalone');
      for (final absent in ['transcript', 'permission', 'stt']) {
        expect(hello.caps.supports(absent), isFalse, reason: '$absent needs a desktop');
      }
      expect(hello.caps.supports('stream'), isTrue, reason: 'Terminal is fully alive on a VPS');

      // Since 2026-09-05 a VPS host starts and ends cells itself, so the phone draws both
      // controls there. Asserted here because until this line the change was visible only
      // as a diff in the fixture — which says what the list is, never what it should be.
      for (final present in ['spawn', 'close']) {
        expect(hello.caps.supports(present), isTrue,
            reason: '$present is served by the standalone host itself');
      }
      // `spawn-tuning` came later than `spawn`, on 2026-09-10, and the delay was earned:
      // `tuneRunners()` never depended on mode, so the scales were always on the wire —
      // what the VPS could not do was honour them. Its TUI spawn route read only
      // `permissionMode`, so a picked model died one layer short of the argv. The flag went
      // last, after all three runners wrote the flags
      // (`plans/pocket-without-laptop/issues/21-24`).
      expect(hello.caps.supports('spawn-tuning'), isTrue,
          reason: 'the VPS both advertises the scales and now launches with them');
    });

    /// The VPS as it actually runs. The fixture above is the bare machine; this one has the
    /// agent hook the host installs for itself on startup, and as of Fase 3 that hook is what
    /// buys all three Chat capabilities — it names the runner's own transcript file, and it says
    /// a turn happened rather than leaving the terminal to be read for one (ADR-8).
    ///
    /// Asserted here rather than left as a fixture diff: a diff says what the list IS, never
    /// what it should be, and this is the frame the app picks its screens from.
    test('a standalone host with its hook installed offers Chat, with no desktop behind it', () {
      final hello = ServerEvent.fromJson(
        read('stream-hello-standalone-hooked'),
        host: const HostId('vps'),
      )! as HelloEvent;

      expect(hello.mode, 'standalone');
      for (final present in ['transcript', 'conversation', 'permission']) {
        expect(hello.caps.supports(present), isTrue,
            reason: '$present is bought by the agent hook, not by a desktop');
      }
      // Still no desktop, and `stt` is the one that genuinely needs one: it wants a provider
      // key store, and ADR-11 keeps keys off the phone. `spawn-tuning` left this list on
      // 2026-09-10 — it never needed a desktop, only a host that honours what it advertises.
      expect(hello.caps.supports('stt'), isFalse, reason: 'stt needs a desktop key store');
      // The end of the chain this app actually acts on: the host says it has somewhere to
      // clone into, and `PairedHost` is what turns that into a door on the index. A flag
      // nobody reads is a flag that will drift (`plans/pocket-vps-project-checkout/issues/06`).
      expect(hello.caps.supports('projects-create'), isTrue);
      // Two flags, and this host has both: a workspace root is something to clone into and
      // something to browse. A host with only the first is legitimate and must stay drawable.
      expect(hello.caps.supports('projects-browse'), isTrue);
      expect(hello.caps.supports('spawn-tuning'), isTrue,
          reason: 'the knobs are served by this host, not by a desktop');
    });

    test('fleet.changed keeps turn absent for a runner that cannot report it', () {
      final fleet = ServerEvent.fromJson(read('stream-fleet-changed'), host: onMac)! as FleetChangedEvent;

      expect(fleet.cells, hasLength(2));
      final claude = fleet.cells[0];
      expect(claude.ref.toString(), 'mac/p-1', reason: 'host identity attached at parse');
      expect(claude.turn, 'needs-input');
      expect(claude.needsInput, isTrue);
      expect(claude.turnAgeMs, 4000);

      // The trap this test exists for: absent turn is UNKNOWN, never "not waiting".
      final codex = fleet.cells[1];
      expect(codex.turn, isNull);
      expect(codex.turnKnown, isFalse);
      expect(codex.needsInput, isFalse);
      expect(codex.neverAsks, isTrue, reason: 'gating runner_cannot');
    });

    test('fleet.changed names the runner the way the desktop names it', () {
      // `agentType` is the family a client routes on and says `claude` for every custom
      // Claude-family runner; `runnerLabel` is the word the desktop puts on screen. A
      // phone reading only the first disagreed with the desktop beside it.
      final fleet = ServerEvent.fromJson(read('stream-fleet-changed'), host: onMac)! as FleetChangedEvent;

      expect(fleet.cells[0].agentType, 'claude');
      expect(fleet.cells[0].runnerLabel, 'acme');
      // The ask rides with the cell, and a cell the desktop never saw asked has none.
      expect(fleet.cells[0].headline, 'clean up the legacy files');
      expect(fleet.cells[1].headline, isNull);
      expect(fleet.cells[0].runner, 'acme');
    });

    test('cell.output carries the byte offset a later resume asks from', () {
      final out = ServerEvent.fromJson(read('stream-cell-output'), host: onMac)! as CellOutputEvent;

      expect(out.paneId, 'p-1');
      expect(out.chunk, isNotEmpty);
      expect(out.byteOffset, greaterThan(0));
    });

    test('cell.truncated says what it could not serve', () {
      final cut = ServerEvent.fromJson(read('stream-cell-truncated'), host: onMac)! as CellTruncatedEvent;

      expect(cut.requestedFromByte, lessThan(cut.servedFromByte));
    });

    test('the conversation lane carries the same step as a Part', () {
      final frame =
          ServerEvent.fromJson(read('stream-conversation'), host: onMac)! as ConversationFrame;

      expect(frame.paneId, 'p-1');
      expect(frame.agentType, 'claude');

      // `stream-notification` carries this same step as a hook entry. A client reads one
      // lane or the other, never both, or it draws every step twice.
      final update = frame.update as PartUpdate;
      expect(update.turnId, 't-9f2a1c');
      final part = update.part as ToolCallPart;
      expect(part.toolName, 'Bash');
      expect(part.status, 'completed');
      expect(part.files.single.deletions, 34);
      // Absent stays absent: nothing was added, and `+0` would be a different claim.
      expect(part.files.single.additions, isNull);
    });

    test('streaming prose arrives as the characters it added, not as the part again', () {
      final frame =
          ServerEvent.fromJson(read('stream-conversation-text'), host: onMac)! as ConversationFrame;

      final update = frame.update as TextDelta;
      expect(update.turnId, 't-9f2a1c');
      expect(update.partId, 't-9f2a1c-text');
      // The chunk alone. A frame carrying the text *so far* would be the shape this kind
      // exists to replace — 46 copies of a growing prefix over a tailnet, per reply.
      expect(update.delta, ' shim now.');
      expect(update.delta, isNot(contains('Removing')));
    });

    test('a conversation delta carries the cursor a reconnect sends back', () {
      final frame =
          ServerEvent.fromJson(read('stream-conversation'), host: onMac)! as ConversationFrame;
      // Without this the app cannot resume; it refetches, which is the behaviour it had.
      expect(frame.cursor, greaterThan(0));
    });

    test('a gap the host cannot replay is named, not hidden', () {
      final frame = ServerEvent.fromJson(read('stream-conversation-truncated'), host: onMac)!
          as ConversationTruncatedFrame;

      expect(frame.paneId, 'p-2');
      expect(frame.requestedFromCursor, 1);
      // The host held nothing that far back — one REST fetch repairs it.
      expect(frame.oldestCursor, greaterThan(frame.requestedFromCursor));
    });

    test('notification arrives in snake_case, because the hook wrote it', () {
      final note = ServerEvent.fromJson(read('stream-notification'), host: onMac)! as NotificationEvent;

      expect(note.hook.paneId, 'p-1');
      expect(note.hook.kind, 'agent_stop');
      expect(note.hook.toolTarget, 'rm src/legacy/shim.ts');
      expect(note.hook.status, 'needs-input');

      // Everything one Chat line needs, from one frame. `LiveTranscript` rebuilds the
      // transcript from these as the agent works, so a field dropped here is a part of
      // Chat that silently waits for an HTTP refetch instead.
      expect(note.hook.userPrompt, 'clean up the legacy files');
      expect(note.hook.linesAdded, 0);
      expect(note.hook.linesRemoved, 34);

      // And it converts to the shape Chat actually reads, so the socket and the REST
      // read cannot drift into two different notions of an entry.
      final entry = note.hook.toTranscriptEntry();
      expect(entry.event, 'tool-pre', reason: 'the hook event, not the wrapper kind');
      expect(entry.toolTarget, 'rm src/legacy/shim.ts');
      expect(entry.userPrompt, 'clean up the legacy files');
      expect(entry.hasDiffStat, isTrue);
    });

    // ADR-10's compatibility rule, as a test: a host newer than this app will send
    // frames we have never heard of, and the app must skip them rather than throw.
    test('an unknown event type is skipped, not thrown', () {
      expect(ServerEvent.fromJson({'type': 'quantum.entangled', 'x': 1}, host: onMac), isNull);
      expect(ServerEvent.fromJson({'no type at all': true}, host: onMac), isNull);
    });

    test('an unknown field on a known event is ignored', () {
      final json = read('stream-hello')..['somethingFromTheFuture'] = 42;

      expect(ServerEvent.fromJson(json, host: onMac), isA<HelloEvent>());
    });
  });

  group('REST payloads', () {
    test('pair returns a credential plus who the host is', () {
      // `baseUri` is supplied by the caller, not the payload: the reply cannot name an
      // address the phone had to already know in order to receive it (ADR-13 no. 2's
      // pattern, the same one `Cell.fromJson` uses for `host`).
      final paired = PairedDevice.fromJson(
        read('rest-pair'),
        baseUri: Uri.parse('http://mac.tail-scale.ts.net:9877'),
      );

      expect(paired.deviceToken, isNotEmpty);
      expect(paired.hostId, onMac);
      expect(paired.expiresAt.isBefore(paired.hardExpiresAt), isTrue);
      expect(paired.caps.supports('stt'), isTrue);
    });

    test('the accounts a runner may be started as, and which one a cell is on', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));

      final claude = boot.runners.singleWhere((r) => r.id == 'claude');
      expect(claude.profiles.map((p) => p.id), ['default', 'initech']);

      // Codex has its own login, so its row carries none — offering Claude's accounts there
      // would send a spawn a name that runner never heard of.
      expect(boot.runners.singleWhere((r) => r.id == 'codex').profiles, isEmpty);

      // And the cell says which one it is working as. Nothing else answers that.
      expect(boot.cells.firstWhere((c) => c.paneId == 'p-1').profileId, 'initech');
      expect(boot.cells.firstWhere((c) => c.paneId == 'p-2').profileId, isNull);
    });

    test('a plan window arrives in the runner own words, and silence stays silence', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));

      final quiet = boot.cells.firstWhere((c) => c.paneId == 'p-1');
      // Absent means *this runner does not say* — not that the plan is fine.
      expect(quiet.usage, isNull);

      final warned = boot.cells.firstWhere((c) => c.paneId == 'p-2');
      expect(warned.usage!.status, 'allowed_warning');
      expect(warned.usage!.window, 'five_hour');
      expect(warned.usage!.isHealthy, isFalse);
      // Sent as epoch seconds, not milliseconds.
      expect(warned.usage!.resetsAt, DateTime.fromMillisecondsSinceEpoch(1788763800 * 1000));
    });

    test('bootstrap is one round-trip for a cold start', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));

      expect(boot.cells, hasLength(2));
      expect(boot.workspaces.single.workspaceId, 'ws-lotus');
      expect(boot.activeTasks, isEmpty);
      expect(boot.hostLabel, 'MacBook');
    });

    test('a host that names no headless runner offers none', () {
      // `rest-bootstrap` is the host without a structured path. Absent `headless` must read
      // as false — the phone must never infer it from the runner's name, which is what it
      // used to do while Codex was the only bridge.
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));

      expect(boot.caps.supports('structured-spawn'), isFalse);
      expect(boot.runners.every((r) => r.headless), isFalse);
      expect(boot.runners.any((r) => r.headless), isFalse);
    });

    test('a host that can run without a terminal says which runners it reaches', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap-headless'));

      expect(boot.caps.supports('structured-spawn'), isTrue);
      expect(
        {for (final r in boot.runners) r.id: r.headless},
        {'claude': false, 'codex': true, 'cursor': true},
      );
      // `cursor` reaches this host only as a bridge: it has no terminal runner behind it, so
      // the sheet must offer it as Chat and never as a terminal it cannot be given. Every
      // runner that does have one says nothing, and absence reads as yes.
      expect(
        {for (final r in boot.runners) r.id: r.terminal},
        {'claude': true, 'codex': true, 'cursor': false},
      );
      // And which of them have a Chat page **in** a terminal: codex's steps only reach Lotus
      // over its bridge, so the sheet rests it there instead of on a cell whose Chat is a
      // dead end.
      expect(
        {for (final r in boot.runners) r.id: r.chatInTerminal},
        {'claude': true, 'codex': false, 'cursor': false},
      );
    });

    test('bootstrap names a project that has no cell at all', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));

      // `ws-terax` appears in `projects` and in neither `cells` nor `workspaces`.
      // That row is the entire reason the field exists: without it the phone can
      // only ever reach a project that is already running something (ADR-14).
      expect(boot.projects.map((p) => p.name), ['Lotus', 'terax-ai']);

      final dormant = boot.projects.last;
      expect(dormant.project.workspaceId, 'ws-terax');
      expect(dormant.project.host, boot.hostId);
      expect(dormant.path, '/Users/op/code/terax-ai');
      expect(boot.cells.any((c) => c.project == dormant.project), isFalse);
    });

    test('a host with no projects key is a version difference, not a failure', () {
      final payload = Map<String, Object?>.from(read('rest-bootstrap'))
        ..remove('projects');

      expect(Bootstrap.fromJson(payload).projects, isEmpty);
    });

    test('bootstrap carries what a phone may tune on each native runner', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));
      expect(boot.caps.supports('spawn-tuning'), isTrue);

      // Alias tier, terbaru dulu — CLI-lah yang menerjemahkannya ke model terkini, jadi
      // daftar ini tidak menua di antara rilis (`claude-models.ts`).
      final claude = boot.runners.singleWhere((r) => r.id == 'claude');
      expect(claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
      expect(claude.defaultModel?.id, 'sonnet');
      expect(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);

      // The scales differ, which is the whole reason they ride per runner.
      final codex = boot.runners.singleWhere((r) => r.id == 'codex');
      expect(codex.efforts.first, 'minimal');
      expect(codex.efforts, isNot(equals(claude.efforts)));
      // The host strips the prefix every row would share; the id is what is sent.
      expect(codex.defaultModel?.id, 'gpt-5.4-codex');
      expect(codex.defaultModel?.label, '5.4-codex');

      // `custom` alone decides nothing — the three custom rows in the fixture give three
      // different answers, which is the whole reason `pinsTuning` rides on the wire.
      //
      // A second-account Claude wrapper that fixes nothing carries the same picker the
      // native runner does: the machine appends `--model` for it.
      final hss = boot.runners.singleWhere((r) => r.id == 'custom-hss');
      expect(hss.tunable, isTrue);
      expect(hss.models.map((m) => m.id), claude.models.map((m) => m.id));
      expect(hss.defaultModel?.id, 'sonnet');

      // A command that already names a model keeps its own: the phone's flag would be
      // appended after the operator's and fight it.
      final acme = boot.runners.singleWhere((r) => r.id == 'custom-acme');
      expect(acme.tunable, isFalse);
      expect(acme.gates, isTrue, reason: 'gating is a separate fact from tuning');

      // And a command Lotus knows nothing about still claims nothing.
      final opencode = boot.runners.singleWhere((r) => r.id == 'custom-opencode');
      expect(opencode.tunable, isFalse);

      // Skala izin naik lewat jalur yang sama, dan berbeda per runner untuk alasan yang
      // lebih keras daripada model: `claude` punya `--permission-mode`, `codex` sama sekali
      // tidak — ia punya sandbox dan approval policy. Skala yang dikarang aplikasi ini akan
      // salah untuk salah satunya pada hari CLI mana pun bergerak.
      expect(claude.permissions.map((p) => p.id),
          ['plan', 'manual', 'acceptEdits', 'bypassPermissions']);
      expect(codex.permissions.map((p) => p.id), ['read-only', 'auto', 'full-access']);
      expect(hss.permissions.map((p) => p.id), claude.permissions.map((p) => p.id),
          reason: 'a second-account wrapper runs the same binary');

      // Runner yang mesinnya tidak bisa memegang sikapnya tidak menawarkan satu pun stop —
      // rem tanpa ujung lebih buruk daripada ruang kosong (ADR-14).
      expect(acme.permissions, isEmpty, reason: 'its command already pins one');
      expect(opencode.permissions, isEmpty, reason: 'Lotus does not know its flags');
    });

    /// Dua jalur Codex sudah berbeda sejak sebelum skala ini ada, dan wire-nya yang harus
    /// mengatakannya: HP tidak punya cara lain untuk tahu bahwa sesi tanpa terminal
    /// beristirahat di tempat lain — dan bahwa hanya sesi itu yang approval-nya sampai ke
    /// telepon.
    test('bootstrap says where Codex rests, separately for a cell with no terminal', () {
      final boot = Bootstrap.fromJson(read('rest-bootstrap'));
      final codex = boot.runners.singleWhere((r) => r.id == 'codex');

      expect(codex.permissions.singleWhere((p) => p.isDefault).id, 'full-access');
      expect(codex.permissions.singleWhere((p) => p.isDefaultHeadless).id, 'auto');

      // Dan setiap runner lain menjawab sama untuk kedua jalur, jadi tidak ada yang harus
      // dipelajari kecuali di tempat perbedaannya nyata.
      final claude = boot.runners.singleWhere((r) => r.id == 'claude');
      expect(claude.permissions.where((p) => p.isDefaultHeadless), isEmpty);
    });

    test('a host without spawn-tuning is a version difference, not a failure', () {
      final payload = Map<String, Object?>.from(read('rest-bootstrap'));
      final runners = (payload['runners']! as List<Object?>)
          .map((r) => Map<String, Object?>.from(r! as Map<String, Object?>)
            ..remove('models')
            ..remove('efforts')
            ..remove('permissions'))
          .toList();
      final caps = Map<String, Object?>.from(payload['hostCaps']! as Map<String, Object?>);
      caps['features'] = (caps['features']! as List<Object?>)
          .where((f) => f != 'spawn-tuning')
          .toList();
      payload
        ..['runners'] = runners
        ..['hostCaps'] = caps;

      final boot = Bootstrap.fromJson(payload);
      expect(boot.caps.supports('spawn-tuning'), isFalse);
      expect(boot.runners, hasLength(5), reason: 'the runners are still offered');
      expect(boot.runners.any((r) => r.tunable), isFalse, reason: 'just nothing to tune');
      // Termasuk skala izinnya: host yang tidak menyebut apa pun tidak sedang mengatakan
      // "pakai default" — ia sedang mengatakan *jangan tawarkan kontrolnya*, dan itu satu-
      // satunya bacaan yang tidak berakhir dengan HP menjanjikan rem yang tak tersambung.
      expect(boot.runners.every((r) => r.permissions.isEmpty), isTrue);
    });

    test("result is git's answer: tracked, deleted, untracked and binary, each honest", () {
      final result = CellResult.fromJson(read('rest-result'));

      expect(result.cwd, '/Users/op/code/lotus');
      expect(result.closing?.truncated, isTrue);
      final changes = result.changes!;
      expect(changes.files.map((f) => f.status), ['modified', 'deleted', 'untracked', 'modified']);
      // The binary: present, unmeasured, and not counted as zero in the totals.
      final binary = changes.files.last;
      expect(binary.path, 'assets/logo.png');
      expect(binary.measured, isFalse);
      expect(changes.added, 43);
      expect(changes.removed, 22);
    });

    test('a pane with no known directory is "not knowable", never "nothing changed"', () {
      final result = CellResult.fromJson(read('rest-result-no-cwd'));

      expect(result.knowsChanges, isFalse);
      expect(result.reason, 'no_cwd');
      expect(result.cwd, isNull);
    });

    test('a browse page carries the roots, and says when there is no way up', () {
      final page = BrowsePage.fromJson(read('rest-browse'));

      expect(page.roots.map((r) => r.name), ['lotus-workspaces', 'kerja']);
      expect(page.path, '/home/op/kerja');
      // Null at a root, which is the property the screen draws nothing for.
      expect(page.isAtRoot, isTrue);
      expect(page.entries.map((e) => e.name), ['tkt-backend', 'notes']);
      expect(page.entries.first.branch, 'feat/payments');
      // Not knowable here, never "no branch".
      expect(page.entries.last.branch, isNull);
      expect(page.entries.last.children, 4);
      // Said by the host, not guessed by the phone.
      expect(page.entries.last.isProject, isTrue);
      expect(page.takeable, isTrue);
      expect(page.whyNot, isNull);
    });

    test('a clone job says where it got to, and carries git\'s own words when it failed', () {
      final job = CloneJob.fromJson(read('rest-clone-job'));

      expect(job.taskId, 'clone_1');
      expect(job.name, 'tkt-worker');
      expect(job.path, '/home/op/lotus-workspaces/tkt-worker');
      expect(job.isDone, isTrue);
      expect(job.isRunning, isFalse);
      // Absent rather than empty: a clone that worked has nothing to say about why.
      expect(job.error, isNull);
    });

    test('a diff arrives whole, with the cap flag the host set', () {
      final diff = CellDiff.fromJson(read('rest-diff'));

      expect(diff.file, 'src/legacy/shim.ts');
      expect(diff.diff, startsWith('diff --git'));
      expect(diff.truncated, isFalse);
    });

    test('conversation is the same page as turns of typed parts, with capabilities beside', () {
      final page = ConversationPage.fromJson(read('rest-conversation'));

      expect(page.hostSupports, isTrue, reason: 'absent field means supported');
      expect(page.runner, 'claude');
      expect(page.capabilities.of('text'), CapLevel.expected);
      expect(page.capabilities.of('toolStatus'), CapLevel.partial);
      expect(page.capabilities.of('reasoning'), CapLevel.never);
      expect(page.turns, hasLength(1));

      final turn = page.turns.single;
      expect(turn.isOpen, isFalse);
      expect(turn.stopReason, 'end_turn');
      expect(turn.parts.map((p) => p.runtimeType), [
        UserMessagePart, ToolCallPart, ToolCallPart, AssistantTextPart,
      ]);

      // The host paired call and result: one part, with the diff on it — and absent
      // counts on the Read stay absent, the same rule as the transcript entry.
      final edit = turn.parts[1] as ToolCallPart;
      expect((edit.kind, edit.status), ('edit', 'completed'));
      expect((edit.additions, edit.deletions), (0, 34));
      final read_ = turn.parts[2] as ToolCallPart;
      expect(read_.hasDiff, isFalse);
      expect(read_.additions, isNull);
      expect(read_.isOpen, isTrue, reason: 'no result arrived in this page');

      final reply = turn.parts[3] as AssistantTextPart;
      expect(reply.truncated, isTrue);
      expect(turn.parts.every((p) => p.provenance == Provenance.hook), isTrue);
    });

    test('conversation on a desktop without the transcript read is never, not empty', () {
      final page = ConversationPage.fromJson(read('rest-conversation-unsupported'));

      expect(page.hostSupports, isFalse);
      expect(page.turns, isEmpty);
      expect(page.capabilities.reportsAnything, isFalse);
    });

    test('a native conversation — codex app-server, no terminal — parses with its richer parts', () {
      final page = ConversationPage.fromJson(read('rest-conversation-native'));

      expect(page.runner, 'codex');
      expect(page.capabilities.of('streaming'), CapLevel.expected);
      expect(page.capabilities.of('permission'), CapLevel.expected);
      final turn = page.turns.single;
      expect(turn.parts.every((p) => p.provenance == Provenance.native), isTrue);
      expect(turn.parts.map((p) => p.runtimeType), [
        UserMessagePart, AssistantTextPart, ToolCallPart, AssistantTextPart, UnknownPart,
      ]);
      final exec = turn.parts[2] as ToolCallPart;
      expect((exec.toolName, exec.kind, exec.status), ('exec', 'execute', 'completed'));
      expect(exec.title, 'mkdir -p /tmp/lotus-probe-x && echo made');
      expect(exec.hasDiff, isFalse, reason: 'a command changes no counted lines');
      // `result` has no class yet — kept as unknown, named, never dropped.
      expect((turn.parts.last as UnknownPart).rawType, 'result');
    });

    test('a part type this app has never seen is kept as unknown, not dropped', () {
      final part = Part.fromJson({
        'id': 'x', 'ts': 1785664800000, 'seq': 0, 'provenance': 'native',
        'type': 'plan_update', 'entries': <Object?>[],
      });
      expect(part, isA<UnknownPart>());
      expect((part as UnknownPart).rawType, 'plan_update');
      expect(part.provenance, Provenance.native);
    });

    test('transcript keeps a diff stat absent rather than zero', () {
      final snapshot = TranscriptSnapshot.fromJson(read('rest-transcript'));

      expect(snapshot.hostSupports, isTrue, reason: 'absent field means supported');
      expect(snapshot.entries, hasLength(3));

      final edit = snapshot.entries[0];
      expect(edit.linesAdded, 0);
      expect(edit.linesRemoved, 34);
      expect(edit.hasDiffStat, isTrue);

      // A Read changed nothing, and "+0 −0" would be a different claim.
      final read_ = snapshot.entries[1];
      expect(read_.linesAdded, isNull);
      expect(read_.hasDiffStat, isFalse);

      // The turn's own words, and this one was cut at the host's 8000-byte cap.
      // Truncation is hard — no ellipsis, because the cap is applied twice and has to
      // stay idempotent — so this flag is the only thing separating a clipped reply
      // from a finished one. A model that ignored it would render a sentence stopping
      // mid-word as though the agent stopped there.
      final stop = snapshot.entries[2];
      expect(stop.event, 'stop');
      expect(stop.bodyTruncated, isTrue);
      expect(stop.body.endsWith('The last one'), isTrue, reason: 'cut hard, no ellipsis');

      // And the ordinary entries do not claim it.
      expect(edit.bodyTruncated, isFalse);
      expect(read_.bodyTruncated, isFalse);
    });

    test('a host with no hook pipeline says so instead of looking empty', () {
      final snapshot = TranscriptSnapshot.fromJson(read('rest-transcript-unsupported'));

      expect(snapshot.hostSupports, isFalse);
      expect(snapshot.entries, isEmpty);
    });

    test('a runner that cannot report says so, and does not blame the host', () {
      final snapshot = TranscriptSnapshot.fromJson(read('rest-transcript-runner-silent'));

      expect(snapshot.runnerReports, isFalse);
      expect(snapshot.entries, isEmpty);
      // The host is fine. Conflating the two would send the operator to a healthy
      // desktop looking for a fault that is not there.
      expect(snapshot.hostSupports, isTrue);
    });

    test('a host that cannot place the pane says unknown, not silence', () {
      // Silence on this wire means "a transcript is coming". The desktop's pane→runner
      // map is pushed by its own UI, so it is empty after every restart — and answering
      // that with silence is how Chat came to wait on panes nobody would ever fill.
      final snapshot = TranscriptSnapshot.fromJson(read('rest-transcript-outlook-unknown'));

      expect(snapshot.outlook, TranscriptOutlook.unknown);
      expect(snapshot.entries, isEmpty);
      // Neither blames the machine: the pipeline is fine, the runner is unjudged.
      expect(snapshot.hostSupports, isTrue);
      expect(snapshot.isEmptyButKnowable, isFalse);
    });

    test('a host sending only the old boolean is still read correctly', () {
      // The compatibility direction that matters in practice: a desktop that predates
      // `transcriptOutlook` must not start reading as `unknown`.
      final never = TranscriptSnapshot.fromJson(
        {'paneId': 'p-1', 'total': 0, 'entries': <Object?>[], 'runnerReports': false},
      );
      final expected = TranscriptSnapshot.fromJson(
        {'paneId': 'p-1', 'total': 0, 'entries': <Object?>[]},
      );

      expect(never.outlook, TranscriptOutlook.never);
      expect(expected.outlook, TranscriptOutlook.expected);
    });

    test('permission options keep their printed digits and their own words', () {
      final snapshot = PermissionSnapshot.fromJson(read('rest-permission'));

      expect(snapshot.awaiting, isTrue);
      expect(snapshot.readback, isNotNull);
      final prompt = snapshot.prompt!;
      expect(prompt.options.map((o) => o.key).toList(), ['1', '2', '3']);
      expect(prompt.options[0].selected, isTrue);
      // Verbatim: the mockup once invented a label the real prompt never uses.
      expect(prompt.options[2].label, 'No');
    });

    /// A headless cell's question used to arrive as a permission with a flag, which had
    /// nowhere to keep the sentence under each option — "Spaces", and nothing to say what
    /// choosing it means.
    test('a question arrives whole, with the digits that answer it', () {
      final snapshot = PermissionSnapshot.fromJson(read('rest-permission-question'));

      expect(snapshot.awaiting, isTrue);
      final asked = snapshot.question!.single;
      expect(asked.question, 'Tabs or spaces?');
      expect(asked.header, 'Indentation');
      expect(asked.options.map((o) => o.key).toList(), ['1', '2']);
      expect(asked.options[0].description, 'Indent with spaces.');
      // And the old shape rides along, so the digits are the same either way.
      expect(snapshot.prompt?.isQuestion, isTrue);
      expect(snapshot.prompt?.options.map((o) => o.key).toList(), ['1', '2']);
    });

    test('a scraped terminal prompt carries no ask, and that means permission', () {
      // Absent-means-permission is the rule a client has to keep parsing: this fixture is a
      // prompt read off a terminal, where nothing can tell a question from a request to act.
      final snapshot = PermissionSnapshot.fromJson(read('rest-permission'));

      expect(snapshot.prompt?.ask, isNull);
      expect(snapshot.prompt?.isQuestion, isFalse);
    });

    test('awaiting with no prompt is a pointer to the terminal, not an empty state', () {
      final snapshot = PermissionSnapshot.fromJson(read('rest-permission-unsupported'));

      expect(snapshot.hostSupports, isFalse);
      expect(snapshot.prompt, isNull);
      expect(snapshot.answerable, isFalse);
    });

    test('dictation returns text and which provider produced it', () {
      final result = Transcription.fromJson(read('rest-stt'));

      expect(result.text, isNotEmpty);
      expect(result.provider, 'openai');
      expect(result.transcribedHere, isTrue);
    });

    test('a device-only host forks to the phone recognizer instead of failing', () {
      final result = Transcription.fromJson(read('rest-stt-unsupported'));

      expect(result.text, isNull);
      expect(result.hostSupports, isFalse);
      expect(result.transcribedHere, isFalse);
    });

    test('a refreshed credential replaces the token and its expiry', () {
      final refreshed = RefreshedToken.fromJson(read('rest-devices-refresh'));

      expect(refreshed.deviceToken, isNotEmpty);
      expect(refreshed.expiresAt.year, greaterThan(2020));
    });

    test('a renewal challenge carries the nonce to sign', () {
      expect(read('rest-devices-renew-challenge')['nonce'], isA<String>());
    });

    test('a renewal restarts both clocks', () {
      final renewed = RenewedToken.fromJson(read('rest-devices-renew'));

      expect(renewed.deviceToken, isNotEmpty);
      expect(renewed.hardExpiresAt.isAfter(renewed.expiresAt), isTrue);
    });
  });

  /// The pairing QR, whose producer is `apps/desktop`, not `packages/host`.
  ///
  /// The only fixture in this directory with a third participant, and the reason it is
  /// here rather than in either app: the format is written by hand twice — once in
  /// `src/lib/pairing-invite.ts` and once in `models/pairing_invite.dart` — which is
  /// precisely the shape that drifts. Neither implementation is the authority. This
  /// file is.
  group('pairing invite', () {
    test('what the desktop builds is what this app reads', () {
      final fixture = read('pairing-invite');
      final reading = readInvite(fixture['uri']! as String);

      expect(reading, isA<InviteReadable>(),
          reason: 'the desktop publishes this exact string — see its own test on the '
              'same fixture');
      final invite = (reading as InviteReadable).invite;
      expect(invite.address, fixture['address']);
      expect(invite.code, fixture['code']);
    });

    test('the address in the payload is the one the desktop shows on screen', () {
      // `Listening on {host}:{port}` and the QR must not be able to disagree, because
      // the operator checks one and the phone dials the other.
      final fixture = read('pairing-invite');
      expect(fixture['address'], '${fixture['host']}:${fixture['port']}');
    });
  });

  /// The mirror of the host's own guard. There, a new `ServerEvent` variant cannot
  /// ship without a fixture; here, a new fixture cannot ship without a parser —
  /// which is the failure the host side cannot see.
  test('every fixture on disk is claimed by a test above', () {
    final onDisk = fixtures
        .listSync()
        .whereType<File>()
        .map((f) => f.uri.pathSegments.last.replaceAll('.json', ''))
        .toSet();

    const parsed = {
      'stream-hello',
      'stream-hello-standalone',
      'stream-hello-standalone-hooked',
      'stream-fleet-changed',
      'stream-cell-output',
      'stream-cell-truncated',
      'stream-notification',
      'stream-conversation',
      'stream-conversation-text',
      'stream-conversation-truncated',
      'rest-pair',
      'rest-bootstrap',
      'rest-bootstrap-headless',
      'rest-transcript',
      'rest-conversation',
      'rest-conversation-unsupported',
      'rest-conversation-native',
      'rest-result',
      'rest-result-no-cwd',
      'rest-browse',
      'rest-clone-job',
      'rest-diff',
      'rest-transcript-unsupported',
      'rest-transcript-runner-silent',
      'rest-transcript-outlook-unknown',
      'rest-permission',
      'rest-permission-question',
      'rest-permission-unsupported',
      'rest-stt',
      'rest-stt-unsupported',
      'rest-devices-refresh',
      'rest-devices-renew-challenge',
      'rest-devices-renew',
      'pairing-invite',
    };

    // Host ↔ desktop shapes (`/v1/*`): the phone never reads them, so nothing here parses them.
    const notForPhone = {'usage-snapshot'};

    expect(onDisk.difference(parsed).difference(notForPhone), isEmpty, reason: 'a fixture nothing here parses');
    expect(parsed.difference(onDisk), isEmpty, reason: 'a parser for a fixture that is gone');
  });
}
