import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../utils/logger';

const TEMP_FILE_PREFIX = 'justybase-results-';

class TempFileRegistry {
    private readonly _files = new Map<string, string>();

    public register(storeId: string, filePath: string): void {
        this._files.set(storeId, filePath);
    }

    public unregister(storeId: string): void {
        this._files.delete(storeId);
    }

    public deleteFile(storeId: string): void {
        const filePath = this._files.get(storeId);
        if (!filePath) {
            return;
        }
        this._files.delete(storeId);
        this.tryUnlink(filePath);
    }

    public disposeAll(): void {
        for (const filePath of this._files.values()) {
            this.tryUnlink(filePath);
        }
        this._files.clear();
    }

    public cleanupOrphanedFiles(): void {
        const tmpDir = os.tmpdir();
        let entries: string[];
        try {
            entries = fs.readdirSync(tmpDir);
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.startsWith(TEMP_FILE_PREFIX) || !entry.endsWith('.db')) {
                continue;
            }
            const fullPath = path.join(tmpDir, entry);
            if ([...this._files.values()].includes(fullPath)) {
                continue;
            }
            this.tryUnlink(fullPath);
        }
    }

    private tryUnlink(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error) {
            getLogger().warn(`Failed to delete temp result file ${filePath}: ${error}`);
        }
    }
}

export const tempFileRegistry = new TempFileRegistry();
