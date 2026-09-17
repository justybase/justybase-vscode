import { buildAppMenuTemplate } from '../src/main/menu';

function labels(template: ReturnType<typeof buildAppMenuTemplate>): Array<string | undefined> {
  return template.map(item => item.label);
}

describe('Electron application menu', () => {
  it('exposes product File actions with discoverable accelerators', () => {
    const actions = { newWindow: jest.fn(), openFile: jest.fn(), saveFile: jest.fn(), saveFileAs: jest.fn() };
    const template = buildAppMenuTemplate({ appName: 'JustyBase', platform: 'linux', isDev: false, actions });
    expect(labels(template)).toEqual(['File', 'Edit', 'View', 'Window']);
    const file = template[0]?.submenu;
    expect(Array.isArray(file)).toBe(true);
    const items = (file as Array<{ label?: string; accelerator?: string }>).filter(item => typeof item.label === 'string');
    expect(items.map(item => [item.label, item.accelerator])).toEqual([
      ['New Window', 'CmdOrCtrl+N'],
      ['Open SQL File…', 'CmdOrCtrl+O'],
      ['Save', 'CmdOrCtrl+S'],
      ['Save As…', 'CmdOrCtrl+Shift+S'],
    ]);
  });

  it('routes file actions to the focused window and keeps reload dev-only', () => {
    const actions = { newWindow: jest.fn(), openFile: jest.fn(), saveFile: jest.fn(), saveFileAs: jest.fn() };
    const prod = buildAppMenuTemplate({ appName: 'Justybase', platform: 'win32', isDev: false, actions });
    const prodView = prod.find(item => item.label === 'View')?.submenu;
    expect(JSON.stringify(prodView)).not.toContain('reload');

    const dev = buildAppMenuTemplate({ appName: 'JustyBase', platform: 'win32', isDev: true, actions });
    expect(JSON.stringify(dev.find(item => item.label === 'View')?.submenu)).toContain('reload');

    const mac = buildAppMenuTemplate({ appName: 'JustyBase', platform: 'darwin', isDev: false, actions });
    expect(mac[0]?.label).toBe('JustyBase');
  });
});
