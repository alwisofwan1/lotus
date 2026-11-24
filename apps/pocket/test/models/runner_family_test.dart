import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/models/runner_family.dart';

void main() {
  test('the claude family is claude, its profiles, and anything that says claude', () {
    for (final id in ['claude', 'ccs', 'csp', 'ccs:hss', 'CCS:work', 'Claude', ' claude-code ', 'my-claude']) {
      expect(RunnerFamily.of(id), RunnerFamily.claude, reason: id);
      expect(RunnerFamily.of(id).gatesBeforeActing, isTrue, reason: id);
    }
  });

  test('every other runner is itself, never gates, and an unknown one is other', () {
    expect(RunnerFamily.of('codex'), RunnerFamily.codex);
    expect(RunnerFamily.of('cursor'), RunnerFamily.cursor);
    expect(RunnerFamily.of('grok').gatesBeforeActing, isFalse);
    expect(RunnerFamily.of('acme'), RunnerFamily.other);
    expect(RunnerFamily.of(null), RunnerFamily.other);
  });

  test('a runner this app cannot name has no display name to invent', () {
    expect(RunnerFamily.of('claude').displayName, 'Claude Code');
    expect(RunnerFamily.of('custom-x').displayName, isNull);
  });
}
