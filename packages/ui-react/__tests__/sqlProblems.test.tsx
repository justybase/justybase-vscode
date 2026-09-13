import { fireEvent, render, screen } from '@testing-library/react';
import { SqlProblemsPanel } from '../src';

describe('shared SQL Problems presentation', () => {
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
