/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RedactedConnectionProfile } from '@justybase/contracts';
import { ConnectionPanel } from '../src/renderer/ConnectionPanel';

const profile: RedactedConnectionProfile = {
  id: 'connection-1', name: 'Netezza dev', host: 'db.example.com', port: 5480,
  database: 'SYSTEM', user: 'admin', dbType: 'netezza', readOnly: true,
};

function installApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'justybaseElectron', {
    configurable: true,
    value: {
      requestCredential: jest.fn(async () => 'opaque-password-handle'),
      createConnection: jest.fn(async () => profile),
      updateConnection: jest.fn(async () => profile),
      deleteConnection: jest.fn(async () => undefined),
      testConnection: jest.fn(async () => undefined),
      testConnectionProfile: jest.fn(async () => undefined),
      ...overrides,
    },
  });
}

describe('Electron connection panel', () => {
  it('never renders a password input and requests a main-process handle for new remote profiles', async () => {
    const onSaved = jest.fn();
    installApi();
    render(<ConnectionPanel onSaved={onSaved} onCancel={jest.fn()} />);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Netezza dev' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'db.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    await waitFor(() => expect(window.justybaseElectron.requestCredential).toHaveBeenCalledWith('connection'));
    expect(window.justybaseElectron.createConnection).toHaveBeenCalledWith(expect.objectContaining({ name: 'Netezza dev', host: 'db.example.com' }), 'opaque-password-handle');
    const createConnection = (window.justybaseElectron as unknown as { createConnection: jest.Mock }).createConnection;
    expect(JSON.stringify(createConnection.mock.calls[0]?.[0])).not.toContain('password');
    expect(onSaved).toHaveBeenCalledWith(profile);
  });

  it('tests an unchanged existing profile without prompting again, but prompts when testing edited remote fields', async () => {
    const testConnection = jest.fn(async () => undefined);
    const testConnectionProfile = jest.fn(async () => undefined);
    const requestCredential = jest.fn(async () => 'opaque-password-handle');
    installApi({ testConnection, testConnectionProfile, requestCredential });
    render(<ConnectionPanel initial={profile} onSaved={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith('connection-1'));
    expect(requestCredential).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'db2.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(testConnectionProfile).toHaveBeenCalledWith(expect.objectContaining({ host: 'db2.example.com' }), 'opaque-password-handle'));
  });
});
