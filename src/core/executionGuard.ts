export type ExecutionCurrentCheck = () => boolean;

/** Raised when a forced recovery or document close retires an in-flight executor. */
export class ExecutionSupersededError extends Error {
    public constructor() {
        super('Query cancelled: execution superseded by a newer run');
        this.name = 'ExecutionSupersededError';
    }
}

export function assertExecutionCurrent(check?: ExecutionCurrentCheck): void {
    if (check && !check()) {
        throw new ExecutionSupersededError();
    }
}

export function isExecutionSuperseded(error: unknown): boolean {
    return error instanceof ExecutionSupersededError;
}
