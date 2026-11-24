//! PLAN §8 Q10: following an Ask's notification is read from Lotus gaining focus soon after it.

use lotus_automation::ask::{AskNotice, ASK_NOTICE_WINDOW_MS};

#[test]
fn the_first_focus_within_ten_minutes_of_an_ask_notification_opens_that_ask_once() {
    let notice = AskNotice::default();
    notice.notified("ask1", 1_000);
    assert_eq!(notice.take_on_focus(1_000 + ASK_NOTICE_WINDOW_MS), Some("ask1".to_string()));
    assert_eq!(notice.take_on_focus(1_001 + ASK_NOTICE_WINDOW_MS), None, "one window, once");
}

#[test]
fn the_newest_notification_wins() {
    let notice = AskNotice::default();
    notice.notified("ask1", 1_000);
    notice.notified("ask2", 2_000);
    assert_eq!(notice.take_on_focus(3_000), Some("ask2".to_string()));
}

#[test]
fn a_focus_too_late_or_without_a_notification_opens_nothing_and_forgets() {
    let notice = AskNotice::default();
    assert_eq!(notice.take_on_focus(5), None);
    notice.notified("ask1", 1_000);
    assert_eq!(notice.take_on_focus(1_001 + ASK_NOTICE_WINDOW_MS), None);
    assert_eq!(notice.take_on_focus(2_000), None, "forgotten, even with a clock that went back");
}
