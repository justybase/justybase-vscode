declare module 'archiver' {
    import { Stream } from 'stream';

    interface Archiver {
        pipe(stream: NodeJS.WritableStream): this;
        append(source: string | Buffer | Stream, data?: { name: string }): void;
        finalize(): Promise<void>;
        pointer(): number;
        on(event: string, listener: (...args: unknown[]) => void): this;
        emit(event: string, ...args: unknown[]): boolean;
    }

    function archiver(format: 'zip' | 'tar', options?: object): Archiver;

    namespace archiver {
        export function create(format: string, options?: object): Archiver;
    }

    export = archiver;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface IterableIterator<T> {
    [Symbol.dispose](): void;
}
