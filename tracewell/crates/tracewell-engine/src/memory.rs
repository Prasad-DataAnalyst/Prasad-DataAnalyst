//! The engine's memory budget (NFR-04). DuckDB keeps its buffer pool under its own limit, but the
//! process holds memory DuckDB does not count: the program and its thread stacks, query state
//! outside the pool, Arrow batches in flight between threads, and the C allocator's free lists. So
//! DuckDB gets the budget less a reserve for the rest, and the allocator is kept from spreading
//! freed memory over many arenas. Measured on a 20-million-row run under a 1 GiB budget, the
//! process stayed under it only with both (docs/benchmarks.md).

/// The share of the budget DuckDB may use: the budget less a quarter of it, keeping at least
/// 512 MiB for the rest of the process, but never less than half the budget.
pub fn duckdb_limit(budget: u64) -> u64 {
    let reserve = (budget / 4).max(512 << 20);
    budget.saturating_sub(reserve).max(budget / 2)
}

/// Limits the C allocator to two arenas. glibc's default, eight per core, leaves memory freed by
/// one query's threads idle in arenas the next query's threads do not use; on the 20-million-row
/// run that cost a third of the budget.
pub fn limit_arenas() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    glibc::mallopt(glibc::M_ARENA_MAX, 2);
}

/// Hands memory freed by a finished job back to the operating system.
pub fn release() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    glibc::malloc_trim(0);
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod glibc {
    pub const M_ARENA_MAX: i32 = -8;

    unsafe extern "C" {
        pub safe fn mallopt(param: i32, value: i32) -> i32;
        pub safe fn malloc_trim(pad: usize) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    #[test]
    fn keeps_a_reserve_out_of_duckdbs_limit() {
        assert_eq!(duckdb_limit(GIB), GIB / 2);
        assert_eq!(duckdb_limit(8 * GIB), 6 * GIB);
        // A small budget still gives DuckDB half of it.
        assert_eq!(duckdb_limit(256 << 20), 128 << 20);
    }

    #[test]
    fn allocator_calls_are_harmless() {
        limit_arenas();
        release();
    }
}
