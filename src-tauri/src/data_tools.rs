//! Polars-backed data tools — `read_excel` + `analyse_data`.
//!
//! These mirror the surface a data analyst would expect from pandas-style
//! workflows: load a tabular source into a typed DataFrame, then perform
//! groupby / pivot / filter / sort / describe operations against it.
//!
//! The DataFrame doesn't cross the Tauri bridge — it lives in Rust under a
//! handle. Each call returns a small JSON-friendly preview (column metadata
//! + a head sample); operations that produce a derived DataFrame (filter,
//! sort, groupby, pivot, select) mint a fresh handle so the caller can
//! chain. A handle pool with an LRU bound (`DATAFRAME_LRU_CAP`) keeps
//! memory growth bounded across long agent conversations.
//!
//! Excel parsing goes through `calamine` (no native deps); the cell stream
//! is bucketed per column into typed series before handing off to polars.

use crate::tool_progress;
use calamine::{open_workbook_auto, Data, Reader};
use polars::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use uuid::Uuid;

/// Cap on resident DataFrames per app session. Above this we evict the
/// least-recently-used handle. 32 is enough for chained analytical
/// pipelines without drifting into hundreds of MB of cached frames.
const DATAFRAME_LRU_CAP: usize = 32;

/// Rows returned in every preview. Small enough to fit in one model
/// response, large enough to spot data-quality issues at a glance.
const PREVIEW_ROWS: usize = 10;

/// Process-wide store for parsed DataFrames keyed by handle. Wrapped in
/// a `Mutex` because Tauri commands can run concurrently and polars is
/// happy to share data across threads but we mutate the handle map.
pub struct DataFrameStore {
    inner: Mutex<DataFrameStoreInner>,
}

struct DataFrameStoreInner {
    /// Handle → DataFrame. Order in `lru` is the eviction order.
    frames: HashMap<String, DataFrame>,
    lru: VecDeque<String>,
}

impl DataFrameStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DataFrameStoreInner {
                frames: HashMap::new(),
                lru: VecDeque::new(),
            }),
        }
    }

    fn touch(&self, handle: &str) {
        let mut g = self.inner.lock().expect("data store poisoned");
        if let Some(pos) = g.lru.iter().position(|h| h == handle) {
            g.lru.remove(pos);
        }
        g.lru.push_back(handle.to_string());
    }

    fn insert(&self, handle: String, df: DataFrame) {
        let mut g = self.inner.lock().expect("data store poisoned");
        if g.frames.len() >= DATAFRAME_LRU_CAP {
            if let Some(stale) = g.lru.pop_front() {
                g.frames.remove(&stale);
            }
        }
        g.frames.insert(handle.clone(), df);
        g.lru.push_back(handle);
    }

    fn with_frame<R>(&self, handle: &str, f: impl FnOnce(&DataFrame) -> R) -> Option<R> {
        let g = self.inner.lock().expect("data store poisoned");
        g.frames.get(handle).map(f)
    }
}

/// Mint a handle whose textual form is short and stable for logs.
fn new_handle() -> String {
    format!("df_{}", Uuid::new_v4().simple())
}

// -- Preview & schema serialization --------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub dtype: String,
}

fn columns_of(df: &DataFrame) -> Vec<ColumnInfo> {
    df.iter()
        .map(|s| ColumnInfo {
            name: s.name().to_string(),
            dtype: format!("{}", s.dtype()),
        })
        .collect()
}

/// Materialize the first `n` rows of `df` into a vec of JSON objects.
/// Anything we can't represent as a primitive becomes the `Display` form
/// of the AnyValue — keeps complex dtypes (datetime, list) human-readable
/// without dragging in a second serialization path.
fn preview_rows(df: &DataFrame, n: usize) -> Vec<HashMap<String, serde_json::Value>> {
    let take = n.min(df.height());
    let mut out: Vec<HashMap<String, serde_json::Value>> = Vec::with_capacity(take);
    let cols = df.get_columns();
    for r in 0..take {
        let mut row: HashMap<String, serde_json::Value> = HashMap::with_capacity(cols.len());
        for col in cols {
            let v = col.get(r).unwrap_or(AnyValue::Null);
            row.insert(col.name().to_string(), any_value_to_json(&v));
        }
        out.push(row);
    }
    out
}

