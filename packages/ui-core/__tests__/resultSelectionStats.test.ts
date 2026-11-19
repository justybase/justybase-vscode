import { describe, expect, it } from '@jest/globals';
import { calculateGridSelectionStats } from '../src';

describe('renderer-neutral selection statistics', () => {
  it('summarizes numeric cells with count, distinct, min and max', () => {
    expect(calculateGridSelectionStats([1, 2, 3, 4])).toEqual({
      cellCount: 4,
      type: 'numeric',
      count: 4,
      distinctCount: 4,
      sum: 10,
      min: 1,
      max: 4,
    });
  });

  it('classifies dates, text and mixed selections', () => {
    const dates = calculateGridSelectionStats(['2024-01-02', '2024-01-01']);
    expect(dates).toMatchObject({ type: 'date', min: '2024-01-01', max: '2024-01-02' });

    expect(calculateGridSelectionStats(['a', 'b', 'a'])).toEqual({
      cellCount: 3,
      type: 'text',
      count: 3,
      distinctCount: 2,
    });
    expect(calculateGridSelectionStats([1, 'a']).type).toBe('mixed');
  });

  it('ignores null, empty and the literal NULL markers', () => {
    expect(calculateGridSelectionStats([null, undefined, '', '   ', 'NULL', 'null', 5])).toEqual({
      cellCount: 1,
      type: 'numeric',
      count: 1,
      distinctCount: 1,
      sum: 5,
      min: 5,
      max: 5,
    });
  });
});
