/**
 * Shared quote-aware delimited-record parser.
 *
 * This is the single CSV/TSV parsing implementation used by the desktop
 * importers and the platform-neutral tabular import runtime, so Snowflake
 * planning and desktop imports agree on quoted fields, embedded newlines,
 * CRLF handling and delimiter detection.
 *
 * The module is intentionally filesystem-free; file reading belongs to the
 * consumer.
 */

export class DelimitedRecordParser {
  private field = "";
  private row: string[] = [];
  private recordHasMeaningfulInput = false;
  private inQuotes = false;
  private pendingQuote = false;
  private skipLfAfterCr = false;
  private recordNumber = 0;

  constructor(private readonly delimiter: string) {
    if (delimiter.length !== 1) {
      throw new Error("Delimited import requires a single-character delimiter");
    }
  }

  *push(chunk: string, final = false): Generator<string[], void, unknown> {
    const emitRecord = (): string[] | undefined => {
      this.row.push(this.field);
      const record = this.recordHasMeaningfulInput ? this.row : undefined;
      this.field = "";
      this.row = [];
      this.recordHasMeaningfulInput = false;
      this.recordNumber++;
      return record;
    };

    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];

      if (this.skipLfAfterCr) {
        this.skipLfAfterCr = false;
        if (char === "\n") {
          continue;
        }
      }

      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (char === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }

      if (this.inQuotes) {
        if (char === '"') {
          this.pendingQuote = true;
        } else {
          this.field += char;
        }
        continue;
      }

      if (char === '"') {
        this.recordHasMeaningfulInput = true;
        if (this.field.length === 0) {
          this.inQuotes = true;
        } else {
          this.field += char;
        }
      } else if (char === this.delimiter) {
        if (!/\s/.test(char)) {
          this.recordHasMeaningfulInput = true;
        }
        this.row.push(this.field);
        this.field = "";
      } else if (char === "\r" || char === "\n") {
        const record = emitRecord();
        if (record) {
          yield record;
        }
        this.skipLfAfterCr = char === "\r";
      } else {
        if (!/\s/.test(char)) {
          this.recordHasMeaningfulInput = true;
        }
        this.field += char;
      }
    }

    if (final) {
      if (this.pendingQuote) {
        this.pendingQuote = false;
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        throw new Error(`Unterminated quoted field in record ${this.recordNumber + 1}`);
      }
      if (this.recordHasMeaningfulInput) {
        const record = emitRecord();
        if (record) {
          yield record;
        }
      }
    }
  }
}

export function parseDelimitedRecords(text: string, delimiter: string): string[][] {
  const parser = new DelimitedRecordParser(delimiter);
  return Array.from(parser.push(text.startsWith("\ufeff") ? text.slice(1) : text, true));
}

export function* iterateDelimitedRecords(
  text: string,
  delimiter: string,
  chunkSize = 64 * 1024,
): Generator<string[], void, unknown> {
  if (chunkSize < 1) {
    throw new Error("Delimited import chunk size must be positive");
  }

  const parser = new DelimitedRecordParser(delimiter);
  const source = text.startsWith("\ufeff") ? text.slice(1) : text;
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    yield* parser.push(source.slice(offset, offset + chunkSize));
  }
  yield* parser.push("", true);
}

export function detectDelimitedTextDelimiter(
  text: string,
  delimiters: readonly string[],
  fallback: string,
): string {
  const countsByRecord = new Map(delimiters.map((delimiter) => [delimiter, [] as number[]]));
  const delimiterSet = new Set(delimiters);
  let inQuotes = false;
  let atFieldStart = true;
  let recordHasContent = false;
  let recordCounts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
  let sampledRecords = 0;
  const source = text.startsWith("\ufeff") ? text.slice(1) : text;
  const sampleRecordLimit = 10;

  const finishRecord = () => {
    if (recordHasContent) {
      for (const delimiter of delimiters) {
        countsByRecord.get(delimiter)?.push(recordCounts.get(delimiter) ?? 0);
      }
      sampledRecords++;
    }
    recordHasContent = false;
    atFieldStart = true;
    recordCounts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"' && source[index + 1] === '"') {
        index++;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      }
    } else if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else {
      if (char === "\r" || char === "\n") {
        finishRecord();
        if (sampledRecords >= sampleRecordLimit) {
          break;
        }
      } else if (delimiterSet.has(char)) {
        recordCounts.set(char, (recordCounts.get(char) ?? 0) + 1);
        recordHasContent = true;
        atFieldStart = true;
      } else {
        if (!/\s/.test(char)) {
          recordHasContent = true;
        }
        atFieldStart = false;
      }
    }
  }

  if (sampledRecords < sampleRecordLimit) {
    finishRecord();
  }

  let detected = fallback;
  let maxConsistentCount = 0;
  let hasConsistentDelimiter = false;
  const fallbackCounts = countsByRecord.get(fallback) ?? [];
  const fallbackCount = fallbackCounts[0] ?? 0;
  const hasConsistentFallback = fallbackCount > 0
    && fallbackCounts.every((recordCount) => recordCount === fallbackCount);

  if (hasConsistentFallback) {
    return fallback;
  }

  for (const delimiter of delimiters) {
    if (delimiter === fallback) {
      continue;
    }
    const counts = countsByRecord.get(delimiter) ?? [];
    const count = counts[0] ?? 0;
    const isConsistent = count > 0 && counts.every((recordCount) => recordCount === count);
    if (
      isConsistent
      && (
        !hasConsistentDelimiter
        || count > maxConsistentCount
        || (count === maxConsistentCount && delimiter === fallback)
      )
    ) {
      detected = delimiter;
      maxConsistentCount = count;
      hasConsistentDelimiter = true;
    }
  }
  return detected;
}
