import * as vscode from 'vscode';
import {
    DEFAULT_METADATA_LIVE_FALLBACK,
    allowsLiveMetadataFetch,
    allowsLiveMetadataFetchForSource,
    getMetadataLiveFallbackMode,
} from '../../metadata/liveFallbackPolicy';

jest.mock('vscode');

function configureLiveFallback(value: string | undefined): void {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn((_key: string, defaultValue?: unknown) => (
            value === undefined ? defaultValue : value
        )),
    });
}

describe('liveFallbackPolicy', () => {
    afterEach(() => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReset();
        configureLiveFallback(undefined);
    });

    it('defaults to onDemand', () => {
        configureLiveFallback(undefined);
        expect(DEFAULT_METADATA_LIVE_FALLBACK).toBe('onDemand');
        expect(getMetadataLiveFallbackMode()).toBe('onDemand');
        expect(allowsLiveMetadataFetch(true)).toBe(true);
        expect(allowsLiveMetadataFetch(false)).toBe(false);
    });

    it('never blocks every live fallback, including explicit user actions', () => {
        configureLiveFallback('never');
        expect(getMetadataLiveFallbackMode()).toBe('never');
        expect(allowsLiveMetadataFetch(true)).toBe(false);
        expect(allowsLiveMetadataFetch(false)).toBe(false);
        expect(allowsLiveMetadataFetchForSource('schema-tree')).toBe(false);
        expect(allowsLiveMetadataFetchForSource('completion')).toBe(false);
    });

    it('always allows completion and explicit paths to query live', () => {
        configureLiveFallback('always');
        expect(getMetadataLiveFallbackMode()).toBe('always');
        expect(allowsLiveMetadataFetch(false)).toBe(true);
        expect(allowsLiveMetadataFetchForSource('completion')).toBe(true);
    });

    it('onDemand still keeps completion cache-only', () => {
        configureLiveFallback('onDemand');
        expect(allowsLiveMetadataFetchForSource('completion')).toBe(false);
        expect(allowsLiveMetadataFetchForSource('schema-tree')).toBe(true);
        expect(allowsLiveMetadataFetchForSource('ddl-sync')).toBe(true);
        expect(allowsLiveMetadataFetchForSource(undefined)).toBe(true);
    });

    it('ignores unknown configured values', () => {
        configureLiveFallback('unexpected');
        expect(getMetadataLiveFallbackMode()).toBe('onDemand');
    });
});
