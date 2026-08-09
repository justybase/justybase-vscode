package io.justybase.access;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * JSON-lines sidecar exposing Microsoft Access (.mdb/.accdb) databases to
 * Node.js through UCanAccess (JDBC).
 *
 * Protocol (one JSON document per line on stdout; logs go to stderr):
 *
 * <pre>
 *   Node -&gt; Java: {"id":1,"op":"connect","path":"C:\\data\\baza.accdb","readOnly":false}
 *   Node -&gt; Java: {"id":2,"op":"query","sql":"SELECT * FROM Klienci","maxRows":10000}
 *   Node -&gt; Java: {"id":3,"op":"cancel","queryId":2}
 *   Node -&gt; Java: {"id":4,"op":"metadata","kind":"tables","table":null}
 *   Node -&gt; Java: {"id":5,"op":"close"}
 * </pre>
 *
 * Every request is answered with exactly one response carrying the same
 * {@code id}. Query execution is serialized on a single worker thread so
 * writes to the Access file are never concurrent; cancellation is handled
 * directly on the reader thread by calling {@link Statement#cancel()}.
 */
public final class UcanaccessBridge {

    private static final DateTimeFormatter DATE_FORMATTER = DateTimeFormatter.ISO_LOCAL_DATE;
    private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ISO_LOCAL_TIME;
    private static final DateTimeFormatter TIMESTAMP_FORMATTER = DateTimeFormatter.ISO_LOCAL_DATE_TIME;

    private static final int DEFAULT_CHUNK_SIZE = 5000;

    private final BufferedReader in;
    private final PrintWriter out;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "access-bridge-worker");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<Long, Statement> activeStatements = new ConcurrentHashMap<>();
    private final Map<Long, Cursor> activeCursors = new ConcurrentHashMap<>();
    private final Set<Long> cancelledRequests = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closing = new AtomicBoolean(false);

    private volatile Connection connection;
    private volatile String databasePath;
    private volatile String databasePassword;
    private volatile boolean databaseReadOnly;

    /**
     * An open forward-only result set that is consumed in chunks through the
     * {@code fetchMore} op. Keeps the JDBC statement and result set alive until
     * the last chunk is delivered or {@code closeCursor} is received.
     */
    private static final class Cursor {
        final long cursorId;
        final Statement statement;
        final ResultSet resultSet;
        final List<Map<String, Object>> columns;
        final int columnCount;
        boolean hasMore = true;

        Cursor(long cursorId, Statement statement, ResultSet resultSet, List<Map<String, Object>> columns) {
            this.cursorId = cursorId;
            this.statement = statement;
            this.resultSet = resultSet;
            this.columns = columns;
            this.columnCount = columns.size();
        }

        void closeQuietly() {
            try {
                resultSet.close();
            } catch (SQLException ignored) {
                // Best effort close.
            }
            try {
                statement.close();
            } catch (SQLException ignored) {
                // Best effort close.
            }
        }
    }

    public static void main(String[] args) {
        BufferedReader in = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintWriter out = new PrintWriter(
                new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
        new UcanaccessBridge(in, out).run();
    }

    public UcanaccessBridge(BufferedReader in, PrintWriter out) {
        this.in = in;
        this.out = out;
    }

    public void run() {
        String line;
        try {
            while ((line = in.readLine()) != null) {
                String trimmed = line.trim();
                if (trimmed.isEmpty()) {
                    continue;
                }
                handle(trimmed);
            }
        } catch (IOException e) {
            log("I/O error: " + e.getMessage());
        } finally {
            shutdown();
        }
    }

    private void handle(String line) {
        Object parsed;
        try {
            parsed = Json.parse(line);
        } catch (IllegalArgumentException e) {
            log("Ignoring malformed JSON line: " + e.getMessage());
            return;
        }

        if (!(parsed instanceof Map)) {
            log("Ignoring non-object JSON request.");
            return;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> request = (Map<String, Object>) parsed;
        long id = Json.longValue(request.get("id"), -1L);
        String op = Json.stringValue(request.get("op"), "");

        try {
            switch (op) {
                case "connect":
                    handleConnect(id, request);
                    break;
                case "query":
                    handleQuery(id, request);
                    break;
                case "fetchMore":
                    handleFetchMore(id, request);
                    break;
                case "closeCursor":
                    handleCloseCursor(id, request);
                    break;
                case "metadata":
                    handleMetadata(id, request);
                    break;
                case "cancel":
                    handleCancel(id, request);
                    break;
                case "ping":
                    respond(id, ok());
                    break;
                case "close":
                    handleClose(id);
                    break;
                default:
                    respond(id, error("Unknown op '" + op + "'"));
                    break;
            }
        } catch (Throwable throwable) {
            respond(id, error(throwableMessage(throwable)));
        }
    }

    // ---------------------------------------------------------------- ops

    private void handleConnect(long id, Map<String, Object> request) throws Exception {
        String path = Json.stringValue(request.get("path"), "");
        if (path.isEmpty()) {
            throw new IllegalArgumentException("Missing 'path'");
        }
        boolean readOnly = Json.booleanValue(request.get("readOnly"), true);
        String password = Json.stringValue(request.get("password"), "");

        closeConnectionQuietly();
        databasePath = null;
        databasePassword = null;
        databaseReadOnly = false;

        connection = openConnection(path, password, readOnly);
        databasePath = path;
        databasePassword = password;
        databaseReadOnly = readOnly;

        respond(id, ok());
    }

    private Connection openConnection(String path, String password, boolean readOnly) throws Exception {
        Class.forName("net.ucanaccess.jdbc.UcanaccessDriver");

        StringBuilder url = new StringBuilder("jdbc:ucanaccess://")
                .append(path)
                .append(";memory=false");
        if (readOnly) {
            url.append(";readOnly=true");
        }

        try {
            // Keep the user empty for file-based Access authentication. The
            // optional password is supplied separately so it never appears in
            // the JDBC URL or in bridge diagnostics.
            Connection opened = java.sql.DriverManager.getConnection(url.toString(), "", password);
            opened.setReadOnly(readOnly);
            return opened;
        } catch (SQLException e) {
            String authenticationHint = password.isEmpty()
                    ? " If this file is password-protected, enter its Access database password in the connection settings."
                    : " Verify the Access database password in the connection settings.";
            throw new SQLException(
                    "Failed to open Microsoft Access database '" + path + "': " + e.getMessage() + authenticationHint, e);
        }
    }

    private void handleQuery(long id, Map<String, Object> request) {
        String sql = Json.stringValue(request.get("sql"), "");
        if (sql.isEmpty()) {
            respond(id, error("Missing 'sql'"));
            return;
        }
        int chunkSize = Json.intValue(request.get("chunkSize"), DEFAULT_CHUNK_SIZE);
        List<Object> params = Json.listValue(request.get("params"));

        worker.submit(() -> runQuery(id, sql, params, chunkSize));
    }

    private void runQuery(long id, String sql, List<Object> params, int chunkSize) {
        Statement statement = null;
        try {
            Connection conn = requireConnection();
            if (cancelledRequests.remove(id)) {
                respond(id, queryCancelled());
                return;
            }

            boolean hasParams = params != null && !params.isEmpty();
            if (hasParams) {
                PreparedStatement prepared = conn.prepareStatement(sql);
                statement = prepared;
                bindParams(prepared, params);
            } else {
                statement = conn.createStatement();
            }
            activeStatements.put(id, statement);

            boolean hasResultSet;
            if (hasParams) {
                hasResultSet = ((PreparedStatement) statement).execute();
            } else {
                hasResultSet = statement.execute(sql);
            }

            if (hasResultSet) {
                ResultSet resultSet = statement.getResultSet();
                ResultSetMetaData meta = resultSet.getMetaData();
                Cursor cursor = new Cursor(id, statement, resultSet, buildColumnDefinitions(meta));
                List<List<Object>> rows = fetchChunk(cursor, chunkSize);
                boolean hasMore = cursor.hasMore;
                if (hasMore) {
                    activeCursors.put(id, cursor);
                } else {
                    cursor.closeQuietly();
                    activeStatements.remove(id);
                }
                respondQueryChunk(id, cursor.columns, rows, hasMore, false);
            } else {
                int updateCount = statement.getUpdateCount();
                activeStatements.remove(id);
                closeQuietly(statement);
                respondUpdate(id, updateCount);
            }
        } catch (SQLException exception) {
            if (cancelledRequests.remove(id)) {
                respond(id, queryCancelled());
            } else {
                invalidateClosedConnection(exception);
                respond(id, error(throwableMessage(exception)));
            }
        } catch (Throwable throwable) {
            invalidateClosedConnection(throwable);
            respond(id, error(throwableMessage(throwable)));
        } finally {
            // When a cursor is still open the statement must stay alive;
            // otherwise release it here.
            if (!activeCursors.containsKey(id)) {
                activeStatements.remove(id);
                closeQuietly(statement);
            }
        }
    }

    private void handleFetchMore(long id, Map<String, Object> request) {
        long cursorId = Json.longValue(request.get("cursorId"), -1L);
        int chunkSize = Json.intValue(request.get("chunkSize"), DEFAULT_CHUNK_SIZE);
        worker.submit(() -> runFetchMore(id, cursorId, chunkSize));
    }

    private void runFetchMore(long id, long cursorId, int chunkSize) {
        try {
            if (cancelledRequests.remove(cursorId)) {
                closeCursor(cursorId);
                respond(id, fetchChunkResult(null, false, true));
                return;
            }
            Cursor cursor = activeCursors.get(cursorId);
            if (cursor == null) {
                respond(id, error("Unknown cursor id " + cursorId));
                return;
            }
            List<List<Object>> rows = fetchChunk(cursor, chunkSize);
            boolean hasMore = cursor.hasMore;
            if (!hasMore) {
                closeCursor(cursorId);
            }
            respond(id, fetchChunkResult(rows, hasMore, false));
        } catch (SQLException exception) {
            if (cancelledRequests.remove(cursorId)) {
                closeCursor(cursorId);
                respond(id, fetchChunkResult(null, false, true));
            } else {
                respond(id, error(throwableMessage(exception)));
            }
        } catch (Throwable throwable) {
            respond(id, error(throwableMessage(throwable)));
        }
    }

    private void handleCloseCursor(long id, Map<String, Object> request) {
        long cursorId = Json.longValue(request.get("cursorId"), -1L);
        closeCursor(cursorId);
        respond(id, ok());
    }

    private void closeCursor(long cursorId) {
        Cursor cursor = activeCursors.remove(cursorId);
        if (cursor != null) {
            cursor.closeQuietly();
        }
        activeStatements.remove(cursorId);
    }

    private static List<List<Object>> fetchChunk(Cursor cursor, int chunkSize) throws SQLException {
        List<List<Object>> rows = new ArrayList<>();
        int fetched = 0;
        while (fetched < chunkSize && cursor.resultSet.next()) {
            List<Object> row = new ArrayList<>(cursor.columnCount);
            for (int index = 1; index <= cursor.columnCount; index++) {
                row.add(readValue(cursor.resultSet, index));
            }
            rows.add(row);
            fetched++;
        }
        // If we filled the chunk there may be more rows; a subsequent
        // fetchMore with an empty result marks the end.
        cursor.hasMore = fetched >= chunkSize;
        return rows;
    }

    private static List<Map<String, Object>> buildColumnDefinitions(ResultSetMetaData meta) throws SQLException {
        List<Map<String, Object>> columns = new ArrayList<>();
        int columnCount = meta.getColumnCount();
        for (int index = 1; index <= columnCount; index++) {
            Map<String, Object> column = new LinkedHashMap<>();
            column.put("name", meta.getColumnLabel(index));
            column.put("type", meta.getColumnTypeName(index));
            column.put("jdbcType", meta.getColumnType(index));
            column.put("precision", meta.getPrecision(index));
            column.put("scale", meta.getScale(index));
            columns.add(column);
        }
        return columns;
    }

    private void handleCancel(long id, Map<String, Object> request) {
        long queryId = Json.longValue(request.get("queryId"), -1L);
        cancelledRequests.add(queryId);
        Statement statement = activeStatements.get(queryId);
        if (statement != null) {
            try {
                statement.cancel();
            } catch (SQLException e) {
                log("cancel failed for query " + queryId + ": " + e.getMessage());
            }
        }
        respond(id, ok());
    }

    private void handleMetadata(long id, Map<String, Object> request) throws SQLException {
        String kind = Json.stringValue(request.get("kind"), "");
        String table = Json.stringValue(request.get("table"), null);
        boolean serverSide = Json.booleanValue(request.get("serverSide"), false);

        worker.submit(() -> runMetadata(id, kind, table, serverSide));
    }

    private void runMetadata(long id, String kind, String table, boolean serverSide) {
        try {
            Connection conn = requireConnection();
            if (cancelledRequests.remove(id)) {
                respond(id, queryCancelled());
                return;
            }
            respondMetadata(id, kind, conn, table, serverSide);
        } catch (Throwable throwable) {
            respond(id, error(throwableMessage(throwable)));
        }
    }

    private void handleClose(long id) {
        closeConnectionQuietly();
        respond(id, ok());
    }

    // ------------------------------------------------------------- queries

    private void respondQueryChunk(long id, List<Map<String, Object>> columns, List<List<Object>> rows,
            boolean hasMore, boolean cancelled) {
        Map<String, Object> response = ok();
        response.put("kind", "query");
        response.put("columns", columns);
        response.put("rows", rows);
        response.put("recordsAffected", -1);
        response.put("hasMore", hasMore);
        if (hasMore) {
            response.put("cursorId", id);
        }
        if (cancelled) {
            response.put("cancelled", true);
        }
        respond(id, response);
    }

    private static Map<String, Object> fetchChunkResult(List<List<Object>> rows, boolean hasMore, boolean cancelled) {
        Map<String, Object> response = ok();
        response.put("kind", "fetch");
        response.put("rows", rows == null ? new ArrayList<>() : rows);
        response.put("hasMore", hasMore);
        if (cancelled) {
            response.put("cancelled", true);
        }
        return response;
    }

    private void respondUpdate(long id, int recordsAffected) {
        Map<String, Object> response = ok();
        response.put("kind", "update");
        response.put("recordsAffected", recordsAffected);
        respond(id, response);
    }

    private static Map<String, Object> queryCancelled() {
        Map<String, Object> response = ok();
        response.put("kind", "query");
        response.put("columns", new ArrayList<>());
        response.put("rows", new ArrayList<>());
        response.put("recordsAffected", -1);
        response.put("cancelled", true);
        return response;
    }

    private void bindParams(PreparedStatement prepared, List<Object> params) throws SQLException {
        for (int index = 0; index < params.size(); index++) {
            Object value = params.get(index);
            int position = index + 1;
            if (value == null) {
                prepared.setNull(position, Types.NULL);
            } else if (value instanceof Boolean) {
                prepared.setBoolean(position, (Boolean) value);
            } else if (value instanceof Integer) {
                prepared.setInt(position, (Integer) value);
            } else if (value instanceof Long) {
                prepared.setLong(position, (Long) value);
            } else if (value instanceof Double) {
                prepared.setDouble(position, (Double) value);
            } else {
                prepared.setString(position, value.toString());
            }
        }
    }

    private static Object readValue(ResultSet resultSet, int index) throws SQLException {
        ResultSetMetaData meta = resultSet.getMetaData();
        int sqlType = meta.getColumnType(index);
        Object value = resultSet.getObject(index);
        if (value == null || resultSet.wasNull()) {
            return null;
        }

        switch (sqlType) {
            case Types.BOOLEAN:
            case Types.BIT:
                return resultSet.getBoolean(index);
            case Types.TINYINT:
            case Types.SMALLINT:
            case Types.INTEGER:
                return resultSet.getInt(index);
            case Types.BIGINT:
                return resultSet.getLong(index);
            case Types.REAL:
            case Types.FLOAT:
            case Types.DOUBLE:
                return resultSet.getDouble(index);
            case Types.DECIMAL:
            case Types.NUMERIC: {
                BigDecimal decimal = resultSet.getBigDecimal(index);
                if (decimal == null) {
                    return null;
                }
                int scale = meta.getScale(index);
                if (scale <= 0 && decimal.precision() <= 18) {
                    return decimal.longValue();
                }
                return decimal.doubleValue();
            }
            case Types.DATE: {
                java.sql.Date date = resultSet.getDate(index);
                return date == null ? null : DATE_FORMATTER.format(date.toLocalDate());
            }
            case Types.TIME: {
                java.sql.Time time = resultSet.getTime(index);
                return time == null ? null : TIME_FORMATTER.format(time.toLocalTime());
            }
            case Types.TIMESTAMP: {
                Timestamp timestamp = resultSet.getTimestamp(index);
                return timestamp == null ? null : TIMESTAMP_FORMATTER.format(timestamp.toLocalDateTime());
            }
            case Types.BINARY:
            case Types.VARBINARY:
            case Types.LONGVARBINARY: {
                byte[] bytes = resultSet.getBytes(index);
                return bytes == null ? null : Base64.getEncoder().encodeToString(bytes);
            }
            case Types.BLOB: {
                java.sql.Blob blob = resultSet.getBlob(index);
                if (blob == null) {
                    return null;
                }
                long length = blob.length();
                if (length <= 0) {
                    return "";
                }
                byte[] bytes = blob.getBytes(1, (int) Math.min(length, Integer.MAX_VALUE));
                return Base64.getEncoder().encodeToString(bytes);
            }
            case Types.CLOB:
            case Types.NCLOB: {
                java.sql.Clob clob = resultSet.getClob(index);
                return clob == null ? null : clob.getSubString(1, (int) Math.min(clob.length(), Integer.MAX_VALUE));
            }
            default:
                return resultSet.getString(index);
        }
    }

    // ----------------------------------------------------------- metadata

    private void respondMetadata(long id, String kind, Connection conn, String table, boolean serverSide)
            throws SQLException {
        switch (kind) {
            case "databases":
                respondRows(id, new String[] { "DATABASE" },
                        new Object[][] { new Object[] { "default" } });
                break;
            case "schemas":
                respondRows(id, new String[] { "SCHEMA" }, new Object[][] {});
                break;
            case "tables":
                respondObjectList(id, conn, new String[] { "TABLE" });
                break;
            case "views":
                respondObjectList(id, conn, new String[] { "VIEW" });
                break;
            case "object_type":
                respondObjectList(id, conn, new String[] { table == null ? "TABLE" : table });
                break;
            case "type_groups":
                respondRows(id, new String[] { "OBJTYPE" },
                        new Object[][] { new Object[] { "TABLE" }, new Object[] { "VIEW" } });
                break;
            case "procedures":
                respondRows(id, new String[] { "OBJNAME" }, new Object[][] {});
                break;
            case "columns":
                respondColumns(id, conn, table);
                break;
            case "table_columns":
                respondDetailedColumns(id, conn, table, false);
                break;
            case "column_metadata":
                respondDetailedColumns(id, conn, table, true);
                break;
            case "table_comment":
                respondTableComment(id, conn, table);
                break;
            case "object_search":
                respondObjectSearch(id, conn, table);
                break;
            case "view_source_search":
                respondViewSourceSearch(id, conn, table, serverSide);
                break;
            case "procedure_source_search":
                respondRows(id, new String[] { "NAME", "SCHEMA", "DATABASE", "SOURCE" }, new Object[][] {});
                break;
            default:
                throw new IllegalArgumentException("Unknown metadata kind '" + kind + "'");
        }
    }

    private void respondObjectList(long id, Connection conn, String[] types)
            throws SQLException {
        List<String> columns = new ArrayList<>();
        List<List<Object>> rows = new ArrayList<>();
        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet objects = meta.getTables(null, null, "%", types)) {
            columns.add("OBJNAME");
            columns.add("OBJID");
            columns.add("OBJTYPE");
            columns.add("SCHEMA");
            columns.add("DESCRIPTION");
            while (objects.next()) {
                String name = objects.getString("TABLE_NAME");
                if (name != null && (name.startsWith("MSys") || name.startsWith("_Access"))) {
                    continue;
                }
                String objectType = normalizeObjectType(objects.getString("TABLE_TYPE"));
                List<Object> row = new ArrayList<>();
                row.add(name);
                row.add(name);
                row.add(objectType);
                row.add(null);
                row.add(objects.getString("REMARKS"));
                rows.add(row);
            }
        }
        respond(id, rowsResponse(columns, rows));
    }

    private static String normalizeObjectType(String rawType) {
        if (rawType == null) {
            return "TABLE";
        }
        String upper = rawType.toUpperCase();
        if (upper.contains("VIEW")) {
            return "VIEW";
        }
        if (upper.contains("SYSTEM")) {
            return "TABLE";
        }
        return "TABLE";
    }

    private void respondColumns(long id, Connection conn, String table) throws SQLException {
        String[] columns = { "DATABASE", "SCHEMA", "TABLENAME", "ATTNAME", "FORMAT_TYPE",
                "DESCRIPTION", "IS_PK", "IS_FK", "ATTNUM" };
        List<List<Object>> rows = new ArrayList<>();
        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet keys = meta.getPrimaryKeys(null, null, table)) {
            List<String> primaryKeys = new ArrayList<>();
            while (keys.next()) {
                primaryKeys.add(keys.getString("COLUMN_NAME"));
            }
            try (ResultSet cols = meta.getColumns(null, null, table, "%")) {
                int attnum = 0;
                while (cols.next()) {
                    String columnName = cols.getString("COLUMN_NAME");
                    if (columnName == null) {
                        continue;
                    }
                    attnum++;
                    boolean isPrimary = primaryKeys.contains(columnName);
                    List<Object> row = new ArrayList<>();
                    row.add("default");
                    row.add(null);
                    row.add(table);
                    row.add(columnName);
                    row.add(cols.getString("TYPE_NAME"));
                    row.add(cols.getString("REMARKS"));
                    row.add(isPrimary ? 1 : 0);
                    row.add(0);
                    row.add(attnum);
                    rows.add(row);
                }
            }
        }
        respond(id, rowsResponse(Arrays.asList(columns), rows));
    }

    private void respondDetailedColumns(long id, Connection conn, String table, boolean includeMetadataFlag)
            throws SQLException {
        String[] columns = { "ATTNAME", "FORMAT_TYPE", "FULL_TYPE", "IS_NOT_NULL", "COLDEFAULT",
                "DESCRIPTION", "IS_PK", "IS_FK", "ATTNUM" };
        if (includeMetadataFlag) {
            columns = new String[] { "ATTNAME", "FORMAT_TYPE", "FULL_TYPE", "ATTNOTNULL", "IS_NOT_NULL",
                    "COLDEFAULT", "DESCRIPTION", "IS_PK", "IS_FK", "ATTNUM" };
        }
        List<List<Object>> rows = new ArrayList<>();
        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet keys = meta.getPrimaryKeys(null, null, table)) {
            List<String> primaryKeys = new ArrayList<>();
            while (keys.next()) {
                primaryKeys.add(keys.getString("COLUMN_NAME"));
            }
            try (ResultSet cols = meta.getColumns(null, null, table, "%")) {
                int attnum = 0;
                while (cols.next()) {
                    String columnName = cols.getString("COLUMN_NAME");
                    if (columnName == null) {
                        continue;
                    }
                    attnum++;
                    boolean isPrimary = primaryKeys.contains(columnName);
                    int nullable = cols.getInt("NULLABLE");
                    boolean notNull = nullable == java.sql.DatabaseMetaData.columnNoNulls;
                    String formatType = cols.getString("TYPE_NAME");
                    String columnDefault = cols.getString("COLUMN_DEF");
                    List<Object> row = new ArrayList<>();
                    row.add(columnName);
                    row.add(formatType);
                    row.add(formatType);
                    row.add(notNull ? 1 : 0);
                    row.add(columnDefault);
                    row.add(cols.getString("REMARKS"));
                    row.add(isPrimary ? 1 : 0);
                    row.add(0);
                    row.add(attnum);
                    rows.add(row);
                }
            }
        }
        respond(id, rowsResponse(Arrays.asList(columns), rows));
    }

    private void respondTableComment(long id, Connection conn, String table) throws SQLException {
        DatabaseMetaData meta = conn.getMetaData();
        String description = null;
        try (ResultSet objects = meta.getTables(null, null, table, null)) {
            if (objects.next()) {
                description = objects.getString("REMARKS");
            }
        }
        respondRows(id, new String[] { "DESCRIPTION" },
                new Object[][] { new Object[] { description == null ? "" : description } });
    }

    private void respondObjectSearch(long id, Connection conn, String pattern) throws SQLException {
        String[] columns = { "PRIORITY", "NAME", "SCHEMA", "DATABASE", "TYPE", "PARENT",
                "DESCRIPTION", "MATCH_TYPE" };
        List<List<Object>> rows = new ArrayList<>();
        String likePattern = normalizeLikePattern(pattern);

        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet objects = meta.getTables(null, null, "%",
                new String[] { "TABLE", "VIEW" })) {
            while (objects.next()) {
                String name = objects.getString("TABLE_NAME");
                if (name == null || name.startsWith("MSys") || name.startsWith("_Access")) {
                    continue;
                }
                if (matchesPattern(name, likePattern)) {
                    List<Object> row = new ArrayList<>();
                    row.add(1);
                    row.add(name);
                    row.add(null);
                    row.add("default");
                    row.add(normalizeObjectType(objects.getString("TABLE_TYPE")));
                    row.add(null);
                    row.add(objects.getString("REMARKS"));
                    row.add("NAME");
                    rows.add(row);
                }
            }
        }
        respond(id, rowsResponse(Arrays.asList(columns), rows));
    }

    private void respondViewSourceSearch(long id, Connection conn, String table, boolean serverSide)
            throws SQLException {
        String[] columns = serverSide
                ? new String[] { "NAME", "SCHEMA", "DATABASE" }
                : new String[] { "NAME", "SCHEMA", "DATABASE", "SOURCE" };
        List<List<Object>> rows = new ArrayList<>();
        String likePattern = normalizeLikePattern(table);

        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet objects = meta.getTables(null, null, "%",
                new String[] { "VIEW" })) {
            while (objects.next()) {
                String name = objects.getString("TABLE_NAME");
                if (name == null || name.startsWith("MSys") || name.startsWith("_Access")) {
                    continue;
                }
                if (serverSide && !matchesPattern(name, likePattern)) {
                    continue;
                }
                List<Object> row = new ArrayList<>();
                row.add(name);
                row.add(null);
                row.add("default");
                if (!serverSide) {
                    row.add(describeView(name));
                }
                rows.add(row);
            }
        }
        respond(id, rowsResponse(Arrays.asList(columns), rows));
    }

    private static String describeView(String name) {
        return "CREATE VIEW " + name + " AS SELECT * FROM " + name;
    }

    private static String normalizeLikePattern(String rawPattern) {
        if (rawPattern == null) {
            return "";
        }
        return rawPattern.replaceAll("(?i)%", "").replaceAll("(?i)_", "");
    }

    private static boolean matchesPattern(String value, String likePattern) {
        if (likePattern.isEmpty()) {
            return true;
        }
        return value != null && value.toUpperCase().contains(likePattern.toUpperCase());
    }

    private void respondRows(long id, String[] columnNames, Object[][] data) {
        List<String> columns = new ArrayList<>();
        for (String columnName : columnNames) {
            columns.add(columnName);
        }
        List<List<Object>> rows = new ArrayList<>();
        for (Object[] rowData : data) {
            List<Object> row = new ArrayList<>();
            for (Object value : rowData) {
                row.add(value);
            }
            rows.add(row);
        }
        respond(id, rowsResponse(columns, rows));
    }

    private static Map<String, Object> rowsResponse(List<String> columns, List<List<Object>> rows) {
        Map<String, Object> response = ok();
        response.put("kind", "metadata");
        List<Map<String, Object>> columnDefs = new ArrayList<>();
        for (String name : columns) {
            Map<String, Object> column = new LinkedHashMap<>();
            column.put("name", name);
            column.put("type", "TEXT");
            columnDefs.add(column);
        }
        response.put("columns", columnDefs);
        response.put("rows", rows);
        return response;
    }

    // -------------------------------------------------------------- infra

    private synchronized Connection requireConnection() throws SQLException {
        Connection conn = connection;
        if (conn != null) {
            try {
                if (!conn.isClosed()) {
                    return conn;
                }
            } catch (SQLException ignored) {
                // Treat an unusable JDBC handle the same as a closed one.
            }
        }
        if (databasePath == null) {
            throw new IllegalStateException("Not connected to a Microsoft Access database.");
        }

        // A UCanAccess collation failure can close the JDBC connection while
        // leaving this bridge process alive. Reopen it lazily for the next
        // request so a failed import does not make subsequent SELECTs unusable.
        closeConnectionQuietly();
        try {
            connection = openConnection(databasePath, databasePassword == null ? "" : databasePassword, databaseReadOnly);
            return connection;
        } catch (Exception error) {
            throw new SQLException("Access connection was closed and could not be reopened: "
                    + throwableMessage(error), error);
        }
    }

    /**
     * UCanAccess may report a failed commit as a closed HSQLDB connection while
     * the JDBC wrapper still returns false from {@code isClosed()}. Clear that
     * unusable handle so the next request takes the lazy reconnect path.
     */
    private void invalidateClosedConnection(Throwable error) {
        if (isClosedConnectionError(error)) {
            closeConnectionQuietly();
        }
    }

    private static boolean isClosedConnectionError(Throwable error) {
        Throwable current = error;
        int depth = 0;
        while (current != null && depth++ < 32) {
            String message = current.getMessage();
            if (message != null) {
                String normalized = message.toLowerCase(java.util.Locale.ROOT);
                if (normalized.contains("connection exception: closed")
                        || normalized.contains("connection is closed")
                        || normalized.contains("connection was closed")
                        || normalized.contains("unsupported collating sort order")
                        || normalized.contains("cannot write indexes of this type")) {
                    return true;
                }
            }
            current = current.getCause();
        }
        return false;
    }

    private void closeConnectionQuietly() {
        Connection conn = connection;
        connection = null;
        if (conn != null) {
            try {
                conn.close();
            } catch (SQLException ignored) {
                // Connection cleanup is best effort.
            }
        }
        for (Long cursorId : new ArrayList<>(activeCursors.keySet())) {
            closeCursor(cursorId);
        }
        activeStatements.clear();
    }

    private void shutdown() {
        if (!closing.compareAndSet(false, true)) {
            return;
        }
        closeConnectionQuietly();
        worker.shutdownNow();
    }

    private void respond(long id, Map<String, Object> response) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("id", id);
        envelope.putAll(response);
        synchronized (out) {
            out.println(Json.encode(envelope));
        }
    }

    private static Map<String, Object> ok() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        return response;
    }

    private static Map<String, Object> error(String message) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", false);
        response.put("error", message);
        return response;
    }

    private static String throwableMessage(Throwable throwable) {
        String message = throwable.getMessage();
        if (message != null && !message.isEmpty()) {
            return message;
        }
        return throwable.toString();
    }

    private static void closeQuietly(Statement statement) {
        if (statement != null) {
            try {
                statement.close();
            } catch (SQLException ignored) {
                // Best effort close.
            }
        }
    }

    private static void log(String message) {
        System.err.println(message);
    }

    // ---------------------------------------------------------------- JSON

    /**
     * Minimal JSON support tailored to this bridge. Only the primitive subset
     * needed by the protocol is handled: objects, arrays, strings, numbers,
     * booleans and null.
     */
    private static final class Json {

        private Json() {
        }

        static String encode(Object value) {
            StringBuilder builder = new StringBuilder();
            append(builder, value);
            return builder.toString();
        }

        private static void append(StringBuilder builder, Object value) {
            if (value == null) {
                builder.append("null");
            } else if (value instanceof Boolean) {
                builder.append(value);
            } else if (value instanceof Double || value instanceof Float) {
                double number = ((Number) value).doubleValue();
                if (Double.isNaN(number) || Double.isInfinite(number)) {
                    builder.append("null");
                } else {
                    builder.append(number);
                }
            } else if (value instanceof Number) {
                builder.append(value);
            } else if (value instanceof Map) {
                builder.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (!first) {
                        builder.append(',');
                    }
                    first = false;
                    appendString(builder, String.valueOf(entry.getKey()));
                    builder.append(':');
                    append(builder, entry.getValue());
                }
                builder.append('}');
            } else if (value instanceof List) {
                builder.append('[');
                boolean first = true;
                for (Object item : (List<?>) value) {
                    if (!first) {
                        builder.append(',');
                    }
                    first = false;
                    append(builder, item);
                }
                builder.append(']');
            } else {
                appendString(builder, value.toString());
            }
        }

        private static void appendString(StringBuilder builder, String value) {
            builder.append('"');
            for (int index = 0; index < value.length(); index++) {
                char c = value.charAt(index);
                switch (c) {
                    case '"':
                        builder.append("\\\"");
                        break;
                    case '\\':
                        builder.append("\\\\");
                        break;
                    case '\n':
                        builder.append("\\n");
                        break;
                    case '\r':
                        builder.append("\\r");
                        break;
                    case '\t':
                        builder.append("\\t");
                        break;
                    case '\b':
                        builder.append("\\b");
                        break;
                    case '\f':
                        builder.append("\\f");
                        break;
                    default:
                        if (c < 0x20) {
                            builder.append(String.format("\\u%04x", (int) c));
                        } else {
                            builder.append(c);
                        }
                        break;
                }
            }
            builder.append('"');
        }

        static Object parse(String text) {
            return new Parser(text).parseDocument();
        }

        static String stringValue(Object value, String fallback) {
            return value instanceof String ? (String) value : fallback;
        }

        static boolean booleanValue(Object value, boolean fallback) {
            return value instanceof Boolean ? (Boolean) value : fallback;
        }

        static long longValue(Object value, long fallback) {
            return value instanceof Number ? ((Number) value).longValue() : fallback;
        }

        static int intValue(Object value, int fallback) {
            return value instanceof Number ? ((Number) value).intValue() : fallback;
        }

        @SuppressWarnings("unchecked")
        static List<Object> listValue(Object value) {
            return value instanceof List ? (List<Object>) value : new ArrayList<>();
        }

        private static final class Parser {
            private final String text;
            private int position;

            Parser(String text) {
                this.text = text;
            }

            Object parseDocument() {
                skipWhitespace();
                Object value = parseValue();
                skipWhitespace();
                if (position < text.length()) {
                    throw new IllegalArgumentException("Unexpected trailing characters at index " + position);
                }
                return value;
            }

            private Object parseValue() {
                skipWhitespace();
                if (position >= text.length()) {
                    throw new IllegalArgumentException("Unexpected end of input");
                }
                char c = text.charAt(position);
                switch (c) {
                    case '{':
                        return parseObject();
                    case '[':
                        return parseArray();
                    case '"':
                        return parseString();
                    case 't':
                        expectLiteral("true");
                        return Boolean.TRUE;
                    case 'f':
                        expectLiteral("false");
                        return Boolean.FALSE;
                    case 'n':
                        expectLiteral("null");
                        return null;
                    default:
                        return parseNumber();
                }
            }

            private Map<String, Object> parseObject() {
                Map<String, Object> result = new LinkedHashMap<>();
                position++;
                skipWhitespace();
                if (peek() == '}') {
                    position++;
                    return result;
                }
                while (true) {
                    skipWhitespace();
                    String key = parseString();
                    skipWhitespace();
                    expect(':');
                    Object value = parseValue();
                    result.put(key, value);
                    skipWhitespace();
                    char c = peek();
                    if (c == ',') {
                        position++;
                    } else if (c == '}') {
                        position++;
                        return result;
                    } else {
                        throw new IllegalArgumentException("Expected ',' or '}' at index " + position);
                    }
                }
            }

            private List<Object> parseArray() {
                List<Object> result = new ArrayList<>();
                position++;
                skipWhitespace();
                if (peek() == ']') {
                    position++;
                    return result;
                }
                while (true) {
                    Object value = parseValue();
                    result.add(value);
                    skipWhitespace();
                    char c = peek();
                    if (c == ',') {
                        position++;
                    } else if (c == ']') {
                        position++;
                        return result;
                    } else {
                        throw new IllegalArgumentException("Expected ',' or ']' at index " + position);
                    }
                }
            }

            private String parseString() {
                if (peek() != '"') {
                    throw new IllegalArgumentException("Expected string at index " + position);
                }
                position++;
                StringBuilder builder = new StringBuilder();
                while (true) {
                    if (position >= text.length()) {
                        throw new IllegalArgumentException("Unterminated string");
                    }
                    char c = text.charAt(position);
                    if (c == '"') {
                        position++;
                        return builder.toString();
                    }
                    if (c == '\\') {
                        position++;
                        if (position >= text.length()) {
                            throw new IllegalArgumentException("Unterminated escape sequence");
                        }
                        char escaped = text.charAt(position);
                        switch (escaped) {
                            case '"':
                                builder.append('"');
                                break;
                            case '\\':
                                builder.append('\\');
                                break;
                            case '/':
                                builder.append('/');
                                break;
                            case 'b':
                                builder.append('\b');
                                break;
                            case 'f':
                                builder.append('\f');
                                break;
                            case 'n':
                                builder.append('\n');
                                break;
                            case 'r':
                                builder.append('\r');
                                break;
                            case 't':
                                builder.append('\t');
                                break;
                            case 'u':
                                builder.append(parseUnicodeEscape());
                                break;
                            default:
                                throw new IllegalArgumentException("Invalid escape '\\" + escaped + "'");
                        }
                        position++;
                    } else {
                        builder.append(c);
                        position++;
                    }
                }
            }

            private char parseUnicodeEscape() {
                if (position + 5 > text.length()) {
                    throw new IllegalArgumentException("Invalid unicode escape");
                }
                String hex = text.substring(position + 1, position + 5);
                position += 4;
                try {
                    return (char) Integer.parseInt(hex, 16);
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("Invalid unicode escape '\\u" + hex + "'");
                }
            }

            private Object parseNumber() {
                int start = position;
                if (peek() == '-') {
                    position++;
                }
                while (position < text.length()) {
                    char c = text.charAt(position);
                    if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                        position++;
                    } else {
                        break;
                    }
                }
                String raw = text.substring(start, position);
                if (raw.isEmpty()) {
                    throw new IllegalArgumentException("Expected number at index " + start);
                }
                try {
                    if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
                        return Double.parseDouble(raw);
                    }
                    return Long.parseLong(raw);
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("Invalid number '" + raw + "'");
                }
            }

            private void expectLiteral(String literal) {
                if (!text.startsWith(literal, position)) {
                    throw new IllegalArgumentException("Expected '" + literal + "' at index " + position);
                }
                position += literal.length();
            }

            private void expect(char expected) {
                skipWhitespace();
                if (position >= text.length() || text.charAt(position) != expected) {
                    throw new IllegalArgumentException("Expected '" + expected + "' at index " + position);
                }
                position++;
            }

            private char peek() {
                skipWhitespace();
                if (position >= text.length()) {
                    throw new IllegalArgumentException("Unexpected end of input");
                }
                return text.charAt(position);
            }

            private void skipWhitespace() {
                while (position < text.length()) {
                    char c = text.charAt(position);
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                        position++;
                    } else {
                        break;
                    }
                }
            }
        }
    }
}
