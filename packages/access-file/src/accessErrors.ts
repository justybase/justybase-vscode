export class AccessFileError extends Error {
    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'AccessFileError';
    }
}

export class AccessFileReadOnlyError extends AccessFileError {
    public constructor(filePath: string) {
        super(`Microsoft Access file is read-only: ${filePath}`);
        this.name = 'AccessFileReadOnlyError';
    }
}

/**
 * Thrown when a write is attempted through a password-protected file.  The
 * reader decrypts pages in memory, while the Jet writer mutates the raw file
 * buffer; writing encrypted pages would corrupt the database.
 */
export class AccessFileEncryptedWriteError extends AccessFileError {
    public constructor(filePath: string) {
        super(
            `Microsoft Access file is password-protected and cannot be written safely yet: ${filePath}. `
            + 'Remove the database password and reconnect, or open the file read-only.',
        );
        this.name = 'AccessFileEncryptedWriteError';
    }
}

/**
 * Thrown when the file on disk changed after it was opened and before a staged
 * write could be installed.  This prevents last-writer-wins overwrites of
 * changes made by Microsoft Access or another process.
 */
export class AccessFileChangedError extends AccessFileError {
    public constructor(filePath: string) {
        super(
            `Microsoft Access file changed on disk since it was opened: ${filePath}. `
            + 'Reconnect the connection to reload the current file before writing.',
        );
        this.name = 'AccessFileChangedError';
    }
}
