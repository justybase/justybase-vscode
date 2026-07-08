/**
 * Unit tests for ETL view barrel exports.
 */

import * as etlViews from '../views/etl';

describe('views/etl barrel exports', () => {
    it('exports ETL designer helpers', () => {
        expect(typeof etlViews.getEtlDesignerStyles).toBe('function');
        expect(typeof etlViews.getEtlDesignerScript).toBe('function');
        expect(typeof etlViews.generateEtlDesignerHtml).toBe('function');
        expect(etlViews.NodeConfigurator).toBeDefined();
    });
});
