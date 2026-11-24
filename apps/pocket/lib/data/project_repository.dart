import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/transport.dart';
import '../hosts/biometric_gate.dart';
import '../hosts/credentials.dart';
import '../hosts/host_registry.dart';
import '../models/browse.dart';
import '../models/clone_job.dart';
import '../models/host_id.dart';
import 'host_gate.dart';
import 'mutation_outcome.dart';

/// What starting a clone answered: the outcome every screen already knows how to read,
/// and the job to come back to when there is one.
typedef CloneStart = ({MutationOutcome outcome, CloneJob? job});

/// Bringing a new project onto a machine.
///
/// Separate from `AgentRepository`, whose own doc says it is "everything the Agent page
/// reads and does, **for one cell at a time**" — a clone names no cell and belongs to no
/// page. What the two share is the part that must not be copied: [HostGate], where the
/// biometric gate (ADR-8) and the credential freshness check (ADR-12 no. 2) live.
///
/// Starting a clone passes that gate; polling it does not. A read that asked for a
/// fingerprint every second would be a gate nobody reads, and it can reveal nothing the
/// bearer does not already reach.
class ProjectRepository {
  const ProjectRepository({
    required this.registry,
    required this.credentials,
    required this.gate,
  });

  /// The same three seams `AgentRepository` names, so `app/` hands both the same
  /// collaborators and neither has a private way in.
  final HostRegistry registry;
  final Credentials credentials;
  final BiometricGate gate;

  HostGate get _hostGate =>
      HostGate(registry: registry, credentials: credentials, gate: gate);

  /// Starts a clone on [host].
  ///
  /// The reason string is what the operator reads inside the OS prompt, where nothing
  /// else says what they are approving — so it names the repository, not the act.
  Future<CloneStart> startClone(
    HostId host, {
    required String url,
    String? branch,
    String? name,
  }) async {
    CloneJob? job;
    final outcome = await _hostGate.run(host, 'Clone $url', (api) async {
      job = await api.cloneProject(url: url, branch: branch, name: name);
    });
    return (outcome: outcome, job: outcome.succeeded ? job : null);
  }

  /// Takes a folder already on [host]. Passes the gate, like every other mutation.
  ///
  /// The reason string names the folder rather than the act: inside the OS prompt nothing
  /// else says what is being approved.
  Future<MutationOutcome> takeFolder(HostId host, String path) =>
      _hostGate.run(host, 'Add $path', (api) => api.addProject(path));

  /// One level of a directory the host opens, or null when it can no longer be asked.
  ///
  /// A read, so no gate: asking for a fingerprint to open a folder is a gate nobody reads,
  /// and it can reveal nothing the bearer does not already reach.
  Future<BrowsePage?> browse(HostId host, String? path) async {
    final api = registry.apiFor(host);
    if (api == null) return null;
    return api.browse(path: path);
  }

  /// Where a clone got to, or null when this tick brought nothing usable.
  ///
  /// Null rather than a thrown failure because the screen above it is a poll: one
  /// unanswered tick on a phone that walked into a lift is not news, and the screen
  /// keeps showing the last step it knew.
  ///
  /// **A body this app cannot read counts as nothing too**, and that is not defensive
  /// padding — it was measured. A 200 whose shape is not a clone job (a proxy's error
  /// page, a host older than these routes) threw out of `CloneJob.fromJson` and took the
  /// whole screen down mid-poll. A poll that dies is worse than a poll that waits, and
  /// the thing that catches a genuine contract break is `test/contract/fixtures_test.dart`,
  /// not this.
  Future<CloneJob?> cloneStatus(HostId host, String taskId) async {
    final api = registry.apiFor(host);
    if (api == null) return null;
    try {
      return await api.cloneStatus(taskId);
    } on TransportUnavailable {
      return null;
    } on ApiFailure {
      return null;
    } on TypeError {
      return null;
    }
  }
}
