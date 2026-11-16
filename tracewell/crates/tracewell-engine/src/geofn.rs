//! The geometry tests of geo.rs as DuckDB scalar functions, so the spatial checks, the area filter
//! and the statistics of a geometry column run in SQL beside every other condition. A geometry
//! is the JSON text its column stores; each function reads that text and asks geo.rs.
//!
//! A missing geometry gives no text from the functions that return text and false from the
//! tests. DuckDB may also answer NULL for a NULL argument without asking the function at all (it
//! does so for a constant NULL), so SQL that uses a test wraps it in COALESCE(..., false), and a
//! test whose box is optional has a form without one instead of taking NULL edges.

use crate::canonical::canonical_json;
use crate::geo::{self, BBox, Problem};
use crate::json::{J, parse};
use duckdb::Connection;
use duckdb::arrow::array::{Array, ArrayRef, AsArray, BooleanArray, RecordBatch, StringArray};
use duckdb::arrow::datatypes::{DataType, Float64Type};
use duckdb::vscalar::{ArrowFunctionSignature, VArrowScalar};
use std::error::Error;
use std::sync::Arc;

type Out = std::result::Result<Arc<dyn Array>, Box<dyn Error>>;

fn text_at(a: &ArrayRef, i: usize) -> Option<&str> {
    if a.is_null(i) {
        return None;
    }
    match a.data_type() {
        DataType::Utf8 => Some(a.as_string::<i32>().value(i)),
        DataType::LargeUtf8 => Some(a.as_string::<i64>().value(i)),
        DataType::Utf8View => Some(a.as_string_view().value(i)),
        _ => None,
    }
}

/// The geometry of row `i`: None for no value and for text that is not JSON.
fn geometry_at(a: &ArrayRef, i: usize) -> Option<J> {
    text_at(a, i).and_then(|t| parse(t).ok())
}

/// The box that columns `from..from + 4` hold in row `i`, or None when any edge is missing.
fn box_at(batch: &RecordBatch, from: usize, i: usize) -> Option<BBox> {
    let mut edges = [0.0; 4];
    for (k, edge) in edges.iter_mut().enumerate() {
        let a = batch.column(from + k);
        if a.is_null(i) {
            return None;
        }
        *edge = a.as_primitive_opt::<Float64Type>()?.value(i);
    }
    Some(edges)
}

fn flags(batch: &RecordBatch, test: impl Fn(&J, usize) -> bool) -> Out {
    let texts = batch.column(0);
    let out: BooleanArray = (0..batch.num_rows())
        .map(|i| Some(geometry_at(texts, i).is_some_and(|g| test(&g, i))))
        .collect();
    Ok(Arc::new(out))
}

fn with_box() -> Vec<ArrowFunctionSignature> {
    vec![ArrowFunctionSignature::exact(
        vec![
            DataType::Utf8,
            DataType::Float64,
            DataType::Float64,
            DataType::Float64,
            DataType::Float64,
        ],
        DataType::Boolean,
    )]
}

/// The codes of a geometry's defects in document order, joined by commas; empty text for a valid
/// geometry. The note that a ring was too large to test is not a defect (rule TW-GEO-001).
pub fn defect_codes(text: &str) -> String {
    let Ok(g) = parse(text) else {
        return Problem::BadStructure.code().to_string();
    };
    geo::problems(&g)
        .into_iter()
        .filter(|p| *p != Problem::SkippedTooLarge)
        .map(Problem::code)
        .collect::<Vec<_>>()
        .join(",")
}

/// The canonical JSON text of a geometry, by which equal geometries are counted as one value
/// whatever order their members were written in.
pub fn canonical_text(text: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => canonical_json(&v),
        Err(_) => text.to_string(),
    }
}

/// tw_geo_defects(geometry): defect_codes, or NULL for no geometry.
struct Defects;

impl VArrowScalar for Defects {
    type State = ();

    fn invoke(_: &(), batch: RecordBatch) -> Out {
        let texts = batch.column(0);
        let out: StringArray = (0..batch.num_rows())
            .map(|i| text_at(texts, i).map(defect_codes))
            .collect();
        Ok(Arc::new(out))
    }

    fn signatures() -> Vec<ArrowFunctionSignature> {
        vec![ArrowFunctionSignature::exact(
            vec![DataType::Utf8],
            DataType::Utf8,
        )]
    }
}

/// tw_geo_canonical(geometry): canonical_text, or NULL for no geometry.
struct Canonical;

impl VArrowScalar for Canonical {
    type State = ();

    fn invoke(_: &(), batch: RecordBatch) -> Out {
        let texts = batch.column(0);
        let out: StringArray = (0..batch.num_rows())
            .map(|i| text_at(texts, i).map(canonical_text))
            .collect();
        Ok(Arc::new(out))
    }

    fn signatures() -> Vec<ArrowFunctionSignature> {
        vec![ArrowFunctionSignature::exact(
            vec![DataType::Utf8],
            DataType::Utf8,
        )]
    }
}

/// tw_geo_out_of_range(geometry): a valid geometry with a longitude beyond ±180 or a latitude
/// beyond ±90 (rule TW-GEO-002).
struct OutOfRange;

impl VArrowScalar for OutOfRange {
    type State = ();

    fn invoke(_: &(), batch: RecordBatch) -> Out {
        flags(&batch, |g, _| geo::is_valid(g) && !geo::in_range(g))
    }

