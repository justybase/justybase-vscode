/**
 * Renderer-neutral selection statistics for the result grid status bar.
 *
 * The classification intentionally mirrors the legacy DOM grid: numeric text
 * counts as numeric, ISO-like dates count as dates, and a mixed selection only
 * reports cell and distinct counts.
 */

export type GridSelectionStatsType = 'numeric' | 'date' | 'text' | 'mixed';

export interface GridSelectionStats {
  readonly cellCount: number;
  readonly type: GridSelectionStatsType;
  readonly count: number;
  readonly distinctCount: number;
  readonly sum?: number;
  readonly min?: string | number;
  readonly max?: string | number;
}

export function calculateGridSelectionStats(values: readonly unknown[]): GridSelectionStats {
  const numericValues: number[] = [];
  const dateValues: string[] = [];
  const textValues: string[] = [];

  values.forEach(value => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text === '' || text === 'NULL' || text === 'null') return;

    const cleanText = text.replace(/[\s\u00A0]/g, '');
    const standardText = cleanText.replace(',', '.');
    const num = typeof value === 'number' ? value : parseFloat(standardText);
    if (Number.isFinite(num) && /^-?\d*\.?\d+$/.test(standardText)) {
      numericValues.push(num);
    }

    if (text.match(/^\d{4}-\d{2}-\d{2}/) || text.match(/^\d{2}\/\d{2}\/\d{4}/)) {
      dateValues.push(text);
    } else if (!/^-?\d*\.?\d+$/.test(standardText)) {
      textValues.push(text);
    }
  });

  const allValues = [...numericValues, ...dateValues, ...textValues];
  const distinctValues = new Set(allValues);
  if (numericValues.length > 0 && dateValues.length === 0 && textValues.length === 0) {
    return {
      cellCount: allValues.length,
      type: 'numeric',
      count: numericValues.length,
      distinctCount: distinctValues.size,
      sum: numericValues.reduce((total, value) => total + value, 0),
      min: Math.min(...numericValues),
      max: Math.max(...numericValues),
    };
  }
  if (dateValues.length > 0 && numericValues.length === 0 && textValues.length === 0) {
    const sortedDates = [...dateValues].sort();
    return {
      cellCount: allValues.length,
      type: 'date',
      count: dateValues.length,
      distinctCount: distinctValues.size,
      min: sortedDates[0],
      max: sortedDates[sortedDates.length - 1],
    };
  }
  if (textValues.length > 0 && numericValues.length === 0 && dateValues.length === 0) {
    return {
      cellCount: allValues.length,
      type: 'text',
      count: textValues.length,
      distinctCount: distinctValues.size,
    };
  }
  return {
    cellCount: allValues.length,
    type: 'mixed',
    count: allValues.length,
    distinctCount: distinctValues.size,
  };
}
