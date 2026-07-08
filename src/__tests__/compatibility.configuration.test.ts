import * as vscode from 'vscode';
import {
	CURRENT_EXTENSION_NAMESPACE,
	affectsExtensionConfiguration,
	getExtensionConfiguration
} from '../compatibility/configuration';

jest.mock('vscode');

type MockWorkspaceConfiguration = jest.Mocked<vscode.WorkspaceConfiguration>;

function createWorkspaceConfiguration(values: Record<string, unknown> = {}): MockWorkspaceConfiguration {
	return {
		get: jest.fn((key: string, defaultValue?: unknown) => (
			Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue
		)),
		update: jest.fn(() => Promise.resolve())
	} as unknown as MockWorkspaceConfiguration;
}

describe('compatibility configuration helpers', () => {
	let configurationBySection: Map<string, MockWorkspaceConfiguration>;

	beforeEach(() => {
		jest.clearAllMocks();
		configurationBySection = new Map();
		(vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => {
			const key = section ?? '';
			const existing = configurationBySection.get(key);
			if (existing) {
				return existing;
			}

			const created = createWorkspaceConfiguration();
			configurationBySection.set(key, created);
			return created;
		});
	});

	it('returns values from configuration with default fallback', () => {
		configurationBySection.set(
			CURRENT_EXTENSION_NAMESPACE,
			createWorkspaceConfiguration({ enableStreaming: false })
		);

		const configuration = getExtensionConfiguration();

		expect(configuration.get('enableStreaming', true)).toBe(false);
		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(CURRENT_EXTENSION_NAMESPACE);
	});

	it('returns the provided default when setting is not found', () => {
		configurationBySection.set(
			CURRENT_EXTENSION_NAMESPACE,
			createWorkspaceConfiguration()
		);

		const configuration = getExtensionConfiguration();

		expect(configuration.get('pythonPath', 'python')).toBe('python');
		expect(configuration.get('missingSetting', 'fallback')).toBe('fallback');
	});

	it('updates the configuration', async () => {
		const currentConfiguration = createWorkspaceConfiguration();
		configurationBySection.set(
			`${CURRENT_EXTENSION_NAMESPACE}.sql`,
			currentConfiguration
		);

		await getExtensionConfiguration('sql').update(
			'showHoverTooltips',
			false,
			vscode.ConfigurationTarget.Global
		);

		expect(currentConfiguration.update).toHaveBeenCalledWith(
			'showHoverTooltips',
			false,
			vscode.ConfigurationTarget.Global,
			undefined
		);
	});

	it('detects configuration changes in the current namespace', () => {
		const event = {
			affectsConfiguration: jest.fn((key: string) => key === `${CURRENT_EXTENSION_NAMESPACE}.logging.level`)
		} as unknown as vscode.ConfigurationChangeEvent;

		expect(affectsExtensionConfiguration(event, 'logging.level')).toBe(true);
		expect(event.affectsConfiguration).toHaveBeenCalledWith(`${CURRENT_EXTENSION_NAMESPACE}.logging.level`);
	});
});
