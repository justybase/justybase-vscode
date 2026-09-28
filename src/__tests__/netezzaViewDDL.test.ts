import type { NzConnection } from '../types';
import { executeQueryHelper } from '../dialects/netezza/ddl/helpers';
import { getColumns, getViewComment } from '../dialects/netezza/ddl/metadata';
import { buildNetezzaViewDdl } from '@justybase/designer-core';
import { buildViewDDLFromCache, generateViewDDL } from '../dialects/netezza/ddl/viewDDL';

jest.mock('../dialects/netezza/ddl/helpers', () => ({
    executeQueryHelper: jest.fn(),
}));

jest.mock('../dialects/netezza/ddl/metadata', () => ({
    getColumns: jest.fn(),
    getViewComment: jest.fn(),
}));

jest.mock('@justybase/designer-core', () => ({
    buildNetezzaViewDdl: jest.fn().mockReturnValue('-- generated view DDL'),
}));

describe('Netezza view DDL', () => {
    const connection = {} as NzConnection;
    const mockExecuteQuery = jest.mocked(executeQueryHelper);
    const mockGetColumns = jest.mocked(getColumns);
    const mockGetViewComment = jest.mocked(getViewComment);
    const mockBuildNetezzaViewDdl = jest.mocked(buildNetezzaViewDdl);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('passes the view comment and column comments to the shared formatter', async () => {
        const columns = [
            { name: 'ID', description: 'View identifier', fullTypeName: 'INTEGER', notNull: false, defaultValue: null },
        ];
        mockExecuteQuery.mockResolvedValueOnce([
            { SCHEMA: 'ADMIN', VIEWNAME: 'V_USERS', DEFINITION: 'SELECT ID FROM USERS', OBJID: 42 },
        ]);
        mockGetColumns.mockResolvedValueOnce(columns);
        mockGetViewComment.mockResolvedValueOnce('Users view');

        await expect(generateViewDDL(connection, 'MYDB', 'ADMIN', 'V_USERS'))
            .resolves.toBe('-- generated view DDL');

        expect(mockGetColumns).toHaveBeenCalledWith(connection, 'MYDB', 'ADMIN', 'V_USERS');
        expect(mockGetViewComment).toHaveBeenCalledWith(connection, 'MYDB', 'ADMIN', 'V_USERS');
        expect(mockBuildNetezzaViewDdl).toHaveBeenCalledWith(
            'MYDB',
            'ADMIN',
            'V_USERS',
            'SELECT ID FROM USERS',
            'Users view',
            columns,
        );
    });

    it('keeps cached view DDL compatible when comments are not supplied', () => {
        buildViewDDLFromCache('MYDB', 'ADMIN', 'V_USERS', 'SELECT ID FROM USERS');

        expect(mockBuildNetezzaViewDdl).toHaveBeenCalledWith(
            'MYDB', 'ADMIN', 'V_USERS', 'SELECT ID FROM USERS', null, [],
        );
    });
});
