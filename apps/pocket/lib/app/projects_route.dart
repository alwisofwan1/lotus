import 'package:flutter/material.dart';

import '../data/fleet_store.dart';
import '../features/home/add_project.dart';
import '../features/home/projects_screen.dart';
import '../features/home/widgets/needs_you.dart';
import '../hosts/host_registry.dart';
import '../models/cell.dart';
import '../models/host_id.dart';

/// The project index, wired to the two things that can change under it.
///
/// **A widget of its own so the wiring can be tested.** It was four lines inside
/// `PocketApp` until 2026-09-11, and those four lines held a bug no widget test could
/// reach: the list of machines that will take a project was computed once, when the route
/// was built, while `hostCaps` arrive on a `hello` frame seconds later. On a real phone the
/// door never appeared against a VPS that was advertising it — and Diagnostics, which
/// listens, printed the flag on the same screen.
///
/// So it listens to **both** sources: [FleetStore] for what is running, which
/// [ProjectsScreen] already watches, and [HostRegistry] for what each machine says it can
/// do. Everything else reactive on this screen hangs off the first; capabilities only ever
/// came from the second.
class ProjectsRoute extends StatelessWidget {
  const ProjectsRoute({
    required this.registry,
    required this.fleet,
    required this.hostLabel,
    required this.onOpenProject,
    required this.onOpenAgent,
    required this.onOpenDiagnostics,
    required this.onRefresh,
    required this.onAddProject,
    this.loadAsk,
    this.onAnswer,
    super.key,
  });

  final HostRegistry registry;
  final FleetStore fleet;
  final String Function(HostId host) hostLabel;
  final void Function(ProjectRef project) onOpenProject;
  final void Function(Cell cell) onOpenAgent;
  final VoidCallback onOpenDiagnostics;
  final Future<void> Function() onRefresh;
  final void Function(AddProjectChoice choice) onAddProject;
  final LoadAsk? loadAsk;
  final AnswerAsk? onAnswer;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: registry,
        builder: (context, _) => ProjectsScreen(
          fleet: fleet,
          hostLabel: hostLabel,
          onOpenProject: onOpenProject,
          onOpenAgent: onOpenAgent,
          onOpenDiagnostics: onOpenDiagnostics,
          onRefresh: onRefresh,
          // Only the machines that said they will take one. A host that predates the
          // feature offers nothing here and the door is absent, not disabled.
          addTargets: [
            for (final host in registry.hosts)
              if (host.canCloneProjects || host.canBrowseProjects)
                AddProjectTarget(
                  host: host.id,
                  canClone: host.canCloneProjects,
                  canBrowse: host.canBrowseProjects,
                ),
          ],
          onAddProject: onAddProject,
          loadAsk: loadAsk,
          onAnswer: onAnswer,
        ),
      );
}
