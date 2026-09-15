/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { ElectronDockyardWorkspace } from '../src/renderer/dockyard/ElectronDockyardWorkspace';

describe('Electron Dockyard header', () => {
  it('renders the host-provided import action in the main bar', () => {
    render(<ElectronDockyardWorkspace headerActions={<button type="button">Import data</button>}><div>Workspace</div></ElectronDockyardWorkspace>);

    expect(screen.getByRole('button', { name: 'Import data' })).toBeInTheDocument();
  });
});
