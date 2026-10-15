# Explore result analysis contract

Explore is a desktop result-panel feature, not a separate dashboard product.
Public request/response and filter types live in `@justybase/contracts`;
`@justybase/result-core` owns pure filter evaluation and exact numeric comparison.
The host owns SQL generation, connections, cancellation, and bounded reads.
The webview owns controls, selections, sample profiles, and chart rendering.

## Identity and persistence

State keys combine the source URI with the host-issued resultSetId. Timestamp
and index are legacy fallbacks only. Version 2 stores filters, active Explore
tab, chart mode, configurations, and a column-schema fingerprint. Ambiguous
legacy index-only entries are discarded. Incompatible schemas invalidate
configuration; execution/storage revision changes invalidate computed data.
At most 50 configuration entries remain persisted. Large samples are released
when leaving Explore; database responses are transient and bounded.

Logs/result/source navigation and pin/close index changes preserve the stable
owner's configuration. Hide/reveal and revival restore configuration without
executing database queries. Closing/replacing a view cancels its pending
operations. A response belonging to a detached view cannot render into its
replacement. Refresh/new execution cannot reuse a stale computed response.

## Data boundaries

Profiles and quality alerts use the first 50,000 fetched rows, independent of
main-grid filters, for both memory and SQLite-backed results. Column-role
inference intentionally uses a smaller bounded subset. Sample labels always
describe examined and loaded data, not database population estimates.

Database operations preserve source SQL limits. Fetch/transport limits are
separate. Search returns 100 values plus one sentinel; detail previews return
1,000 rows plus one sentinel. Preview pages are local, 100 rows per page. Ranking
returns at most 100 categories and one remainder. Pivot/time-series output is
capped at 5,000 rows with a sentinel to detect truncation.

Category filters combine columns with AND and selected values within one
condition with OR. Exclude retains NULL unless NULL is explicitly excluded.
Empty strings and NULL are separate selections; Oracle's empty-string-as-NULL
semantics still apply on the server. Numeric bounds remain strings where
necessary to preserve DECIMAL and large integer precision. Histogram bins and
selected time buckets use exclusive upper bounds except the last numeric bin.
Date-only upper bounds advance to the next day exclusively.

## Execution and recovery

Run, Search database, and Load rows are explicit actions. Filter/settings
changes update the sample immediately and invalidate displayed database
computations. Each displayed computation retains its applied filter snapshot;
drill-through uses that snapshot rather than current draft filters.

The typed request includes source, stable result identity, request ID, operation,
and preview flag. The response includes scope, applied filters, computedAt,
generated SQL, bounded rows, and truncation. Preview performs no database I/O.
Legacy Explore message variants remain accepted for compatibility.

Each execution uses an independent transient connection and runtime URI.
Cancel/timeout targets that URI, never the editor query. Connection acquisition
failure, disposal, cancellation, and supersession release request entries and
connections. Late replies cannot settle retired request IDs. Errors are shown
with retry; no database failure silently falls back to sample statistics.

## Verification

Pure tests compare filters and generated SQL against an in-memory SQLite
database, including exact numeric bounds, NULL, empty strings, source limits,
ranking shares and synthetic Other. DOM tests cover editor drafts, explicit
search/load/preview, safe text rendering, paging, and the 50,000-row cap.
Playwright exercises the bundled UI and stale-selection behavior. The gated
Extension Host workflow exercises memory and disk-backed Explore with real
SQLite, production UI controls, protocol routing, and Logs navigation; the
surrounding result-panel gate asserts both scroll axes after restoration.
