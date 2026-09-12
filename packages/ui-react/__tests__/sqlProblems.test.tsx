import { fireEvent, render, screen } from '@testing-library/react';
import type * as Monaco from 'monaco-editor';
import { SqlProblemsPanel, sqlProblemsFromMarkers } from '../src';

describe('shared SQL Problems presentation', () => {
  it('maps Monaco markers and preserves the diagnostic location', () => {
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

  it('renders the same clickable Problems panel for every host adapter', () => {
    const onSelect = jest.fn();
    const problem = {
      message: 'Use a qualified table name.',
      severity: 'warning' as const,
      code: 'SQL004',
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 6,
    };
    render(<SqlProblemsPanel problems={[problem]} onSelect={onSelect} />);
    expect(screen.getByRole('region', { name: 'SQL Problems' })).toHaveTextContent('SQL004');
    expect(screen.getByText('Ln 2, Col 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith(problem);
  });
});
