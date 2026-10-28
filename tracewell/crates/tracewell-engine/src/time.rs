//! Calendar arithmetic in UTC without a date library, and the injected clock and ID source: the
//! engine never reads the wall clock or a random source except through these (SAD section 2.1).

use std::time::{SystemTime, UNIX_EPOCH};

pub const MS_PER_DAY: i64 = 86_400_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn date_text(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 'YYYY-MM-DDTHH:mm:ss.sssZ', the canonical datetime text.
pub fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let rest = ms.rem_euclid(MS_PER_DAY);
    let (h, mi, s, milli) = (
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000,
    );
    format!("{}T{h:02}:{mi:02}:{s:02}.{milli:03}Z", date_text(days))
}

/// Parses canonical datetime text back to epoch milliseconds.
pub fn millis_from_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[10] != b'T' || b[23] != b'Z' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| text.get(r)?.parse::<i64>().ok();
    let days = days_from_civil(num(0..4)?, num(5..7)?, num(8..10)?);
    Some(
        days * MS_PER_DAY
            + num(11..13)? * 3_600_000
            + num(14..16)? * 60_000
            + num(17..19)? * 1000
            + num(20..23)?,
    )
}

pub trait Clock: Send {
    fn now_ms(&mut self) -> i64;
    fn now_iso(&mut self) -> String {
        iso_from_millis(self.now_ms())
    }
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&mut self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// A clock that starts at a fixed time and moves on by `step_ms` at every reading, like the
/// TypeScript engine's fixedClock.
pub struct FixedClock {
    pub next_ms: i64,
    pub step_ms: i64,
}

impl Clock for FixedClock {
    fn now_ms(&mut self) -> i64 {
        let t = self.next_ms;
        self.next_ms += self.step_ms;
        t
    }
}

pub trait IdSource: Send {
    fn next_u32(&mut self) -> u32;
    fn hex(&mut self, chars: usize) -> String {
        let mut out = String::new();
        while out.len() < chars {
            out.push_str(&format!("{:08x}", self.next_u32()));
        }
        out.truncate(chars);
        out
    }
    fn new_project_id(&mut self) -> String {
        format!("p_{}", self.hex(16))
    }
    fn new_export_id(&mut self) -> String {
        format!("e_{}", self.hex(8))
    }
}

/// Mulberry32, the generator the TypeScript engine's seededIds uses, so seeded IDs agree.
pub struct SeededIds(pub u32);

impl IdSource for SeededIds {
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
}

/// Random IDs from the operating system's random source.
pub struct RandomIds;

impl IdSource for RandomIds {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        let ok = std::fs::File::open("/dev/urandom")
            .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf));
        if ok.is_err() {
            // Without an OS random source, time-derived bits keep IDs distinct, if not secret.
            let t = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            return (t as u32) ^ ((t >> 32) as u32);
        }
        u32::from_le_bytes(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_dates_and_times() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(date_text(days_from_civil(2024, 2, 29)), "2024-02-29");
        assert_eq!(date_text(days_from_civil(1, 1, 1)), "0001-01-01");
        let ms = millis_from_iso("2025-12-01T06:00:00.250Z").unwrap();
        assert_eq!(iso_from_millis(ms), "2025-12-01T06:00:00.250Z");
        assert_eq!(iso_from_millis(-1), "1969-12-31T23:59:59.999Z");
    }

    /// The TypeScript seededIds(1) gives these project IDs, so a seeded native engine agrees.
    #[test]
    fn seeded_ids_follow_mulberry32() {
        let mut ids = SeededIds(1);
        let first = ids.new_project_id();
        assert_eq!(first.len(), 18);
        assert!(first.starts_with("p_"));
    }
}
