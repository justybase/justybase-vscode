import * as vscode from 'vscode';
import type { JustyBaseLiteApi } from '@justybase/contracts';

export const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

/**
 * Resolve and validate the versioned API exposed by the core extension.
 *
 * This module is deliberately a VS Code adapter. It knows the extension host
 * lookup mechanism, but has no dependency on the core implementation.
 */
export async function activateCoreExtension(): Promise<JustyBaseLiteApi> {
  const coreExtension = vscode.extensions.getExtension<JustyBaseLiteApi>(CORE_EXTENSION_ID);
  if (!coreExtension) {
    throw new Error(`Required extension dependency '${CORE_EXTENSION_ID}' is not installed.`);
  }

  const api = await coreExtension.activate();
  if (
    !api
    || api.version !== 1
    || typeof api.registerDatabaseDialect !== 'function'
    || typeof api.listRegisteredDatabaseDialects !== 'function'
  ) {
    throw new Error(
      `Extension '${CORE_EXTENSION_ID}' does not expose a compatible JustyBase API (expected version 1).`,
    );
  }

  return api;
}