fn any_value_to_json(v: &AnyValue) -> serde_json::Value {
    match v {
        AnyValue::Null => serde_json::Value::Null,
        AnyValue::Boolean(b) => serde_json::Value::Bool(*b),
        AnyValue::Int8(i) => serde_json::json!(*i),
        AnyValue::Int16(i) => serde_json::json!(*i),
        AnyValue::Int32(i) => serde_json::json!(*i),
        AnyValue::Int64(i) => serde_json::json!(*i),
        AnyValue::UInt8(i) => serde_json::json!(*i),
        AnyValue::UInt16(i) => serde_json::json!(*i),
        AnyValue::UInt32(i) => serde_json::json!(*i),
        AnyValue::UInt64(i) => serde_json::json!(*i),
        AnyValue::Float32(f) => serde_json::json!(*f),
        AnyValue::Float64(f) => {
            if f.is_finite() {
                serde_json::json!(*f)
            } else {
                serde_json::Value::Null
            }
        }
        AnyValue::String(s) => serde_json::Value::String((*s).to_string()),
        AnyValue::StringOwned(s) => serde_json::Value::String(s.to_string()),
        other => serde_json::Value::String(format!("{other}")),
    }
}

// -- read_excel ----------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadExcelResult {
    /// Handle for subsequent `analyse_data` calls.
    pub handle: String,
    /// Path that was loaded (echoed back for confirmation).
    pub path: String,
    /// Sheet that was read.
    pub sheet: String,
    /// Every sheet in the workbook — lets callers pick a different one
    /// next time without reopening.
    pub sheet_names: Vec<String>,
    pub shape: (usize, usize),
    pub columns: Vec<ColumnInfo>,
    pub preview: Vec<HashMap<String, serde_json::Value>>,
}

#[tauri::command]
pub fn read_excel(
    app: AppHandle,
    path: String,
    sheet: Option<String>,
    has_header: Option<bool>,
    progress_id: Option<String>,
    store: State<'_, DataFrameStore>,
) -> Result<ReadExcelResult, String> {
    let pid = progress_id.as_deref();
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("read_excel: file not found: {path}"));
    }
    let display = pb
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();
    tool_progress::emit(&app, pid, format!("Opening workbook {display}…"));
    let mut book =
        open_workbook_auto(&pb).map_err(|e| format!("read_excel: open {path}: {e}"))?;
    let sheet_names: Vec<String> = book.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err(format!("read_excel: workbook has no sheets: {path}"));
    }
    let target = sheet.unwrap_or_else(|| sheet_names[0].clone());
    tool_progress::emit(&app, pid, format!("Reading sheet '{target}'…"));
    let range = book
        .worksheet_range(&target)
        .map_err(|e| format!("read_excel: sheet '{target}': {e}"))?;

    let (rows, cols) = (range.height(), range.width());
    tool_progress::emit(
        &app,
        pid,
        format!("Building DataFrame ({rows} × {cols})…"),
    );
    let df = range_to_dataframe(&range, has_header.unwrap_or(true))
        .map_err(|e| format!("read_excel: build DataFrame: {e}"))?;
    let handle = new_handle();
    let preview = preview_rows(&df, PREVIEW_ROWS);
    let columns = columns_of(&df);
    let shape = df.shape();
    store.insert(handle.clone(), df);

    Ok(ReadExcelResult {
        handle,
        path,
        sheet: target,
        sheet_names,
        shape,
        columns,
        preview,
    })
}

