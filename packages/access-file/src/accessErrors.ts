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
