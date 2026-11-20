import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MenuIcon } from './menuIcons';

export interface ResultColumnSearchColumn {
  readonly name: string;
  readonly type?: string;
}

export interface ResultColumnSearchProps {
  readonly columns: readonly ResultColumnSearchColumn[];
  /** Receives the raw column index selected from the filtered list. */
  readonly onSelect: (columnIndex: number) => void;
  /** Marks hidden columns so the menu can explain why they are not on screen. */
  readonly isColumnVisible?: (columnIndex: number) => boolean;
  readonly placeholder?: string;
}

/**
 * Compact toolbar search for jumping to a result column. The legacy panel
 * exposed the same workflow through a toolbar field: typing filters the column
 * list and selecting an entry scrolls the grid horizontally to that column.
 */
export const ResultColumnSearch = forwardRef<HTMLInputElement, ResultColumnSearchProps>(
  function ResultColumnSearch(
    { columns, onSelect, isColumnVisible, placeholder = 'Find column…' },
    ref,
  ) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [highlighted, setHighlighted] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const listId = useId();
    const optionId = (position: number): string => `${listId}-option-${position}`;

    const matches = useMemo(() => {
      const text = query.trim().toLocaleLowerCase();
      return columns
        .map((column, columnIndex) => ({ column, columnIndex }))
        .filter(({ column }) => text.length === 0 || column.name.toLocaleLowerCase().includes(text));
    }, [columns, query]);
    const activeIndex = matches.length === 0 ? -1 : Math.min(highlighted, matches.length - 1);

    useEffect(() => {
      setHighlighted(0);
    }, [query, open]);

    useEffect(() => {
      if (!open) return undefined;
      const close = (event: MouseEvent): void => {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
      };
      document.addEventListener('mousedown', close);
      return () => document.removeEventListener('mousedown', close);
    }, [open]);

    useEffect(() => {
      if (!open) return;
      const item = listRef.current?.querySelector<HTMLElement>(
        `[data-result-column-search-index="${activeIndex}"]`,
      );
      item?.scrollIntoView?.({ block: 'nearest' });
    }, [activeIndex, open]);

    const choose = (columnIndex: number): void => {
      const column = columns[columnIndex];
      setQuery(column?.name ?? '');
      setOpen(false);
      onSelect(columnIndex);
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
        setHighlighted(value => Math.min(value + 1, Math.max(0, matches.length - 1)));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setOpen(true);
        setHighlighted(value => Math.max(value - 1, 0));
      } else if (event.key === 'Enter') {
        const selected = matches[activeIndex];
        if (selected) {
          event.preventDefault();
          choose(selected.columnIndex);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };

    return <div
      className="ui-result-toolbar-search ui-result-column-search"
      ref={rootRef}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <span className="ui-result-toolbar-search-icon" aria-hidden="true"><MenuIcon name="search" /></span>
      <input
        ref={ref}
        type="search"
        role="combobox"
        aria-label="Find column"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        placeholder={placeholder}
        value={query}
        onChange={event => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={event => {
          setOpen(true);
          event.currentTarget.select();
        }}
        onKeyDown={handleKeyDown}
      />
      {open && <div
        id={listId}
        ref={listRef}
        className="ui-result-column-search-menu"
        role="listbox"
        aria-label="Matching columns"
      >
        {matches.length === 0
          ? <div className="ui-result-column-search-empty" role="status">No matching columns</div>
          : matches.map(({ column, columnIndex }, position) => {
            const visible = isColumnVisible?.(columnIndex) !== false;
            return <button
              type="button"
              role="option"
              id={optionId(position)}
              aria-selected={position === activeIndex}
              className="ui-result-column-search-item"
              key={`${column.name}:${columnIndex}`}
              data-result-column-search-index={position}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setHighlighted(position)}
              onClick={() => choose(columnIndex)}
            >
              <span className="ui-result-column-search-name">{column.name}</span>
              {column.type && <span className="ui-result-column-search-type">{column.type}</span>}
              {!visible && <span className="ui-result-column-search-hidden">hidden</span>}
            </button>;
          })}
      </div>}
    </div>;
  },
);
