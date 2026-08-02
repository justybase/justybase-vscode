import { EventEmitter } from 'node:events';
import { PostgreSqlStreamingDataReader } from '../../extensions/postgresql/src/postgresqlConnection';

class FakeQuery extends EventEmitter {
  public emitRow(row: unknown, result: unknown): void {
    this.emit('row', row, result);
  }
}

const pgWithTypes = {
  types: {
    builtins: {
      INT4: 23,
      TEXT: 25,
    },
  },
};

describe('PostgreSqlStreamingDataReader', () => {
  it('preserves column types even when a result is empty', async () => {
    const query = new FakeQuery();
    const source = {};
    const reader = new PostgreSqlStreamingDataReader(query as never, undefined);

    reader.setFields([
      { name: 'id', dataTypeID: 23 },
      { name: 'label', dataTypeID: 25 },
    ], source, pgWithTypes as never);
    reader.markComplete(source);
    query.emit('end', undefined);

    await expect(reader.read()).resolves.toBe(false);
    expect(reader.fieldCount).toBe(2);
    expect(reader.getName(0)).toBe('id');
    expect(reader.getTypeName(0)).toBe('INT4');
    expect(reader.getTypeName(1)).toBe('TEXT');
  });

  it('reads rows incrementally and advances across result sets', async () => {
    const query = new FakeQuery();
    const first = {};
    const second = {};
    const reader = new PostgreSqlStreamingDataReader(query as never, undefined);

    reader.setFields([{ name: 'id', dataTypeID: 23 }], first, pgWithTypes as never);
    query.emitRow([1], first);
    query.emitRow([2], first);
    reader.markComplete(first);
    reader.setFields([{ name: 'label', dataTypeID: 25 }], second, pgWithTypes as never);
    query.emitRow(['done'], second);
    reader.markComplete(second);
    query.emit('end', undefined);

    expect(await reader.read()).toBe(true);
    expect(reader.getValue(0)).toBe(1);
    expect(await reader.read()).toBe(true);
    expect(reader.getValue(0)).toBe(2);
    expect(await reader.read()).toBe(false);
    expect(await reader.nextResult()).toBe(true);
    expect(reader.getName(0)).toBe('label');
    expect(await reader.read()).toBe(true);
    expect(reader.getValue(0)).toBe('done');
    expect(await reader.read()).toBe(false);
    expect(await reader.nextResult()).toBe(false);
  });

  it('pauses at the queue boundary and cancels an active stream on close', async () => {
    const query = new FakeQuery();
    const socket = { pause: jest.fn(), resume: jest.fn() };
    const cancel = jest.fn(async () => undefined);
    const source = {};
    const reader = new PostgreSqlStreamingDataReader(query as never, socket, undefined, cancel);

    reader.setFields([{ name: 'id', dataTypeID: 23 }], source, pgWithTypes as never);
    for (let index = 0; index < 33; index += 1) {
      query.emitRow([index], source);
    }

    expect(socket.pause).toHaveBeenCalled();
    expect(await reader.read()).toBe(true);
    expect(await reader.read()).toBe(true);
    expect(socket.resume).toHaveBeenCalled();
    await reader.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
