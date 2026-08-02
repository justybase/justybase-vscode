import { Readable } from "node:stream";
import {
  MysqlStreamingDataReader,
  mysqlColumnTypeName,
} from "../../extensions/mysql/src/mysqlConnection";

describe("MysqlStreamingDataReader", () => {
  it("maps FieldPacket types even when the result has no rows", () => {
    const stream = new Readable({ objectMode: true, read() { return undefined; } });
    const reader = new MysqlStreamingDataReader(
      stream as never,
      [
        { name: "budget", columnType: 246 },
        { name: "count", columnType: 8 },
      ],
    );
    stream.push(null);

    return expect(reader.read()).resolves.toBe(false).then(() => {
      expect(reader.fieldCount).toBe(2);
      expect(reader.getTypeName(0)).toBe("DECIMAL");
      expect(reader.getTypeName(1)).toBe("BIGINT");
    });
  });

  it("reads rows incrementally and destroys the native stream on close", async () => {
    const stream = new Readable({ objectMode: true, read() { return undefined; } });
    const reader = new MysqlStreamingDataReader(
      stream as never,
      [{ name: "id", columnType: 3 }],
    );
    stream.push([1]);
    stream.push([2]);

    expect(await reader.read()).toBe(true);
    expect(reader.getValue(0)).toBe(1);
    expect(await reader.read()).toBe(true);
    expect(reader.getValue(0)).toBe(2);

    const destroySpy = jest.spyOn(stream, "destroy");
    await reader.close();
    expect(destroySpy).toHaveBeenCalled();
  });

  it("covers the MySQL protocol numeric types used by metadata and result panels", () => {
    expect(mysqlColumnTypeName(0)).toBe("DECIMAL");
    expect(mysqlColumnTypeName(246)).toBe("DECIMAL");
    expect(mysqlColumnTypeName(245)).toBe("JSON");
    expect(mysqlColumnTypeName(252)).toBe("BLOB");
  });
});
