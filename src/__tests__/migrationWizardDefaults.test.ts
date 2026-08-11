import type { MigrationWizardConnection } from '../contracts/webviews/migrationWizardContracts';
import { resolveMigrationTargetDatabase } from '../views/migrationWizardDefaults';
import { getMigrationWizardTargetDatabase } from '../../media/migrationWizard/targetDefaults';

const connections: MigrationWizardConnection[] = [
    { name: 'oracle', kind: 'oracle', database: 'ORCL' },
    { name: 'netezza', kind: 'netezza', database: 'JUST_DATA' },
    { name: 'no-database', kind: 'sqlite' },
];

describe('resolveMigrationTargetDatabase', () => {
    it('uses the selected connection database when no explicit target database exists', () => {
        expect(resolveMigrationTargetDatabase(undefined, 'netezza', connections)).toBe('JUST_DATA');
    });

    it('clears the database when the selected connection has no default database', () => {
        expect(resolveMigrationTargetDatabase(undefined, 'no-database', connections)).toBeUndefined();
    });

    it('preserves an explicit target database', () => {
        expect(resolveMigrationTargetDatabase('CUSTOM_DB', 'netezza', connections)).toBe('CUSTOM_DB');
    });
});

describe('getMigrationWizardTargetDatabase', () => {
    it('returns the database displayed after changing the Target connection', () => {
        expect(getMigrationWizardTargetDatabase(connections, 'netezza')).toBe('JUST_DATA');
    });

    it('returns undefined when the Target connection has no default database', () => {
        expect(getMigrationWizardTargetDatabase(connections, 'no-database')).toBeUndefined();
    });
});
