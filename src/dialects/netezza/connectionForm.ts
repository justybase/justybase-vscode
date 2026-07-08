import type { DatabaseConnectionFormSchema } from '../../contracts/database';
import { createStandardConnectionForm } from '../../core/connectionFormBuilder';

export const netezzaConnectionForm: DatabaseConnectionFormSchema = createStandardConnectionForm({
    defaultPort: 5480,
    databaseDefaultValue: 'system'
});
