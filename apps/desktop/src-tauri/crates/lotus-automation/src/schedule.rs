//! When a `schedule` trigger fires: a cron pattern read in an IANA time zone,
//! so "09:00" stays 09:00 local time across DST changes.

use std::str::FromStr;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde::{Deserialize, Serialize};

/// `automation.trigger.config` for kind `schedule`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    /// Five fields: minute hour day-of-month month day-of-week.
    pub cron: String,
    /// IANA name, e.g. `Asia/Jakarta`.
    pub timezone: String,
}

const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

impl Schedule {
    pub fn parse(cron: &str, timezone: &str) -> Result<Self, String> {
        let schedule = Self { cron: cron.trim().to_string(), timezone: timezone.trim().to_string() };
        schedule.pattern()?;
        schedule.zone()?;
        Ok(schedule)
    }

    /// The form's shape: days of the week (`mon`…`sun`) at `HH:MM`.
    pub fn from_simple(days: &[&str], time: &str, timezone: &str) -> Result<Self, String> {
        if days.is_empty() {
            return Err("choose at least one day".into());
        }
        let mut numbers: Vec<usize> = Vec::new();
        for day in days {
            let n = DAYS
                .iter()
                .position(|d| d.eq_ignore_ascii_case(day.trim()))
                .ok_or_else(|| format!("{day:?} is not a day of the week"))?;
            if !numbers.contains(&n) {
                numbers.push(n);
            }
        }
        numbers.sort_unstable();
        let (hour, minute) = time
            .trim()
            .split_once(':')
            .and_then(|(h, m)| Some((h.parse::<u32>().ok()?, m.parse::<u32>().ok()?)))
            .filter(|(h, m)| *h < 24 && *m < 60)
            .ok_or_else(|| format!("{time:?} is not a time of day (HH:MM)"))?;
        let days = numbers.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",");
        Self::parse(&format!("{minute} {hour} * * {days}"), timezone)
    }

    /// The first occurrence strictly after `after_ms`.
    pub fn next_after(&self, after_ms: i64) -> Option<i64> {
        let (pattern, zone) = (self.pattern().ok()?, self.zone().ok()?);
        let start = local(after_ms, zone)?;
        pattern.find_next_occurrence(&start, false).ok().map(|t| t.timestamp_millis())
    }

    /// The latest occurrence in `(after_ms, now_ms]`, if any. However many
    /// were missed while Lotus was off, this is the one run owed.
    pub fn latest_due(&self, after_ms: i64, now_ms: i64) -> Option<i64> {
        let (pattern, zone) = (self.pattern().ok()?, self.zone().ok()?);
        let now = local(now_ms, zone)?;
        let latest = pattern.find_previous_occurrence(&now, true).ok()?.timestamp_millis();
        (latest > after_ms).then_some(latest)
    }

    fn pattern(&self) -> Result<Cron, String> {
        if self.cron.split_whitespace().count() != 5 {
            return Err(format!("{:?} is not a five-field schedule (minute hour day month weekday)", self.cron));
        }
        Cron::from_str(&self.cron).map_err(|e| format!("{:?} is not a valid schedule: {e}", self.cron))
    }

    fn zone(&self) -> Result<Tz, String> {
        self.timezone.parse::<Tz>().map_err(|_| format!("{:?} is not a known time zone", self.timezone))
    }
}

fn local(ms: i64, zone: Tz) -> Option<DateTime<Tz>> {
    Utc.timestamp_millis_opt(ms).single().map(|t| t.with_timezone(&zone))
}