/// Convert a calamine cell range into a polars DataFrame. Column dtype is
/// inferred from the data: if every non-empty cell parses as a number we
/// emit a Float64 column (with nulls for blanks); same for booleans;
/// otherwise we fall back to UTF-8 strings. `Empty` cells become nulls.
fn range_to_dataframe(
    range: &calamine::Range<Data>,
    has_header: bool,
) -> PolarsResult<DataFrame> {
    let height = range.height();
    let width = range.width();
    if height == 0 || width == 0 {
        return Ok(DataFrame::default());
    }

    let (headers, data_start) = if has_header {
        let mut hs: Vec<String> = (0..width).map(|c| format!("col_{c}")).collect();
        for c in 0..width {
            if let Some(cell) = range.get((0, c)) {
                let label = cell_to_string(cell);
                if !label.is_empty() {
                    hs[c] = label;
                }
            }
        }
        (hs, 1)
    } else {
        ((0..width).map(|c| format!("col_{c}")).collect(), 0)
    };

    let body_rows = height.saturating_sub(data_start);
    let mut columns: Vec<Column> = Vec::with_capacity(width);

    for c in 0..width {
        let mut all_numeric = true;
        let mut all_bool = true;
        let mut any_value = false;

        for r in data_start..height {
            match range.get((r, c)) {
                Some(Data::Empty) | None => {}
                Some(Data::Bool(_)) => {
                    any_value = true;
                    all_numeric = false;
                }
                Some(Data::Int(_)) | Some(Data::Float(_)) => {
                    any_value = true;
                    all_bool = false;
                }
                Some(Data::String(s)) => {
                    any_value = true;
                    if s.parse::<f64>().is_err() {
                        all_numeric = false;
                    }
                    let lc = s.to_ascii_lowercase();
                    if lc != "true" && lc != "false" {
                        all_bool = false;
                    }
                }
                Some(Data::DateTime(_)) => {
                    any_value = true;
                    all_numeric = false;
                    all_bool = false;
                }
                Some(_) => {
                    any_value = true;
                    all_numeric = false;
                    all_bool = false;
                }
            }
        }

        let name: PlSmallStr = headers[c].as_str().into();
        let series: Series = if !any_value {
            // No data — emit a string column of all nulls so the column
            // exists in the schema. Avoids the ambiguity of "empty vs
            // missing" downstream.
            let v: Vec<Option<String>> = vec![None; body_rows];
            Series::new(name, v)
        } else if all_bool {
            let mut v: Vec<Option<bool>> = Vec::with_capacity(body_rows);
            for r in data_start..height {
                v.push(match range.get((r, c)) {
                    Some(Data::Bool(b)) => Some(*b),
                    Some(Data::String(s)) => match s.to_ascii_lowercase().as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    },
                    _ => None,
                });
            }
            Series::new(name, v)
        } else if all_numeric {
            let mut v: Vec<Option<f64>> = Vec::with_capacity(body_rows);
            for r in data_start..height {
                v.push(match range.get((r, c)) {
                    Some(Data::Int(i)) => Some(*i as f64),
                    Some(Data::Float(f)) => Some(*f),
                    Some(Data::String(s)) => s.parse::<f64>().ok(),
                    _ => None,
                });
            }
            Series::new(name, v)
        } else {
            let mut v: Vec<Option<String>> = Vec::with_capacity(body_rows);
            for r in data_start..height {
                v.push(match range.get((r, c)) {
                    Some(Data::Empty) | None => None,
                    Some(other) => Some(cell_to_string(other)),
                });
            }
            Series::new(name, v)
        };
        columns.push(series.into_column());
    }

    DataFrame::new(columns)
}

fn cell_to_string(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => f.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => format!("{}", dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR:{e:?}"),
    }
}

// -- analyse_data --------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseArgs {
    pub handle: String,
    pub operation: AnalyseOp,
}

