use chrono::{TimeZone, Utc};
use lotus_automation::schedule::Schedule;

fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
}

#[test]
fn weekdays_at_nine_in_jakarta_become_a_cron_pattern_that_skips_the_weekend() {
    let s = Schedule::from_simple(&["mon", "tue", "wed", "thu", "fri"], "09:00", "Asia/Jakarta").unwrap();
    assert_eq!(s.cron, "0 9 * * 1,2,3,4,5");

    // Friday 2026-09-25 10:00 WIB (03:00 UTC) → next is Monday 2026-09-28 09:00 WIB (02:00 UTC).
    assert_eq!(s.next_after(ms(2026, 9, 25, 3, 0)), Some(ms(2026, 9, 28, 2, 0)));
}

#[test]
fn a_nine_oclock_schedule_stays_at_nine_local_time_across_a_dst_change() {
    let s = Schedule::parse("0 9 * * *", "America/New_York").unwrap();
    // 2026-03-07 09:00 EST is 14:00 UTC; DST starts 2026-03-08, so 09:00 EDT is 13:00 UTC.
    assert_eq!(s.next_after(ms(2026, 3, 7, 14, 30)), Some(ms(2026, 3, 8, 13, 0)));
}

#[test]
fn only_the_latest_of_several_missed_runs_is_due() {
    let s = Schedule::parse("0 9 * * *", "Asia/Jakarta").unwrap();
    // Lotus was off from Monday 08:00 WIB until Thursday 10:00 WIB: Mon, Tue, Wed and Thu 09:00 were missed.
    let due = s.latest_due(ms(2026, 9, 28, 1, 0), ms(2026, 10, 1, 3, 0));
    assert_eq!(due, Some(ms(2026, 10, 1, 2, 0)), "Thursday 09:00 WIB only");
    assert_eq!(s.latest_due(ms(2026, 10, 1, 2, 0), ms(2026, 10, 1, 3, 0)), None, "already done");
}

#[test]
fn bad_input_is_refused_naming_what_is_wrong() {
    assert!(Schedule::parse("0 9 * *", "Asia/Jakarta").unwrap_err().contains("schedule"));
    assert!(Schedule::parse("0 9 * * *", "Mars/Olympus").unwrap_err().contains("time zone"));
    assert!(Schedule::from_simple(&[], "09:00", "Asia/Jakarta").unwrap_err().contains("day"));
    assert!(Schedule::from_simple(&["mon"], "25:00", "Asia/Jakarta").unwrap_err().contains("time"));
    assert!(Schedule::from_simple(&["funday"], "09:00", "Asia/Jakarta").unwrap_err().contains("day"));
}
