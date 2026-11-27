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

/// Gate clone mutations, but not polling reads (ADR-8, ADR-12 no. 2).
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

  /// Treat failed or unreadable poll responses as no update so polling can continue.
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
