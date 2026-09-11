/** @jest-environment jsdom */

jest.mock('react-dom/client', () => ({
  createRoot: jest.fn(() => ({ render: jest.fn() })),
}));

describe('Electron renderer entrypoint', () => {
  it('mounts the renderer application into the owned root element', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('../src/renderer/main');
    const reactDom = jest.requireMock('react-dom/client') as { createRoot: jest.Mock };
    expect(reactDom.createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(reactDom.createRoot.mock.results[0]?.value.render).toHaveBeenCalledTimes(1);
  });
});
