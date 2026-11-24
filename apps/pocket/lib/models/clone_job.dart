/// A clone the host is running, or has finished running.
///
/// `state` and `step` stay **strings**, the same choice `Cell.status` and `Cell.turn`
/// already make. A host newer than this app can name a step this app has never heard of,
/// and an enum would have to either throw or silently call it something else — both of
/// which are worse than printing a word the operator can read.
class CloneJob {
  const CloneJob({
    required this.taskId,
    required this.state,
    required this.step,
    required this.name,
    required this.path,
    this.error,
  });

  final String taskId;

  /// `running`, `done` or `failed` — as the host said it.
  final String state;

  /// `resolving`, `cloning` or `registering`.
  final String step;

  /// The folder this becomes, which is also the project's name once it lands.
  final String name;

  /// Where on that machine. The one fact the operator cannot check anywhere else.
  final String path;

  /// git's own words, unchanged. Null while it is running and after it worked.
  final String? error;

  bool get isRunning => state == 'running';
  bool get isDone => state == 'done';
  bool get isFailed => state == 'failed';

  factory CloneJob.fromJson(Map<String, Object?> json) => CloneJob(
        taskId: json['taskId']! as String,
        state: json['state']! as String,
        step: json['step']! as String,
        name: json['name']! as String,
        path: json['path']! as String,
        error: json['error'] as String?,
      );
}
