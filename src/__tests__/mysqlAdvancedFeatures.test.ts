import type { DatabaseDdlColumnInfo, DatabaseDdlKeyInfo } from '../contracts/database';
import { mysqlAdvancedFeatures } from '../../extensions/mysql/src/mysqlDdlGenerator';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { mysqlTuningAdvisor } from '../../extensions/mysql/src/mysqlTuningAdvisor';

describe('mysqlAdvancedFeatures ddl', () => {
    it('builds MySQL CREATE TABLE statements with backtick quoting and commas in the right places', async () => {
        const columns: DatabaseDdlColumnInfo[] = [
            {
                name: 'select',
                description: 'Primary identifier',
                fullTypeName: 'INT',
                notNull: true,
                defaultValue: null
            },
            {
                name: 'from',
                description: null,
                fullTypeName: 'VARCHAR(64)',
                notNull: false,
                defaultValue: "'anonymous'"
            }
        ];

        const keysInfo = new Map<string, DatabaseDdlKeyInfo>([
            [
                'PRIMARY',
                {
                    type: 'PRIMARY KEY',
                    typeChar: 'P',
                    columns: ['select'],
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: '',
                    deleteType: ''
                }
            ]
        ]);

        const ddl = mysqlAdvancedFeatures.ddl!.buildTableDDLFromCache(
            'salesdb',
            'select',
            'order',
            columns,
            [],
            [],
            keysInfo,
            'User records'
        );

        expect(ddl).toContain('CREATE TABLE `select`.`order` (');
        expect(ddl).toContain('`select` INT NOT NULL COMMENT \'Primary identifier\'');
        expect(ddl).toContain('`from` VARCHAR(64) DEFAULT \'anonymous\'');
        expect(ddl).toContain('PRIMARY KEY (`select`)');
        expect(ddl).toContain(") ENGINE=InnoDB COMMENT='User records';");
    });

    it('wires MySQL explain graph and tuning advisor capabilities', () => {
        expect(mysqlDialect.capabilities.supportsExplainGraph).toBe(true);
        expect(mysqlDialect.capabilities.supportsTuningAdvisor).toBe(true);
        expect(mysqlAdvancedFeatures.tuningAdvisor).toBe(mysqlTuningAdvisor);
    });
});
