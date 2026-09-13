import { sqlProblemsFromMarkers } from '../src';
import type * as Monaco from 'monaco-editor';

describe('Monaco diagnostic adapter', () => {
  it('maps Monaco markers to the portable Problems contract', () => {
    const problems = sqlProblemsFromMarkers([{
      message: 'Unknown column.',
      severity: 8,
      code: 'SQL007',
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 12,
    } as Monaco.editor.IMarker]);
    expect(problems).toEqual([expect.objectContaining({
      message: 'Unknown column.',
      severity: 'error',
      code: 'SQL007',
      startLineNumber: 3,
      startColumn: 5,
    })]);
  });
});
