import io.github.spannm.jackcess.*;
import java.io.File;
import java.util.List;

/**
 * Machine-readable dump used by the read-parity cross-check. Jackcess is an
 * independent implementation of the Access file format, so comparing its view
 * of a real .mdb/.accdb file with the JustyBase reader catches decoding
 * regressions in tables, columns, indexes and cell values.
 *
 * Output is tab-separated, one record per line. Names and string values are
 * escaped (backslash, tab, CR, LF) so a record never spans lines. All text is
 * written as UTF-8; pass -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8.
 *
 *   TABLE  <name> <rowCount>
 *   COLUMN <table> <name> <type> <length> <lengthInUnits> <precision> <scale> <autoNumber> <required> <default> <allowZeroLength> <validationRule> <validationText>
 *   INDEX  <table> <name> <primaryKey> <unique> <required> <ignoreNulls> <col1+,-col2...>
 *   ROW    <table> <value>...
 *
 * Required, default, allowZeroLength and the validation pair are read from the
 * column property map, which is how Access stores them; all are compared by
 * the read-parity gate.
 *
 * Usage: java -cp <jackcess jars>:classes ParityDump <path-to-mdb-or-accdb>
 */
public final class ParityDump {

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("Usage: ParityDump <path-to-mdb-or-accdb>");
            System.exit(2);
        }
        File file = new File(args[0]);
        if (!file.isFile()) {
            System.err.println("File not found: " + args[0]);
            System.exit(2);
        }

        try (Database db = new DatabaseBuilder(file).withReadOnly(true).open()) {
            for (String tableName : db.getTableNames()) {
                Table table = db.getTable(tableName);
                System.out.println("TABLE\t" + escape(tableName) + "\t" + table.getRowCount());

                for (Column column : table.getColumns()) {
                    String required = "";
                    String defaultValue = "";
                    String allowZeroLength = "";
                    String validationRule = "";
                    String validationText = "";
                    try {
                        PropertyMap properties = column.getProperties();
                        if (properties != null) {
                            // `getValue` falls back to the Access default when
                            // the property is absent, so check whether the
                            // property is actually stored before reporting it.
                            if (properties.get(PropertyMap.REQUIRED_PROP) != null) {
                                Object value = properties.getValue(PropertyMap.REQUIRED_PROP);
                                required = value == null ? "" : value.toString();
                            }
                            if (properties.get(PropertyMap.DEFAULT_VALUE_PROP) != null) {
                                Object value = properties.getValue(PropertyMap.DEFAULT_VALUE_PROP);
                                defaultValue = value == null ? "" : value.toString();
                            }
                            if (properties.get(PropertyMap.ALLOW_ZERO_LEN_PROP) != null) {
                                Object value = properties.getValue(PropertyMap.ALLOW_ZERO_LEN_PROP);
                                allowZeroLength = value == null ? "" : value.toString();
                            }
                            if (properties.get(PropertyMap.VALIDATION_RULE_PROP) != null) {
                                Object value = properties.getValue(PropertyMap.VALIDATION_RULE_PROP);
                                validationRule = value == null ? "" : value.toString();
                            }
                            if (properties.get(PropertyMap.VALIDATION_TEXT_PROP) != null) {
                                Object value = properties.getValue(PropertyMap.VALIDATION_TEXT_PROP);
                                validationText = value == null ? "" : value.toString();
                            }
                        }
                    } catch (Exception ignored) {
                        // Property metadata is optional; keep the column row.
                    }
                    System.out.println("COLUMN\t" + escape(tableName)
                        + "\t" + escape(column.getName())
                        + "\t" + column.getType().name()
                        + "\t" + column.getLength()
                        + "\t" + column.getLengthInUnits()
                        + "\t" + column.getPrecision()
                        + "\t" + column.getScale()
                        + "\t" + column.isAutoNumber()
                        + "\t" + escape(required)
                        + "\t" + escape(defaultValue)
                        + "\t" + escape(allowZeroLength)
                        + "\t" + escape(validationRule)
                        + "\t" + escape(validationText));
                }

                for (Index index : table.getIndexes()) {
                    StringBuilder columns = new StringBuilder();
                    for (Index.Column indexColumn : index.getColumns()) {
                        if (columns.length() > 0) {
                            columns.append(',');
                        }
                        columns.append(escape(indexColumn.getName()));
                        columns.append(indexColumn.isAscending() ? '+' : '-');
                    }
                    System.out.println("INDEX\t" + escape(tableName)
                        + "\t" + escape(index.getName())
                        + "\t" + index.isPrimaryKey()
                        + "\t" + index.isUnique()
                        + "\t" + index.isRequired()
                        + "\t" + index.shouldIgnoreNulls()
                        + "\t" + columns);
                }

                List<String> columnNames = new java.util.ArrayList<>();
                for (Column column : table.getColumns()) {
                    columnNames.add(column.getName());
                }
                for (Row row : table) {
                    StringBuilder line = new StringBuilder("ROW\t").append(escape(tableName));
                    for (String columnName : columnNames) {
                        line.append('\t').append(escape(format(row.get(columnName))));
                    }
                    System.out.println(line);
                }
            }
        }
    }

    private static String format(Object value) {
        if (value == null) {
            return "NULL";
        }
        if (value instanceof byte[]) {
            return "BIN:" + toHex((byte[]) value);
        }
        if (value instanceof java.time.LocalDateTime) {
            return "DT:" + value;
        }
        if (value instanceof java.math.BigDecimal) {
            return "DEC:" + ((java.math.BigDecimal) value).toPlainString();
        }
        if (value instanceof Boolean) {
            return ((Boolean) value) ? "TRUE" : "FALSE";
        }
        if (value instanceof Number || value instanceof String || value instanceof java.util.UUID) {
            return value.toString();
        }
        return String.valueOf(value);
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': escaped.append("\\\\"); break;
                case '\t': escaped.append("\\t"); break;
                case '\r': escaped.append("\\r"); break;
                case '\n': escaped.append("\\n"); break;
                default: escaped.append(c);
            }
        }
        return escaped.toString();
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }
}
