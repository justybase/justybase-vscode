import { buildTableAsViewDDL } from '../dialects/netezza/ddl/tableAsView';
import type { KeyInfo } from '../dialects/netezza/ddl/types';

describe('Netezza table-as-view DDL', () => {
    it('includes the source object comment and available column comments', () => {
        const ddl = buildTableAsViewDDL(
            'MYDB',
            'ADMIN',
            'USERS',
            [
                { name: 'ID', description: 'User identifier' },
                { name: 'NAME', description: null },
            ],
            new Map<string, KeyInfo>(),
            "Owner's users",
        );

        expect(ddl).toContain("COMMENT ON VIEW NEW_DATABASE..USERS IS 'View from table MYDB.ADMIN.USERS.");
        expect(ddl).toContain("Owner''s users");
        expect(ddl).toContain("COMMENT ON COLUMN NEW_DATABASE..USERS.ID IS 'User identifier';");
        expect(ddl).not.toContain('COMMENT ON COLUMN NEW_DATABASE..USERS.NAME');
    });
});
