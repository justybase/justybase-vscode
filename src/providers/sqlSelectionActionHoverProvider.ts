import * as vscode from 'vscode';
import { getExtensionConfiguration } from '../compatibility/configuration';
import type { SqlDataAffordanceResolver } from './sqlDataAffordanceResolver';
import {
    createSelectionExecutionHover,
    resolveSelectionExecutionContext,
} from './sqlSelectionActionUtils';

export class SqlSelectionActionHoverProvider implements vscode.HoverProvider {
    constructor(private readonly dataAffordanceResolver?: SqlDataAffordanceResolver) {}

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ): Promise<vscode.Hover | undefined> {
        const sqlConfig = getExtensionConfiguration('sql');
        const showHoverTooltips = sqlConfig.get<boolean>('showHoverTooltips', true) ?? true;
        const showSelectionActionHover = sqlConfig.get<boolean>('showSelectionActionHover', true) ?? true;
        if (!showHoverTooltips || !showSelectionActionHover) {
            return undefined;
        }

        const context = await resolveSelectionExecutionContext(
            document,
            position,
            this.dataAffordanceResolver,
        );
        if (!context) {
            return undefined;
        }

        return createSelectionExecutionHover(context);
    }
}
