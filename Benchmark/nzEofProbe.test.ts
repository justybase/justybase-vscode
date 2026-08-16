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

class DelayedEofReadable extends Readable {
    private buffered: string[] = [];
    private isReading = false;
    private eofScheduled = false;
    private eofSent = false;

    constructor(lines: string[]) {
        super({ objectMode: true, highWaterMark: 65536 });
        this.buffered = lines;
    }

    _read(): void {
        if (this.buffered.length > 0) {
            this.push(this.buffered.shift() as string);
            return;
        }
        if (!this.eofScheduled) {
            this.eofScheduled = true;
            setTimeout(() => {
                this.eofSent = true;
                this.push(null);
            }, 20);
            return;
        }
        if (!this.eofSent) return;
        this.push(null);
    }
}

describe('nz eof probe', () => {
    it('tests delayed EOF with 1000 rows', async () => {
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
        for (const variant of ['delayed-eof', 'sync-eof']) {
            const table = `JBL_EOF_${variant}_${Date.now()}`.toUpperCase();
            await nz.createCommand(`CREATE TABLE ADMIN.${table} ("ID" BIGINT, "NAME" NVARCHAR(1024))`).execute();
            let stream: Readable;
            if (variant === 'delayed-eof') {
                stream = new DelayedEofReadable(lines);
            } else {
                let idx = 0;
                stream = new Readable({ read() { if (idx >= lines.length) { this.push(null); return; } this.push(lines[idx]); idx++; } });
            }
            await run(nz, table, `virtual_eof_${variant}_${Date.now()}.txt`, stream);
            await nz.createCommand(`DROP TABLE ADMIN.${table}`).execute().catch(() => undefined);
        }
        await nz.close();
    }, 300000);
});
