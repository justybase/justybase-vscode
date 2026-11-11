import {
    createDatabaseCapabilities,
    findCapabilityDrift,
    resolveProviderBackedCapabilities,
    type DatabaseAdvancedFeatures,
} from '@justybase/contracts';

describe('capability manifest', () => {
    it('derives provider-backed flags from provider presence', () => {
        const declared = createDatabaseCapabilities();
        const withProviders: DatabaseAdvancedFeatures = {
            explain: { buildQuery: (sql: string) => `EXPLAIN ${sql}` },
            tuningAdvisor: {
                analyze: () => ({ recommendations: [] }),
            } as unknown as DatabaseAdvancedFeatures['tuningAdvisor'],
        };

        const resolved = resolveProviderBackedCapabilities(declared, withProviders);

        expect(resolved.supportsExplainPlan).toBe(true);
        expect(resolved.supportsExplainGraph).toBe(true);
        expect(resolved.supportsTuningAdvisor).toBe(true);
        expect(resolved.supportsTableMaintenance).toBe(false);
        expect(resolved.supportsSessionMonitor).toBe(false);
    });

    it('reports declarations without providers and providers without flags', () => {
        const capabilities = createDatabaseCapabilities({
            supportsExplainPlan: true,
            supportsSessionMonitor: false,
        });
        const drift = findCapabilityDrift(capabilities, {
            sessionMonitor: {} as DatabaseAdvancedFeatures['sessionMonitor'],
        });

        expect(drift.missingProvider).toEqual(['supportsExplainPlan']);
        expect(drift.missingFlag).toEqual(['sessionMonitor']);
    });
});