    fn signatures() -> Vec<ArrowFunctionSignature> {
        vec![ArrowFunctionSignature::exact(
            vec![DataType::Utf8],
            DataType::Boolean,
        )]
    }
}

/// tw_geo_swapped(geometry) and tw_geo_swapped(geometry, west, south, east, north): a valid
/// geometry with a position whose longitude and latitude look exchanged; the box is the project
/// area, when there is one (rule TW-GEO-003).
struct Swapped;

impl VArrowScalar for Swapped {
    type State = ();

    fn invoke(_: &(), batch: RecordBatch) -> Out {
        let has_area = batch.num_columns() == 5;
        flags(&batch, |g, i| {
            let area = if has_area { box_at(&batch, 1, i) } else { None };
            geo::is_valid(g) && geo::any_swapped(g, area.as_ref())
        })
    }

    fn signatures() -> Vec<ArrowFunctionSignature> {
        let mut signatures = vec![ArrowFunctionSignature::exact(
            vec![DataType::Utf8],
            DataType::Boolean,
        )];
        signatures.extend(with_box());
        signatures
    }
}

/// tw_geo_outside(geometry, west, south, east, north): a valid geometry that shares no point with
/// the box (rule TW-GEO-005).
struct Outside;

impl VArrowScalar for Outside {
    type State = ();

    fn invoke(_: &(), batch: RecordBatch) -> Out {
        flags(&batch, |g, i| {
            box_at(&batch, 1, i).is_some_and(|b| geo::is_valid(g) && !geo::bbox_intersects(&b, g))
        })
    }

    fn signatures() -> Vec<ArrowFunctionSignature> {
        with_box()
    }
}

/// tw_geo_meets(geometry, west, south, east, north): a value with the shape of a geometry that
/// shares at least one point with the box (the area filter).
struct Meets;

impl VArrowScalar for Meets {
    type State = ();

    fn invoke(_: &(), batch: RecordBatch) -> Out {
        flags(&batch, |g, i| {
            box_at(&batch, 1, i).is_some_and(|b| geo::has_shape(g) && geo::bbox_intersects(&b, g))
        })
    }

    fn signatures() -> Vec<ArrowFunctionSignature> {
        with_box()
    }
}

/// Makes the functions known to the database behind `conn`; every connection to it sees them.
pub fn register(conn: &Connection) -> duckdb::Result<()> {
    conn.register_scalar_function::<Defects>("tw_geo_defects")?;
    conn.register_scalar_function::<Canonical>("tw_geo_canonical")?;
    conn.register_scalar_function::<OutOfRange>("tw_geo_out_of_range")?;
    conn.register_scalar_function::<Swapped>("tw_geo_swapped")?;
    conn.register_scalar_function::<Outside>("tw_geo_outside")?;
    conn.register_scalar_function::<Meets>("tw_geo_meets")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_functions_answer_in_sql_and_take_missing_geometries() {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE g (id INTEGER, geom VARCHAR);
               INSERT INTO g VALUES
                 (0, '{"type":"Point","coordinates":[2,58]}'),
                 (1, '{"coordinates":[58,2],"type":"Point"}'),
                 (2, '{"type":"Point","coordinates":[200,58]}'),
                 (3, '{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0]]]}'),
                 (4, '{"type":"Circle","coordinates":[1,2]}'),
                 (5, NULL),
                 (6, 'not json'),
                 (7, '{"type":"Point","coordinates":[-20.2,115.7]}');"#,
        )
        .unwrap();
        let column = |sql: &str| -> Vec<String> {
            let mut stmt = conn.prepare(sql).unwrap();
            let rows = stmt
                .query_map([], |r| {
                    r.get::<_, Option<String>>(0)
                        .map(|v| v.unwrap_or_else(|| "NULL".into()))
                })
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(
            column("SELECT tw_geo_defects(geom) FROM g ORDER BY id"),
            [
                "",
                "",
                "",
                "TOO_FEW_POSITIONS,RING_NOT_CLOSED",
                "BAD_STRUCTURE",
                "NULL",
                "BAD_STRUCTURE",
                ""
            ]
        );
        assert_eq!(
            column("SELECT tw_geo_canonical(geom) FROM g WHERE id < 2 ORDER BY id"),
            [
                r#"{"coordinates":[2,58],"type":"Point"}"#,
                r#"{"coordinates":[58,2],"type":"Point"}"#
            ]
        );
        let flagged = |test: &str| -> String {
            column(&format!(
                "SELECT string_agg(id::VARCHAR, ',' ORDER BY id) FROM g WHERE {test}"
            ))
            .join("")
        };
        assert_eq!(flagged("tw_geo_out_of_range(geom)"), "2,7");
        // Without an area only a latitude out of range gives a swap away; with one, a position
        // outside it that lies inside once exchanged does too.
        assert_eq!(flagged("tw_geo_swapped(geom)"), "7");
        assert_eq!(flagged("tw_geo_swapped(geom, 0, 50, 10, 60)"), "1,7");
        assert_eq!(flagged("tw_geo_outside(geom, 0, 50, 10, 60)"), "1,2,7");
        // The filter keeps what has the shape of a geometry, valid or not, and meets the box.
        assert_eq!(flagged("tw_geo_meets(geom, 0, 50, 10, 60)"), "0");
        assert_eq!(flagged("tw_geo_meets(geom, 0, 0, 10, 60)"), "0,3");
        assert_eq!(
            flagged("NOT COALESCE(tw_geo_meets(geom, 0, 0, 10, 60), false)"),
            "1,2,4,5,6,7"
        );
    }
}
