/// The clock seam (ADR-13 no. 4).
///
/// A typedef rather than a class because there is exactly one question to ask, and
/// injecting it is what makes the 12-hour TTL testable by **moving time** instead of
/// by sleeping — a test that waited out a real expiry would take twelve hours.
typedef Clock = DateTime Function();

/// The real one. Named so a call site reads as a choice rather than a default.
DateTime systemClock() => DateTime.now();
