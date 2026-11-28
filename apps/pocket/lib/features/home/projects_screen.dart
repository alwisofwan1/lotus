import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../data/fleet_store.dart';
import '../../models/cell.dart';
import '../../models/host_id.dart';
import '../shared/refreshable.dart';
import '../shared/state_shapes.dart';
import 'add_project.dart';
import 'project_presentation.dart';
import 'project_search.dart';
import 'widgets/add_project_row.dart';
import 'widgets/add_project_sheet.dart';
import 'widgets/diagnostics_row.dart';
import 'widgets/needs_you.dart';
import 'widgets/nothing_yet.dart';
import 'widgets/project_search_field.dart';
import 'widgets/project_row.dart';

/// The root: every project this phone can reach, and what needs the operator.
///
/// **This is ADR-3's own falsification clause being triggered, not overruled.** Its second
/// revision made Home per-project and closed with the condition under which that would be
/// wrong: *"kalau operator rutin punya `awaiting` di tiga proyek sekaligus, satu baris
/// `elsewhere` tidak cukup dan ia harus jadi daftar."* Eight projects is that operator.
///
/// What the revision protected must survive the change, and it is not the shape of the list —
/// it is the property: **an agent that needs the operator can never sit behind a tap.** So the
/// index is two blocks, not one. The first names *agents* and only exists while something
/// waits; the second is the project index. When nothing waits there is no first block, and the
/// screen is the calm index the mockup drew.
///
/// The strap says so out loud, which is why `Nobody needs you` is a statement of fact here
/// rather than a joke: it is printed exactly when the block above it is absent.
class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({
    required this.fleet,
    required this.hostLabel,
    required this.onOpenProject,
    required this.onOpenAgent,
    required this.onOpenDiagnostics,
    required this.onRefresh,
    this.addTargets = const [],
    this.onAddProject,
    this.loadAsk,
    this.onAnswer,
    super.key,
  }) : assert(
          addTargets.length == 0 || onAddProject != null,
          'a machine that will take a project needs somewhere for the choice to go',
        );

  final FleetStore fleet;

  /// Resolves a host's operator-facing name, empty where it distinguishes nothing. The same
  /// function three other screens take, so this one cannot become the copy that disagrees.
  final String Function(HostId host) hostLabel;

  final void Function(ProjectRef project) onOpenProject;

  /// Opens one agent directly, from the block above the index. That shortcut is the whole
  /// reason a second level is affordable at all.
  final void Function(Cell cell) onOpenAgent;

  /// The screen that says whether a silent fleet is unpaired, unreachable, or quiet.
  /// Reachable from the foot of the index and from the empty state, which between them are
  /// where the switcher sheet used to carry it (`DiagnosticsRow`).
  final VoidCallback onOpenDiagnostics;
  final Future<void> Function() onRefresh;

  /// The paired hosts that will take a new project, and what each of them offers.
  ///
  /// Empty is the ordinary case for a machine that predates this feature, and it means the
  /// door is **absent** rather than disabled — the rule `hostCaps` has always carried here
  /// (`paired_host.dart`). See `plans/pocket-vps-project-checkout/issues/03`.
  final List<AddProjectTarget> addTargets;

  /// Where a chosen way in goes. Null only when [addTargets] is empty.
  final void Function(AddProjectChoice choice)? onAddProject;

  /// What a waiting agent asks, and how to answer it from Home. Null opens Chat instead.
  final LoadAsk? loadAsk;
  final AnswerAsk? onAnswer;

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  /// Apa yang diketik operator di dock. Kosong berarti seluruh indeks.
  ///
  /// State layar, bukan state field: yang disaring adalah daftar di atasnya, jadi teksnya
  /// harus hidup di tempat yang bisa melihat keduanya.
  String _query = '';

  FleetStore get fleet => widget.fleet;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: fleet,
          builder: (context, _) => _body(context),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final t = context.tokens;
    final projects = fleet.projects;
    // Satu keputusan yang tidak bisa diambil per baris: sebuah baris butuh path-nya ketika
    // baris lain punya nama **dan** mesin yang sama. Dua `pocket` di satu laptop akan
    // terbaca identik tanpa ini (`ProjectPresentation.disambiguate`).
    final rows = ProjectPresentation.disambiguate(
      projects.map(_present).toList(growable: false),
    );
    // Disaring **sesudah** disambiguasi, bukan sebelum: kalau query yang memutuskan siapa
    // bertabrakan dengan siapa, path sebuah baris akan muncul dan hilang tergantung apa yang
    // diketik — padahal identitas sebuah project bukan fungsi dari pencarian.
    final shown = matchProjects(rows, _query);
    // Urutan `FleetStore` sudah menunggu-dulu (ADR-12 no. 1), jadi menyaringnya di sini
    // memberi urutan mendesak-dulu tanpa mengurutkan apa pun untuk kedua kalinya.
    final waiting = fleet.cells
        .where((c) => c.needsInput)
        .toList(growable: false);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 26, 20, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Projects',
                style: t.serif.copyWith(
                  fontSize: 34,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.8,
                  color: t.text,
                ),
              ),
              const SizedBox(height: 7),
              Row(
                children: [
                  Flexible(
                    child: Text(
                      // Tentang fleet-nya, bukan tentang daftar yang tersaring: ia menjawab
                      // "apakah ada yang butuh saya", dan jawaban itu tidak berubah karena
                      // operator mengetik sesuatu.
                      _strap(waiting.length, projects.length),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: t.mono.copyWith(
                        fontSize: 10.5,
                        letterSpacing: 0.14 * 10.5,
                        color: t.faint,
                      ),
                    ),
                  ),
                  // Hanya ketika ada mesin yang diam. Barisnya sudah mengatakan
                  // `· unreachable`, dan sampai 2026-08-12 satu-satunya cara bertindak
                  // atasnya adalah tarikan yang tidak terlihat — temuan §9 no. 7. Aturan
                  // yang dilanggarnya sudah tertulis di `chat_body.dart`.
                ],
              ),
            ],
          ),
        ),
        // **Tidak pernah disaring.** Sebuah field pencarian adalah pengalih paling halus
        // yang bisa dibangun — ia menyembunyikan dengan diam — dan properti yang mengikat
        // sejak ADR-3 revisi pertama adalah bahwa `awaiting` tidak boleh bisa tersembunyi
        // di balik pengalih. Menyaring blok ini akan melanggarnya dengan mekanisme baru.
        if (fleet.staleHosts.isNotEmpty) _notAnswering(),
        if (waiting.isNotEmpty)
          NeedsYou(
            waiting: waiting,
            onOpen: widget.onOpenAgent,
            where: _where,
            loadAsk: widget.loadAsk,
            onAnswer: widget.onAnswer,
          ),
        if (projects.isEmpty)
          Expanded(
            child: Refreshable.fill(
              onRefresh: widget.onRefresh,
              child: NothingYet(
                onOpenDiagnostics: widget.onOpenDiagnostics,
                onAddProject:
                    _choices().isEmpty ? null : () => _addProject(context),
              ),
            ),
          )
        else if (shown.isEmpty)
          // Project-nya ada, cuma tidak ada yang cocok. `Nothing here yet.` akan menjadi
          // kebohongan di sini, dan layar kosong tanpa kalimat terbaca sebagai app yang
          // kehilangan datanya.
          Expanded(child: _noMatch(t))
        else
          Expanded(
            child: Refreshable(
              onRefresh: widget.onRefresh,
              child: ListView.builder(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.only(top: 20),
                itemCount: shown.length,
                itemBuilder: (context, i) => ProjectRow(
                  project: shown[i],
                  onOpen: () => widget.onOpenProject(shown[i].project),
                ),
              ),
            ),
          ),
        // Satu jalan, bukan dua: keadaan kosong sudah membawa jalannya sendiri, dan dua
        // pintu ke satu layar di satu layar hanya membuat keduanya lebih sulit dibaca.
        // Di luar daftar yang menggulir, jadi query maupun fleet panjang tidak bisa
        // mendorongnya keluar layar.
        if (projects.isNotEmpty) ...[
          if (_choices().isNotEmpty) AddProjectRow(onSelect: () => _addProject(context)),
          DiagnosticsRow(onSelect: widget.onOpenDiagnostics),
          ProjectSearchField(
            query: _query,
            onChanged: (q) => setState(() => _query = q),
          ),
        ],
      ],
    );
  }

  List<AddProjectChoice> _choices() =>
      addProjectChoices(widget.addTargets, widget.hostLabel);

  /// Membuka jalan masuk — atau melewatkan sheet-nya ketika hanya ada satu.
  ///
  /// Sebuah sheet yang menanyakan pertanyaan dengan satu jawaban bukan pertanyaan, dan
  /// ketukan tambahannya adalah persis biaya yang membuat `+` di sebelah dock ditolak
  /// pada 2026-08-11.
  void _addProject(BuildContext context) {
    final choices = _choices();
    if (choices.length == 1) {
      widget.onAddProject!(choices.first);
      return;
    }
    showAddProjectSheet(context, choices: choices, onChoose: widget.onAddProject!);
  }

  /// One capsule for every machine that stopped answering; its rows stay, marked.
  Widget _notAnswering() {
    final stale = fleet.staleHosts;
    final String words;
    if (stale.length == 1) {
      final label = widget.hostLabel(stale.single);
      final seen = fleet.lastHeardFrom(stale.single);
      words = '${label.isEmpty ? 'Your Mac' : label} is not answering${seen == null ? '' : ' · seen ${_clock(seen)}'}';
    } else {
      words = '${stale.length} machines are not answering';
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 0),
      child: StateCapsule(
        icon: Icons.cloud_off_outlined,
        words: words,
        action: (label: 'Try again', onTap: () => widget.onRefresh()),
      ),
    );
  }

  static String _clock(DateTime t) {
    final l = t.toLocal();
    return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
  }

  /// The query itself is the picture, so the operator sees what was read, not a guess.
  Widget _noMatch(AppTokens t) => OrbHero(
    picture: Text(
      '“$_query”',
      textAlign: TextAlign.center,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: t.mono.copyWith(fontSize: 20, color: t.muted),
    ),
    title: 'No project matches',
    secondary: (label: 'Clear search', onTap: () => setState(() => _query = '')),
  );

  ProjectPresentation _present(ProjectRef project) =>
      presentProject(fleet, project, hostLabel: widget.hostLabel(project.host));

  /// `NOBODY NEEDS YOU · 5 AGENTS LIVE`, atau `2 NEED YOU · …`.
  ///
  /// Dicetak sebagai keterangan dan bukan sebagai lelucon: paruh pertamanya adalah satu-satunya
  /// hal di layar ini yang mengatakan apakah blok di atas indeks ada.
  String _strap(int waiting, int projects) {
    final live = fleet.cells.length;
    final head = waiting == 0 ? 'Nobody needs you' : '$waiting need you';
    final tail = live == 1 ? '1 agent live' : '$live agents live';
    return '$head · $tail'.toUpperCase();
  }

  /// `CNVS`, atau `Lotus · vps` — mesinnya hanya ketika ia membedakan sesuatu.
  String _where(Cell cell) {
    final host = widget.hostLabel(cell.host);
    final name = _present(cell.project).label;
    return host.isEmpty ? name : '$name · $host';
  }
}
