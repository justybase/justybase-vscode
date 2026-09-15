/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import type { ConnectionProfileSummary, MetadataDatabase } from '@justybase/contracts';
import { EditorToolbar } from './EditorToolbar';

const connection: ConnectionProfileSummary = {
  id: 'connection-1',
  name: 'Warehouse',
  host: 'db',
  port: 5480,
  database: 'SYSTEM',
  user: 'admin',
  dbType: 'netezza',
  readOnly: true,
};

function renderToolbar(databases: MetadataDatabase[] = []): void {
  render(<EditorToolbar
    connectionId={connection.id}
    database="SYSTEM"
    connections={[connection]}
    databases={databases}
    databaseLoadState={databases.length > 0 ? 'ready' : 'loading'}
    onSelectConnection={() => undefined}
    onSelectDatabase={() => undefined}
    databaseKind="netezza"
    onSelectDialect={() => undefined}
    onRun={() => undefined}
    onSave={() => undefined}
    onComment={() => undefined}
    onFormat={() => undefined}
    isRunning={false}
    onCancel={() => undefined}
  />);
}

describe('EditorToolbar database context', () => {
  it('shows a Netezza profile database while databases are still loading', () => {
    renderToolbar();
    const database = screen.getByRole('combobox', { name: 'Database' }) as HTMLSelectElement;
    expect(database).toHaveValue('SYSTEM');
    expect(Array.from(database.options).map(option => option.value)).toContain('SYSTEM');
  });

  it('keeps the default database selected when the catalog omits it', () => {
    renderToolbar([{ name: 'REPORTING' }]);
    const database = screen.getByRole('combobox', { name: 'Database' }) as HTMLSelectElement;
    expect(database).toHaveValue('SYSTEM');
    expect(Array.from(database.options).map(option => option.value)).toEqual(['', 'SYSTEM', 'REPORTING']);
  });
});