/// One verb of statistical analysis. Distinct variants rather than a free-
/// form expression language so the model can pick something correct
/// without us shipping an expression parser.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnalyseOp {
    /// Per-column summary statistics (count, mean, std, min, max, etc.).
    Describe,
    /// First N rows.
    Head { n: Option<usize> },
    /// Last N rows.
    Tail { n: Option<usize> },
    /// Just the schema (no preview rebuild).
    Schema,
    /// Project a subset of columns into a new DataFrame.
    Select { columns: Vec<String> },
    /// Single-column predicate filter. `op` is one of `==`, `!=`, `>`,
    /// `>=`, `<`, `<=`, `contains`, `starts_with`, `ends_with`, `in`,
    /// `is_null`, `not_null`. `value` is interpreted in the column's
    /// dtype where possible.
    Filter {
        column: String,
        op: String,
        #[serde(default)]
        value: serde_json::Value,
    },
    /// Sort by one or more columns. `descending` aligns with `by`; missing
    /// entries default to ascending.
    Sort {
        by: Vec<String>,
        #[serde(default)]
        descending: Vec<bool>,
    },
    /// `groupby + agg`. Each `agg` is `{ column, op, alias? }` where `op`
    /// is one of `count`, `sum`, `mean`, `median`, `min`, `max`, `std`,
    /// `var`, `n_unique`, `first`, `last`.
    GroupBy {
        by: Vec<String>,
        agg: Vec<AggSpec>,
    },
    /// Pivot table. Equivalent to pandas `pivot_table(index, columns,
    /// values, aggfunc)`. `agg` defaults to `mean`.
    Pivot {
        index: Vec<String>,
        on: Vec<String>,
        values: Vec<String>,
        #[serde(default)]
        agg: Option<String>,
    },
    /// Distinct values of one column.
    Unique { column: String },
    /// Frequency of each unique value in `column`. Returns a 2-column
    /// DataFrame (`column`, `count`) sorted by count desc.
    ValueCounts { column: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggSpec {
    pub column: String,
    pub op: String,
    #[serde(default)]
    pub alias: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseResult {
    /// Source handle the operation ran against.
    pub source_handle: String,
    /// Verb that ran (echoed back for log readability).
    pub operation: String,
    /// New handle when the operation produces a derived DataFrame; absent
    /// for read-only ops like `schema`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub shape: (usize, usize),
    pub columns: Vec<ColumnInfo>,
    pub preview: Vec<HashMap<String, serde_json::Value>>,
}

#[tauri::command]
pub fn analyse_data(
    app: AppHandle,
    args: AnalyseArgs,
    progress_id: Option<String>,
    store: State<'_, DataFrameStore>,
) -> Result<AnalyseResult, String> {
    let pid = progress_id.as_deref();
    let source = args.handle.clone();
    store.touch(&source);
    let snapshot = store
        .with_frame(&source, |df| df.clone())
        .ok_or_else(|| format!("analyse_data: unknown handle: {source}"))?;

    let (rows, cols) = snapshot.shape();
    tool_progress::emit(
        &app,
        pid,
        format!(
            "Running {} on {rows} × {cols} frame…",
            op_kind_label(&args.operation)
        ),
    );

    let (op_label, derived) = run_op(&snapshot, &args.operation)?;
    let shape = derived.shape();
    let columns = columns_of(&derived);
    let preview = preview_rows(&derived, PREVIEW_ROWS);

    // Schema is read-only — no new DataFrame is produced, so we don't
    // burn a handle on it. Every other operation returns a derived frame
    // the caller can chain against, so we mint a fresh handle and stash
    // the result in the LRU.
    let handle = if matches!(args.operation, AnalyseOp::Schema) {
        None
    } else {
        let h = new_handle();
        store.insert(h.clone(), derived);
        Some(h)
    };

    Ok(AnalyseResult {
        source_handle: source,
        operation: op_label.into(),
        handle,
        shape,
        columns,
        preview,
    })
}

/// Verb-only label for the progress heartbeat — `run_op` already returns
/// the same string but only after the operation finishes, which is too
/// late for "Running X on …" feedback. Cheap to derive here without
/// running the op.
fn op_kind_label(op: &AnalyseOp) -> &'static str {
    match op {
        AnalyseOp::Describe => "describe",
        AnalyseOp::Head { .. } => "head",
        AnalyseOp::Tail { .. } => "tail",
        AnalyseOp::Schema => "schema",
        AnalyseOp::Select { .. } => "select",
        AnalyseOp::Filter { .. } => "filter",
        AnalyseOp::Sort { .. } => "sort",
        AnalyseOp::GroupBy { .. } => "group_by",
        AnalyseOp::Pivot { .. } => "pivot",
        AnalyseOp::Unique { .. } => "unique",
        AnalyseOp::ValueCounts { .. } => "value_counts",
    }
}

fn run_op(df: &DataFrame, op: &AnalyseOp) -> Result<(&'static str, DataFrame), String> {
    Ok(match op {
        AnalyseOp::Describe => ("describe", manual_describe(df).map_err(err_to_string)?),
        AnalyseOp::Head { n } => ("head", df.head(*n)),
        AnalyseOp::Tail { n } => ("tail", df.tail(*n)),
        AnalyseOp::Schema => ("schema", df.head(Some(0))),
        AnalyseOp::Select { columns } => {
            let refs: Vec<&str> = columns.iter().map(String::as_str).collect();
            ("select", df.select(refs).map_err(err_to_string)?)
        }
        AnalyseOp::Filter { column, op, value } => {
            let expr = build_filter_expr(column, op, value)?;
            let result = df
                .clone()
                .lazy()
                .filter(expr)
                .collect()
                .map_err(err_to_string)?;
            ("filter", result)
        }
        AnalyseOp::Sort { by, descending } => {
            let mut desc: Vec<bool> = descending.clone();
            desc.resize(by.len(), false);
            let sorted = df
                .sort(
                    by.iter().map(String::as_str).collect::<Vec<_>>(),
                    SortMultipleOptions::default().with_order_descending_multi(desc),
                )
                .map_err(err_to_string)?;
            ("sort", sorted)
        }
        AnalyseOp::GroupBy { by, agg } => {
            let mut aggs: Vec<Expr> = Vec::with_capacity(agg.len());
            for spec in agg {
                aggs.push(build_agg_expr(spec)?);
            }
            let by_exprs: Vec<Expr> = by.iter().map(|s| col(s.as_str())).collect();
            let lf = df.clone().lazy().group_by(by_exprs).agg(aggs);
            ("group_by", lf.collect().map_err(err_to_string)?)
        }
        AnalyseOp::Pivot {
            index,
            on,
            values,
            agg,
        } => {
            let agg_op = agg.as_deref().unwrap_or("mean");
            // Pivot's `agg_expr` is a single Expr applied to the pivoted
            // value columns when there are duplicate (index, on) pairs.
            // `col("*")` selects every value column polars passes through,
            // so the same expression works whether the user pivoted one
            // value column or several.
            let agg_expr: Expr = match agg_op {
                "first" => col("*").first(),
                "last" => col("*").last(),
                "sum" => col("*").sum(),
                "min" => col("*").min(),
                "max" => col("*").max(),
                "mean" | "avg" => col("*").mean(),
                "median" => col("*").median(),
                "count" => col("*").count(),
                other => return Err(format!("analyse_data: unknown pivot agg: {other}")),
            };
            let result = polars::prelude::pivot::pivot(
                df,
                on.iter().map(String::as_str).collect::<Vec<_>>(),
                Some(index.iter().map(String::as_str).collect::<Vec<_>>()),
                Some(values.iter().map(String::as_str).collect::<Vec<_>>()),
                false,
                Some(agg_expr),
                None,
            )
            .map_err(err_to_string)?;
            ("pivot", result)
        }
        AnalyseOp::Unique { column } => {
            let series = df.column(column).map_err(err_to_string)?.clone();
            let unique = series.unique().map_err(err_to_string)?;
            (
                "unique",
                DataFrame::new(vec![unique]).map_err(err_to_string)?,
            )
        }
        AnalyseOp::ValueCounts { column } => {
            let s = df.column(column).map_err(err_to_string)?;
            let counts = s
                .as_materialized_series()
                .value_counts(true, true, "count".into(), false)
                .map_err(err_to_string)?;
            ("value_counts", counts)
        }
    })
}

/// Hand-rolled summary-stats DataFrame. Polars' `DataFrame::describe` sits
/// behind a feature we don't pull in (it would balloon the dep graph), so
/// we compute the usual summary directly from `Series`. Numeric columns
/// fill in `mean`/`std`; everything else reports `count` and `null_count`
/// plus stringified `min`/`max` where the dtype supports comparison.
fn manual_describe(df: &DataFrame) -> PolarsResult<DataFrame> {
    let stats = ["count", "null_count", "mean", "std", "min", "max"];
    let mut out: Vec<Column> = Vec::with_capacity(df.width() + 1);
    out.push(
        Series::new(
            "statistic".into(),
            stats.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .into_column(),
    );

    for series in df.iter() {
        let name: PlSmallStr = series.name().clone();
        let count = (series.len() - series.null_count()) as f64;
        let null_count = series.null_count() as f64;

        // `mean` and `std` are defined directly on Series — `None` for
        // non-numeric dtypes is exactly what we want.
        let mean = series.mean();
        let std = series.std(1);

        // `min_reduce` / `max_reduce` work on every dtype; we stringify
        // the result so the describe DataFrame keeps a single column type
        // regardless of the source column's dtype.
        let min_str = series
            .min_reduce()
            .ok()
            .map(|sc| any_value_display(sc.value()));
        let max_str = series
            .max_reduce()
            .ok()
            .map(|sc| any_value_display(sc.value()));

        let mut values: Vec<Option<String>> = vec![
            Some(format_count(count)),
            Some(format_count(null_count)),
            mean.map(format_float),
            std.map(format_float),
            min_str,
            max_str,
        ];
        for v in values.iter_mut() {
            if v.as_deref() == Some("") {
                *v = None;
            }
        }
        out.push(Series::new(name, values).into_column());
    }
    DataFrame::new(out)
}

fn format_count(n: f64) -> String {
    format!("{n:.0}")
}

fn format_float(n: f64) -> String {
    if n.is_finite() {
        format!("{n}")
    } else {
        String::new()
    }
}

fn any_value_display(v: &AnyValue) -> String {
    match v {
        AnyValue::Null => String::new(),
        other => format!("{other}"),
    }
}

/// Build a polars `Expr` that, when applied via `LazyFrame::filter`,
/// yields rows matching the predicate. Lives entirely in the lazy world
/// so coercion (string ↔ numeric) is handled by polars rather than us
/// re-implementing dtype rules.
fn build_filter_expr(
    column: &str,
    op: &str,
    value: &serde_json::Value,
) -> Result<Expr, String> {
    let c = col(column);
    Ok(match op {
        "is_null" => c.is_null(),
        "not_null" | "is_not_null" => c.is_not_null(),
        "==" | "eq" => c.eq(json_to_lit(value)),
        "!=" | "ne" => c.neq(json_to_lit(value)),
        ">" | "gt" => c.gt(json_to_lit(value)),
        ">=" | "gte" => c.gt_eq(json_to_lit(value)),
        "<" | "lt" => c.lt(json_to_lit(value)),
        "<=" | "lte" => c.lt_eq(json_to_lit(value)),
        "contains" => {
            let needle = json_to_string(value);
            c.str().contains_literal(lit(needle))
        }
        "starts_with" => {
            let needle = json_to_string(value);
            c.str().starts_with(lit(needle))
        }
        "ends_with" => {
            let needle = json_to_string(value);
            c.str().ends_with(lit(needle))
        }
        other => return Err(format!("filter: unknown op '{other}'")),
    })
}

fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn json_to_lit(v: &serde_json::Value) -> Expr {
    match v {
        serde_json::Value::Null => lit(NULL),
        serde_json::Value::Bool(b) => lit(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                lit(i)
            } else if let Some(f) = n.as_f64() {
                lit(f)
            } else {
                lit(NULL)
            }
        }
        serde_json::Value::String(s) => lit(s.clone()),
        other => lit(other.to_string()),
    }
}

fn build_agg_expr(spec: &AggSpec) -> Result<Expr, String> {
    let base = col(spec.column.as_str());
    let expr = match spec.op.as_str() {
        "count" => base.count(),
        "sum" => base.sum(),
        "mean" | "avg" => base.mean(),
        "median" => base.median(),
        "min" => base.min(),
        "max" => base.max(),
        "std" => base.std(1),
        "var" => base.var(1),
        "n_unique" | "nunique" => base.n_unique(),
        "first" => base.first(),
        "last" => base.last(),
        other => return Err(format!("group_by: unknown agg op '{other}'")),
    };
    let alias = spec
        .alias
        .clone()
        .unwrap_or_else(|| format!("{}_{}", spec.column, spec.op));
    Ok(expr.alias(alias.as_str()))
}

fn err_to_string<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> DataFrame {
        let region = Series::new(
            "region".into(),
            &["us", "us", "eu", "eu", "us", "eu"],
        );
        let value = Series::new("value".into(), &[1.0_f64, 2.0, 3.0, 4.0, 5.0, 6.0]);
        let category = Series::new(
            "category".into(),
            &["a", "b", "a", "b", "a", "b"],
        );
        DataFrame::new(vec![
            region.into_column(),
            value.into_column(),
            category.into_column(),
        ])
        .unwrap()
    }

    #[test]
    fn store_round_trips() {
        let store = DataFrameStore::new();
        store.insert("h".into(), fixture());
        assert!(store.with_frame("h", |df| df.height()).is_some());
    }

    #[test]
    fn describe_runs() {
        let df = fixture();
        let (label, out) = run_op(&df, &AnalyseOp::Describe).unwrap();
        assert_eq!(label, "describe");
        assert!(out.height() > 0);
    }

    #[test]
    fn group_by_sum() {
        let df = fixture();
        let op = AnalyseOp::GroupBy {
            by: vec!["region".into()],
            agg: vec![AggSpec {
                column: "value".into(),
                op: "sum".into(),
                alias: Some("total".into()),
            }],
        };
        let (label, out) = run_op(&df, &op).unwrap();
        assert_eq!(label, "group_by");
        assert!(out.column("total").is_ok());
    }

    #[test]
    fn filter_eq() {
        let df = fixture();
        let op = AnalyseOp::Filter {
            column: "region".into(),
            op: "==".into(),
            value: serde_json::Value::String("us".into()),
        };
        let (_, out) = run_op(&df, &op).unwrap();
        assert_eq!(out.height(), 3);
    }

    #[test]
    fn sort_descending() {
        let df = fixture();
        let op = AnalyseOp::Sort {
            by: vec!["value".into()],
            descending: vec![true],
        };
        let (_, out) = run_op(&df, &op).unwrap();
        let v = out.column("value").unwrap();
        let first = v.get(0).unwrap();
        let last = v.get(out.height() - 1).unwrap();
        // First entry should be the max.
        let first_f = match first {
            AnyValue::Float64(f) => f,
            _ => panic!("unexpected dtype"),
        };
        let last_f = match last {
            AnyValue::Float64(f) => f,
            _ => panic!("unexpected dtype"),
        };
        assert!(first_f > last_f);
    }
}
