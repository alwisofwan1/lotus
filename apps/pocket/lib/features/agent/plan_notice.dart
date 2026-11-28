/// The host's plan-window line in plain words, or null when [text] is not one.
///
/// The host writes `seven_day plan limit: allowed_warning. Resets at 1795950000.` and leaves
/// the time as epoch seconds on purpose: only the phone knows its timezone
/// (`claude/messages.ts`, `rateLimitNotice`). Long-press still shows the raw line.
String? planNoticeWords(String text, {DateTime? now}) {
  final m = _line.firstMatch(text.trim());
  if (m == null) return null;
  final window = _windows[m[1]] ?? m[1]!.replaceAll('_', ' ');
  final head = switch (m[2]) {
    'allowed_warning' => 'Close to the $window limit',
    'rejected' => '${_cap(window)} limit reached',
    final s => '${_cap(window)} limit: ${s!.replaceAll('_', ' ')}',
  };
  final at = int.tryParse(m[3] ?? '');
  if (at == null) return head;
  final reset = DateTime.fromMillisecondsSinceEpoch(at * 1000).toLocal();
  return '$head · resets ${_when(reset, (now ?? DateTime.now()).toLocal())}';
}

final RegExp _line = RegExp(r'^(\w+) plan limit: (\w+)\.(?: Resets at (\d+)\.)?$');

const Map<String, String> _windows = {
  'five_hour': '5-hour',
  'seven_day': '7-day',
  'seven_day_opus': '7-day Opus',
  'seven_day_sonnet': '7-day Sonnet',
  'overage': 'extra usage',
};

const List<String> _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _cap(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

String _two(int n) => n.toString().padLeft(2, '0');

/// `14:00` today, `Sat 14:00` within a week, `12 Dec 14:00` beyond.
String _when(DateTime t, DateTime now) {
  final clock = '${_two(t.hour)}:${_two(t.minute)}';
  final days = DateTime(t.year, t.month, t.day).difference(DateTime(now.year, now.month, now.day)).inDays;
  if (days == 0) return 'at $clock';
  if (days > 0 && days < 7) return '${_days[t.weekday - 1]} $clock';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${t.day} ${months[t.month - 1]} $clock';
}
