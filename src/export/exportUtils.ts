import * as fs from 'fs';
import * as path from 'path';

/**
 * Validate export path before starting export.
 * Checks that the target directory exists and is writable.
 * @param outputPath Target file path for export
 * @throws Error if path is invalid or not writable
 */
export function validateExportPath(outputPath: string): void {
    const dir = path.dirname(outputPath);

    // Check if parent directory exists
    if (!fs.existsSync(dir)) {
        throw new Error(`Export directory does not exist: ${dir}`);
    }

    // Check write permission by attempting to create and remove a temp file
    const testFile = path.join(dir, `.export_write_test_${Date.now()}`);
    try {
        fs.writeFileSync(testFile, '');
        fs.unlinkSync(testFile);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Export directory is not writable: ${dir} (${msg})`, { cause: e });
    }
}
