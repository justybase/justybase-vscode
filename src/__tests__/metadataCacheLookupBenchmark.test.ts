/**
 * Local baseline for metadata lookup performance (not a CI gate).
 */

import { describe, expect, it } from '@jest/globals';
import { MetadataCache } from '../metadataCache';
import { buildIdLookupKey } from '../metadata/helpers';
import type { TableMetadata } from '../metadata/types';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

jest.mock('vscode');

describe('metadata cache lookup benchmark', () => {
  it('findObjectWithType and getTablesAllSchemas stay within local budget for 10k lookups', () => {
    const mockOutputChannel = {
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    } as unknown as vscode.OutputChannel;
    Logger.initialize(mockOutputChannel);

    jest.spyOn(
      require('../compatibility/configuration'),
      'getExtensionConfiguration',
    ).mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    });

    const cache = new MetadataCache(
      { globalStorageUri: undefined } as unknown as vscode.ExtensionContext,
    );

    const tables: TableMetadata[] = [];
    const idMap = new Map<string, number>();
    for (let schemaIndex = 0; schemaIndex < 10; schemaIndex++) {
      for (let tableIndex = 0; tableIndex < 100; tableIndex++) {
        const schema = `S${schemaIndex}`;
        const name = `T${tableIndex}`;
        tables.push({
          OBJNAME: name,
          label: name,
          SCHEMA: schema,
          objType: 'TABLE',
          OBJID: schemaIndex * 1000 + tableIndex,
        });
        idMap.set(buildIdLookupKey('DB1', schema, name), schemaIndex * 1000 + tableIndex);
      }
    }

    for (let schemaIndex = 0; schemaIndex < 10; schemaIndex++) {
      const schema = `S${schemaIndex}`;
      const slice = tables.filter((table) => table.SCHEMA === schema);
      const sliceMap = new Map<string, number>();
      for (const table of slice) {
        sliceMap.set(
          buildIdLookupKey('DB1', schema, table.OBJNAME!),
          table.OBJID!,
        );
      }
      cache.setTables('conn', `DB1.${schema}`, slice, sliceMap);
    }

    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      cache.findObjectWithType('conn', 'DB1', 'S3', `T${i % 100}`);
      cache.getTablesAllSchemas('conn', 'DB1');
    }
    const elapsedMs = performance.now() - started;

    // Loose local budget — records baseline, does not fail CI unless extreme regression.
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
