import { performance } from 'node:perf_hooks';

export interface TimingStats {
    sampleMs: number[];
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
}

export interface TimedRun<T> extends TimingStats {
    lastValue: T | undefined;
}

export function calculateTimingStats(samples: readonly number[]): TimingStats {
    if (samples.length === 0) {
        return { sampleMs: [], medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const medianMs = sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return {
        sampleMs: [...samples],
        medianMs,
        p95Ms: sorted[p95Index],
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
    };
}

export async function measureAsync<T>(
    operation: (iteration: number, warmup: boolean) => Promise<T> | T,
    options: { warmups?: number; samples?: number } = {},
): Promise<TimedRun<T>> {
    const warmups = options.warmups ?? 2;
    const samples = options.samples ?? 8;
    for (let iteration = 0; iteration < warmups; iteration += 1) {
        await operation(iteration, true);
    }

    const sampleMs: number[] = [];
    let lastValue: T | undefined;
    for (let iteration = 0; iteration < samples; iteration += 1) {
        const startedAt = performance.now();
        lastValue = await operation(iteration, false);
        sampleMs.push(performance.now() - startedAt);
    }
    return { ...calculateTimingStats(sampleMs), lastValue };
}

export function measureSync<T>(
    operation: (iteration: number, warmup: boolean) => T,
    options: { warmups?: number; samples?: number } = {},
): TimedRun<T> {
    const warmups = options.warmups ?? 2;
    const samples = options.samples ?? 8;
    for (let iteration = 0; iteration < warmups; iteration += 1) {
        operation(iteration, true);
    }

    const sampleMs: number[] = [];
    let lastValue: T | undefined;
    for (let iteration = 0; iteration < samples; iteration += 1) {
        const startedAt = performance.now();
        lastValue = operation(iteration, false);
        sampleMs.push(performance.now() - startedAt);
    }
    return { ...calculateTimingStats(sampleMs), lastValue };
}
