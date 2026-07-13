import type { SelectionStats } from '../types.js';

type StatsCallback = (stats: SelectionStats) => void;

class StatsAccumulator {
    private readonly distinctValues = new Set<string | number>();
    private numericCount = 0;
    private dateCount = 0;
    private textCount = 0;
    private numericSum = 0;
    private numericMin = Infinity;
    private numericMax = -Infinity;
    private dateMin: string | undefined;
    private dateMax: string | undefined;

    add(values: unknown[]): void {
        for (const value of values) {
            if (value === null || value === undefined) continue;
            const text = String(value).trim();
            if (text === '' || text === 'NULL' || text === 'null') continue;
            const standardText = text.replace(/[\s\u00A0]/g, '').replace(',', '.');
            const numeric = typeof value === 'number' ? value : Number.parseFloat(standardText);
            if (Number.isFinite(numeric) && /^-?\d*\.?\d+$/.test(standardText)) {
                this.numericCount++;
                this.numericSum += numeric;
                this.numericMin = Math.min(this.numericMin, numeric);
                this.numericMax = Math.max(this.numericMax, numeric);
                this.distinctValues.add(numeric);
            }
            if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{2}\/\d{2}\/\d{4}/.test(text)) {
                this.dateCount++;
                this.dateMin = this.dateMin === undefined || text < this.dateMin ? text : this.dateMin;
                this.dateMax = this.dateMax === undefined || text > this.dateMax ? text : this.dateMax;
                this.distinctValues.add(text);
            } else if (!/^-?\d*\.?\d+$/.test(standardText)) {
                this.textCount++;
                this.distinctValues.add(text);
            }
        }
    }

    result(): SelectionStats {
        const cellCount = this.numericCount + this.dateCount + this.textCount;
        const distinctCount = this.distinctValues.size;
        if (this.numericCount > 0 && this.dateCount === 0 && this.textCount === 0) {
            return {
                cellCount, type: 'numeric', count: this.numericCount, distinctCount,
                sum: this.numericSum, min: this.numericMin, max: this.numericMax,
            };
        }
        if (this.dateCount > 0 && this.numericCount === 0 && this.textCount === 0) {
            return { cellCount, type: 'date', count: this.dateCount, distinctCount, min: this.dateMin, max: this.dateMax };
        }
        if (this.textCount > 0 && this.numericCount === 0 && this.dateCount === 0) {
            return { cellCount, type: 'text', count: this.textCount, distinctCount };
        }
        return { cellCount, type: 'mixed', count: cellCount, distinctCount };
    }
}

const WORKER_SOURCE = `
const distinct = new Set(); let numericCount = 0, dateCount = 0, textCount = 0, sum = 0, numericMin = Infinity, numericMax = -Infinity, dateMin, dateMax;
function add(values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '' || text === 'NULL' || text === 'null') continue;
    const standard = text.replace(/[\\s\\u00A0]/g, '').replace(',', '.');
    const parsed = typeof value === 'number' ? value : Number.parseFloat(standard);
    if (Number.isFinite(parsed) && /^-?\\d*\\.?\\d+$/.test(standard)) { numericCount++; sum += parsed; numericMin = Math.min(numericMin, parsed); numericMax = Math.max(numericMax, parsed); distinct.add(parsed); }
    if (/^\\d{4}-\\d{2}-\\d{2}/.test(text) || /^\\d{2}\\/\\d{2}\\/\\d{4}/.test(text)) { dateCount++; dateMin = dateMin === undefined || text < dateMin ? text : dateMin; dateMax = dateMax === undefined || text > dateMax ? text : dateMax; distinct.add(text); }
    else if (!/^-?\\d*\\.?\\d+$/.test(standard)) { textCount++; distinct.add(text); }
  }
}
function result() {
  const cellCount = numericCount + dateCount + textCount, distinctCount = distinct.size;
  if (numericCount && !dateCount && !textCount) return { cellCount, type: 'numeric', count: numericCount, distinctCount, sum, min: numericMin, max: numericMax };
  if (dateCount && !numericCount && !textCount) return { cellCount, type: 'date', count: dateCount, distinctCount, min: dateMin, max: dateMax };
  if (textCount && !numericCount && !dateCount) return { cellCount, type: 'text', count: textCount, distinctCount };
  return { cellCount, type: 'mixed', count: cellCount, distinctCount };
}
self.onmessage = ({ data }) => { if (data.command === 'values') add(data.values); else if (data.command === 'complete') self.postMessage({ command: 'result', stats: result() }); };
`;

export interface SelectionStatsProcessor {
    add(values: unknown[]): void;
    complete(): void;
    dispose(): void;
}

/** Calculates chunks off the UI thread; falls back to the same incremental API in tests. */
export function createSelectionStatsProcessor(onComplete: StatsCallback, onError: () => void): SelectionStatsProcessor {
    if (typeof Worker === 'undefined') {
        const accumulator = new StatsAccumulator();
        return { add: values => accumulator.add(values), complete: () => onComplete(accumulator.result()), dispose: () => undefined };
    }

    const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
    const worker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);
    worker.onmessage = event => {
        if (event.data?.command === 'result') {
            worker.terminate();
            onComplete(event.data.stats as SelectionStats);
        }
    };
    worker.onerror = () => onError();
    return {
        add: values => worker.postMessage({ command: 'values', values }),
        complete: () => worker.postMessage({ command: 'complete' }),
        dispose: () => worker.terminate(),
    };
}
