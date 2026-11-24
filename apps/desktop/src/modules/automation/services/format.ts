/**
 * How schedules, times and durations read in the Automations surface.
 *
 * `describeCron` follows bb's `formatCronCadence` (plugins/automations/lib/format-schedule.ts):
 * "0 17 * * 1-5" reads "5PM Mon-Fri". Only the shapes Lotus writes itself are described — a
 * daily time on chosen weekdays, or a fixed interval. Anything else says "Custom schedule"
 * rather than guessing, and the raw pattern stays visible where the schedule is shown in full.
 */

/** Cron day numbers in the order people read a week: Mon first, Sun last. */
const WEEK: { n: number; key: string; label: string }[] = [
  { n: 1, key: "mon", label: "Mon" },
  { n: 2, key: "tue", label: "Tue" },
  { n: 3, key: "wed", label: "Wed" },
  { n: 4, key: "thu", label: "Thu" },
  { n: 5, key: "fri", label: "Fri" },
  { n: 6, key: "sat", label: "Sat" },
  { n: 0, key: "sun", label: "Sun" },
];

const CUSTOM = "Custom schedule";

function whole(text: string, max: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/** "1-5", "1,3,5", "*" → the day numbers, or null when it is not a plain day list. */
function readDays(field: string): number[] | null {
  if (field === "*") return WEEK.map((d) => d.n);
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to || to > 7) return null;
      for (let d = from; d <= to; d += 1) days.add(d % 7);
      continue;
    }
    const day = whole(part, 7);
    if (day === null) return null;
    days.add(day % 7);
  }
  return days.size ? [...days] : null;
}

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${h}${suffix}` : `${h}:${String(minute).padStart(2, "0")}${suffix}`;
}

/** Consecutive days collapse into a range: Mon, Tue, Wed, Fri → "Mon-Wed, Fri". */
function dayList(days: number[]): string {
  const chosen = WEEK.filter((d) => days.includes(d.n));
  if (chosen.length === 7) return "daily";
  const runs: (typeof WEEK)[] = [];
  for (const day of chosen) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && WEEK.indexOf(day) === WEEK.indexOf(prev) + 1) last.push(day);
    else runs.push([day]);
  }
  return runs
    .flatMap((run) => (run.length >= 3 ? [`${run[0].label}-${run[run.length - 1].label}`] : run.map((d) => d.label)))
    .join(", ");
}

export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return CUSTOM;
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*") return CUSTOM;

  const everyMin = minute.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && dow === "*") return `Every ${everyMin[1]} min`;
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (minute === "0" && everyHour && dow === "*") return `Every ${everyHour[1]} hours`;

  const [m, h, days] = [whole(minute, 59), whole(hour, 23), readDays(dow)];
  if (m === null || h === null || !days) return CUSTOM;
  return `${clock(h, m)} ${dayList(days)}`;
}

/**
 * A cron Lotus's own form wrote ("M H * * days") back into the form's days and time, so editing
 * opens on the fields it was made with. Null for anything the form cannot show.
 */
export function splitSimpleCron(cron: string): { days: string[]; time: string } | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") return null;
  const [m, h, days] = [whole(fields[0], 59), whole(fields[1], 23), readDays(fields[4])];
  if (m === null || h === null || !days) return null;
  return {
    days: WEEK.filter((d) => days.includes(d.n)).map((d) => d.key),
    time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  };
}

const WHEN = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Sep 26, 9:00 AM", the way bb prints run and next-run times. */
export function formatWhen(ms: number): string {
  return WHEN.format(new Date(ms));
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** For a narrow list row: the time when it is from today, else the day. */
export function formatShortWhen(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  return at.toDateString() === new Date(now).toDateString() ? CLOCK.format(at) : DAY.format(at);
}

export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(s % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
