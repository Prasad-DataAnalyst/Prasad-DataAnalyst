//! tracewell-engine: the Tracewell engine protocol over stdin and stdout (JSON lines plus binary
//! frames), with DuckDB and Parquet underneath for files beyond browser memory.
//!
//!   tracewell-engine serve [--workdir DIR] [--memory-limit BYTES] [--threads N] [--owner NAME]
//!                          [--fixed-clock ISO [--clock-step-ms N]] [--seed N]
//!
//! The owner is the registered owner of this copy; every export manifest records it.

mod audit;
mod canonical;
mod checks;
mod csv;
mod digest;
mod encoding;
mod engine;
mod error;
mod export;
mod framing;
mod import;
mod issues;
mod parse;
mod rules;
mod stream;
mod time;
mod units;
mod zip;

use engine::{Engine, Shared};
use error::{EngineError, Result};
use framing::{Incoming, read_message};
use serde_json::{Value, json};
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use time::{FixedClock, RandomIds, SeededIds, SystemClock, millis_from_iso};

struct Args {
    workdir: PathBuf,
    memory_limit: u64,
    threads: Option<u64>,
    fixed_clock: Option<i64>,
    clock_step: i64,
    seed: Option<u32>,
    owner: String,
}

fn parse_args(argv: &[String]) -> std::result::Result<Args, String> {
    let mut a = Args {
        workdir: std::env::temp_dir().join(format!("tracewell-engine-{}", std::process::id())),
        memory_limit: 0,
        threads: None,
        fixed_clock: None,
        clock_step: 1000,
        seed: None,
        // The product's owner, as the TypeScript build takes it from package.json's author.
        owner: env!("CARGO_PKG_AUTHORS").to_string(),
    };
    let mut it = argv.iter();
    while let Some(flag) = it.next() {
        let mut value = || it.next().cloned().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "serve" => {}
            "--workdir" => a.workdir = PathBuf::from(value()?),
            "--memory-limit" => {
                a.memory_limit = value()?.parse().map_err(|_| "--memory-limit takes bytes")?
            }
            "--threads" => {
                a.threads = Some(value()?.parse().map_err(|_| "--threads takes a number")?)
            }
            "--fixed-clock" => {
                a.fixed_clock = Some(
                    millis_from_iso(&value()?)
                        .ok_or("--fixed-clock takes YYYY-MM-DDTHH:mm:ss.sssZ")?,
                )
            }
            "--clock-step-ms" => {
                a.clock_step = value()?
                    .parse()
                    .map_err(|_| "--clock-step-ms takes a number")?
            }
            "--seed" => a.seed = Some(value()?.parse().map_err(|_| "--seed takes a number")?),
            "--owner" => a.owner = value()?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

/// Half the machine's memory, the budget SAD section 4.3 sets for DuckDB.
fn half_of_ram() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| {
            m.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
        })
        .map_or(4 << 30, |kb| kb * 1024 / 2)
}

fn open(args: &Args) -> Result<Engine> {
    std::fs::create_dir_all(&args.workdir)?;
    let conn = duckdb::Connection::open(args.workdir.join("engine.duckdb"))?;
    let limit = if args.memory_limit == 0 {
        half_of_ram()
    } else {
        args.memory_limit
    };
    let temp = args.workdir.join("spill");
    conn.execute_batch(&format!(
        "SET memory_limit = '{limit}B'; SET temp_directory = {}; SET preserve_insertion_order = true;{}",
        import::quote_text(&temp.to_string_lossy()),
        args.threads.map_or(String::new(), |t| format!(" SET threads = {t};")),
    ))?;
    let clock: Box<dyn time::Clock> = match args.fixed_clock {
        Some(start) => Box::new(FixedClock {
            next_ms: start,
            step_ms: args.clock_step,
        }),
        None => Box::new(SystemClock),
    };
    let ids: Box<dyn time::IdSource> = match args.seed {
        Some(seed) => Box::new(SeededIds(seed)),
        None => Box::new(RandomIds),
    };
    let threads = args.threads.map_or_else(
        || std::thread::available_parallelism().map_or(1, |n| n.get()),
        |t| t.max(1) as usize,
    );
    Ok(Engine::new(
        conn,
        args.workdir.clone(),
        clock,
        ids,
        limit,
        threads,
        args.owner.clone(),
    ))
}

fn param(params: &[Value], i: usize) -> &Value {
    params.get(i).unwrap_or(&Value::Null)
}

fn call(shared: &Arc<Shared>, msg: &Incoming, method: &str, params: &[Value]) -> Result<Value> {
    if method == "importFile" {
        return engine::import_file(shared, msg, param(params, 0), param(params, 1));
    }
    if method == "runChecks" {
        return engine::run_checks(shared, param(params, 0));
    }
    if method == "exportData" {
        return engine::export_data(shared, param(params, 0));
    }
    let mut e = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    match method {
        "hello" => Ok(e.hello()),
        "newProject" => e.new_project(param(params, 0)),
        "getProject" => e.summary(),
        "getSchema" => e.schema(param(params, 0)),
        "getRows" => e.rows(param(params, 0)),
        "getColumnStats" => e.column_stats(param(params, 0), param(params, 1)),
        "listAudit" => e.list_audit(param(params, 0)),
        "verifyAudit" => e.verify_audit(),
        "listIssues" => e.list_issues(param(params, 0)),
        "listOccurrences" => e.list_occurrences(param(params, 0), param(params, 1)),
        "listExportProfiles" => e.list_export_profiles(param(params, 0)),
        "getHealth" => e.health(param(params, 0)),
        "jobOutcome" => e.job_outcome(param(params, 0)),
        "cancelJob" => e.cancel_job(param(params, 0)),
        other => Err(EngineError::unsupported(format!("the call {other}"))),
    }
}

fn serve(args: Args) -> io::Result<()> {
    let engine = open(&args).map_err(|e| io::Error::other(e.message))?;
    let shared = Arc::new(Shared {
        engine: Mutex::new(engine),
        out: Mutex::new(Box::new(io::stdout())),
    });
    let mut input = BufReader::with_capacity(1 << 16, io::stdin().lock());
    while let Some(msg) = read_message(&mut input)? {
        let v = &msg.value;
        if v["kind"] != "call" {
            continue;
        }
        let id = v["id"].clone();
        let method = v["method"].as_str().unwrap_or("").to_string();
        let params: Vec<Value> = v["params"].as_array().cloned().unwrap_or_default();
        let reply = match call(&shared, &msg, &method, &params) {
            Ok(value) => json!({ "kind": "result", "id": id, "ok": true, "value": value }),
            Err(e) => json!({ "kind": "result", "id": id, "ok": false, "error": e.to_json() }),
        };
        // A finished export hands its package back as a byte frame under result.bytes.
        let bytes = (method == "jobOutcome" && reply["value"]["state"] == "done")
            .then(|| {
                let job = params.first().and_then(Value::as_str).unwrap_or("");
                shared.engine.lock().ok()?.job_bytes.get(job).cloned()
            })
            .flatten();
        match bytes {
            Some(b) => {
                let framed = framing::with_bytes(
                    &reply,
                    |v, marker| v["value"]["result"]["bytes"] = marker,
                    b.len(),
                );
                shared.send_framed(&framed, &[&b]);
            }
            None => shared.send(&reply),
        }
    }
    Ok(())
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&argv) {
        Ok(args) => {
            if let Err(e) = serve(args) {
                eprintln!("tracewell-engine: {e}");
                std::process::exit(1);
            }
        }
        Err(msg) => {
            eprintln!("tracewell-engine: {msg}");
            std::process::exit(2);
        }
    }
}
