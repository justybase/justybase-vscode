import io.github.spannm.jackcess.*;
import java.io.File;
import java.util.List;

/**
 * Dumps every non-system table of an Access database using Jackcess
 * (the original Java file-format library that the C# port and the
 * TypeScript writer are modeled on).
 *
 * Output format (tab-separated, one table per block):
 *   <tableName>\t<rowCount>
 *   <cell>[\t<cell>...]
 *
 * Values are formatted so they can be compared with the C# port dump:
 *   null -> NULL, byte[] -> BIN:<hex>, LocalDateTime -> DT:..., etc.
 *
 * Usage: java -cp <jackcess jars>:classes DumpFile <path>
 */
public final class DumpFile {

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("Usage: DumpFile <path-to-mdb-or-accdb>");
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
                StringBuilder line = new StringBuilder();
                for (Column col : table.getColumns()) {
                    if (line.length() > 0) {
                        line.append('\t');
                    }
                    line.append(col.getName());
                }
                System.out.println("COLUMNS\t" + line);
                System.out.println(tableName + "\t" + table.getRowCount());
                List<String> columnNames = new java.util.ArrayList<>();
                for (Column col : table.getColumns()) {
                    columnNames.add(col.getName());
                }
                for (Row row : table) {
                    StringBuilder sb = new StringBuilder();
                    for (String columnName : columnNames) {
                        if (sb.length() > 0) {
                            sb.append('\t');
                        }
                        sb.append(format(row.get(columnName)));
                    }
                    System.out.println(sb);
                }
                // dump every index in index order, so B-tree integrity is checked
                for (Index index : table.getIndexes()) {
                    StringBuilder indexHeader = new StringBuilder("INDEX\t" + tableName + "\t" + index.getName());
                    indexHeader.append("\tunique=").append(index.isUnique());
                    indexHeader.append("\tpk=").append(index.isPrimaryKey());
                    indexHeader.append("\tcols=");
                    boolean firstCol = true;
                    for (Index.Column idxCol : index.getColumns()) {
                        if (!firstCol) {
                            indexHeader.append(',');
                        }
                        indexHeader.append(idxCol.getName());
                        if (idxCol.isAscending()) {
                            indexHeader.append("+");
                        } else {
                            indexHeader.append("-");
                        }
                        firstCol = false;
                    }
                    System.out.println(indexHeader);
                    try {
                        Cursor cursor = table.newCursor().withIndexByName(index.getName()).toCursor();
                        for (Row row : cursor) {
                            StringBuilder sb = new StringBuilder();
                            for (String columnName : columnNames) {
                                if (sb.length() > 0) {
                                    sb.append('\t');
                                }
                                sb.append(format(row.get(columnName)));
                            }
                            System.out.println(sb);
                        }
                    } catch (Exception ex) {
                        System.out.println("INDEX_ERROR\t" + ex.getMessage());
                    }
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
            return "DT:" + ((java.time.LocalDateTime) value).toString();
        }
        if (value instanceof java.math.BigDecimal) {
            return "DEC:" + ((java.math.BigDecimal) value).toPlainString();
        }
        if (value instanceof Boolean) {
            return ((Boolean) value) ? "TRUE" : "FALSE";
        }
        if (value instanceof Number || value instanceof String) {
            return value.toString();
        }
        return String.valueOf(value);
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
