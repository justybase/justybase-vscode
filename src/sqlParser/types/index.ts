export type {
    ColumnInfo,
    CteInfo,
    Scope,
    TokenPosition,
    TableInfo,
    ValidationError,
    ValidationResult,
} from '@justybase/sql-core/validation';
export type { ScopeSeed } from '@justybase/sql-core/validation';
import type {
    Scope,
    ValidationError,
} from '@justybase/sql-core/validation';

export interface ParsedStatement {
    type: 'select' | 'insert' | 'update' | 'delete' | 'create_table' | 'create_temp_table' | 'cte' | 'unknown'
    scope: Scope
    errors: ValidationError[]
}
