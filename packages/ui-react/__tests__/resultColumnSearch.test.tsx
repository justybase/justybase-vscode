import { fireEvent, render, screen } from '@testing-library/react';
import { ResultColumnSearch } from '../src';

const columns = [
  { name: 'ID', type: 'INTEGER' },
  { name: 'CUSTOMER_NAME', type: 'VARCHAR' },
  { name: 'AMOUNT', type: 'NUMERIC' },
];

describe('ResultColumnSearch', () => {
  it('filters columns and jumps to the highlighted match with the keyboard', () => {
    const onSelect = jest.fn();
    render(<ResultColumnSearch columns={columns} onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Find column' });

    fireEvent.focus(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);

    fireEvent.change(input, { target: { value: 'name' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    const match = screen.getByRole('option', { name: /CUSTOMER_NAME/ });
    expect(match).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', match.id);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(input).toHaveValue('CUSTOMER_NAME');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('moves the highlight with the arrow keys before selecting', () => {
    const onSelect = jest.fn();
    render(<ResultColumnSearch columns={columns} onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Find column' });

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /CUSTOMER_NAME/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /^ID/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('closes on Escape and reports an empty result without selecting', () => {
    const onSelect = jest.fn();
    render(<ResultColumnSearch columns={columns} onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Find column' });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.getByText('No matching columns')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks columns hidden by the view and still allows selecting them', () => {
    const onSelect = jest.fn();
    render(<ResultColumnSearch
      columns={columns}
      onSelect={onSelect}
      isColumnVisible={columnIndex => columnIndex !== 2}
    />);
    const input = screen.getByRole('combobox', { name: 'Find column' });

    fireEvent.focus(input);
    const hidden = screen.getByRole('option', { name: /AMOUNT/ });
    expect(hidden).toHaveTextContent('hidden');
    fireEvent.mouseDown(hidden);
    fireEvent.click(hidden);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('closes when focus leaves the search control', () => {
    render(<ResultColumnSearch columns={columns} onSelect={jest.fn()} />);
    const input = screen.getByRole('combobox', { name: 'Find column' });

    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
