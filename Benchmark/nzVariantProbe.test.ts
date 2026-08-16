import { Readable } from 'stream';
import { NzConnection } from '@justybase/netezza-driver';

function buildSql(table: string, file: string): string {
    return `INSERT INTO "ADMIN"."${table}" ("ID", "NAME")
SELECT
        "ID", "NAME"
FROM EXTERNAL '${file}'
(
        "ID" BIGINT,
        "NAME" NVARCHAR(1024)
)
    USING
    (
        REMOTESOURCE 'jdbc'
        DELIMITER '\\t'
        RecordDelim '\\n'
        ESCAPECHAR '\\'
        NULLVALUE ''
        ENCODING 'Utf-8'
        TIMESTYLE '24hour'
        BOOLSTYLE '1_0'
        SKIPROWS 0
        MAXERRORS 1
        COMPRESS FALSE
        LOGDIR '/tmp/netezza_migration_logs'
    );`;
}

async function run(connection: NzConnection, table: string, file: string, stream: Readable): Promise<void> {
    const ctor = NzConnection as unknown as { registerImportStream(id: string, s: Readable): void; unregisterImportStream(id: string): void };
    ctor.registerImportStream(file, stream);
    const cmd = connection.createCommand(buildSql(table, file));
    cmd.commandTimeout = 120;
    try {
        await cmd.execute();
        console.log(`${table}: LOAD OK`);
    } catch (error) {
        console.log(`${table}: LOAD failed:`, error instanceof Error ? error.message : String(error));
    } finally {
        ctor.unregisterImportStream(file);
    }
}

class PerRowReadable extends Readable {
    private lines: string[];
    private index = 0;
    constructor(lines: string[]) {
        super({ objectMode: true, highWaterMark: 65536 });
        this.lines = lines;
    }
    _read(): void {
        if (this.index >= this.lines.length) {
            this.push(null);
            return;
        }
        setTimeout(() => {
            this.push(this.lines[this.index]);
            this.index++;
        }, 0);
    }
}

class BufferedPacedReadable extends Readable {
    private buffered: string[] = [];
    private isReading = false;
    constructor(lines: string[]) {
        super({ objectMode: true, highWaterMark: 65536 });
        this.buffered = lines;
    }
    _read(): void {
        if (this.buffered.length > 0) {
            this.push(this.buffered.shift() as string);
            if (this.buffered.length > 0) {
                setImmediate(() => this._read(0));
            }
            return;
        }
        this.push(null);
    }
}

describe('nz variant probe', () => {
    it('tests per-row vs buffered-paced at 1000 rows', async () => {
        const nz = new NzConnection({
            host: process.env.NZ_DEV_HOST || '192.168.0.144',
            port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
            database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
            user: process.env.NZ_DEV_USER || 'admin',
            password: process.env.NZ_DEV_PASSWORD || '',
        });
        await nz.connect();
        const lines: string[] = [];
        for (let i = 0; i < 1000; i++) {
            lines.push(`${i}\tName ${i}\n`);
        }
        const variants: Array<[string, () => Readable]> = [
            ['per-row-timeout', () => new PerRowReadable(lines)],
            ['buffered-paced', () => new BufferedPacedReadable(lines)],
        ];
        for (const [name, factory] of variants) {
            const table = `JBL_VAR_${name}_${Date.now()}`.toUpperCase();
            await nz.createCommand(`CREATE TABLE ADMIN.${table} ("ID" BIGINT, "NAME" NVARCHAR(1024))`).execute();
            await run(nz, table, `virtual_var_${name}_${Date.now()}.txt`, factory());
            await nz.createCommand(`DROP TABLE ADMIN.${table}`).execute().catch(() => undefined);
        }
        await nz.close();
    }, 300000);
});
