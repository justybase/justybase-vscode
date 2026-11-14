const getTableColumnsMetadata = jest.fn();

jest.mock('../providers/providers/metadataProvider', () => ({
    MetadataProvider: jest.fn().mockImplementation(() => ({
        getTableColumnsMetadata,
    })),
}));

import { ImportTargetCatalogService } from '../import/wizard/ImportTargetCatalogService';

describe('ImportTargetCatalogService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('maps catalog columns to authoritative target metadata', async () => {
        getTableColumnsMetadata.mockResolvedValue([
            {
                ATTNAME: 'Id',
                FORMAT_TYPE: 'BIGINT',
                isNotNull: true,
            },
            {
                ATTNAME: 'Display Name',
                FORMAT_TYPE: 'NVARCHAR(20)',
                isNotNull: false,
                colDefault: "'unknown'",
            },
            {
                ATTNAME: '',
                label: 'Fallback Name',
                detail: 'INTEGER',
            },
            {
                ATTNAME: '   ',
                FORMAT_TYPE: '',
            },
        ]);
        const service = new ImportTargetCatalogService(
            {} as never,
            {} as never,
            {} as never,
        );

        await expect(service.loadTableColumns(
            'NZ',
            'JUST_DATA',
            'ADMIN',
            'TARGET',
        )).resolves.toEqual([
            { name: 'Id', dataType: 'BIGINT', nullable: false, hasDefault: false },
            { name: 'Display Name', dataType: 'NVARCHAR(20)', nullable: true, hasDefault: true },
            { name: 'Fallback Name', dataType: 'INTEGER', nullable: true, hasDefault: false },
        ]);

        expect(getTableColumnsMetadata).toHaveBeenCalledWith(
            'NZ',
            'JUST_DATA',
            'ADMIN',
            'TARGET',
        );
    });

    it('falls back to the default text type when the catalog type is empty', async () => {
        getTableColumnsMetadata.mockResolvedValue([
            { ATTNAME: 'NOTE', FORMAT_TYPE: '   ', isNotNull: true },
        ]);
        const service = new ImportTargetCatalogService(
            {} as never,
            {} as never,
            {} as never,
        );

        await expect(service.loadTableColumns('NZ', undefined, undefined, 'TARGET'))
            .resolves.toEqual([
                { name: 'NOTE', dataType: 'NVARCHAR(255)', nullable: false, hasDefault: false },
            ]);
    });
});
