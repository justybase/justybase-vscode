import type { ColumnType } from 'mdb-reader';

export type AccessFileFormat =
    | 'jet3'
    | 'jet4'
    | 'accdb2007'
    | 'accdb2010'
    | 'accdb2013'
    | 'accdb2016'
    | 'accdb2019'
    | 'unknown';

/** Formats for which the package ships an empty database template. */
export type AccessFileCreationFormat =
    | 'mdb2000'
    | 'mdb2003'
    | 'accdb2007'
    | 'accdb2010'
    | 'accdb2016';

export type AccessScalarValue =
    | null
    | boolean
    | number
    | bigint
    | string
    | Date
    | Uint8Array;

/** A single value from an Access multi-valued field. */
export interface AccessSingleValue {
    readonly value: AccessScalarValue;
}

/** An attachment stored in an Access attachment field. */
export interface AccessAttachment {
    readonly data: Uint8Array | null;
    readonly flags: number | null;
    readonly name: string | null;
    readonly timestamp: Date | null;
    readonly type: string | null;
    readonly url: string | null;
}

/** A value from an Access version-history complex field. */
export interface AccessVersion {
    readonly value: AccessScalarValue;
    readonly modified: Date | null;
}

export type AccessComplexKind = 'single' | 'attachment' | 'version';

/**
 * Non-enumerable metadata used to retain the kind of an empty complex value.
 * An empty array has no item from which the serializer could infer its kind.
 */
export const ACCESS_COMPLEX_KIND = Symbol('accessComplexKind');

export type AccessComplexItem = AccessSingleValue | AccessAttachment | AccessVersion;
export type AccessComplexValue = readonly AccessComplexItem[] & {
    readonly [ACCESS_COMPLEX_KIND]?: AccessComplexKind;
};

/** Values exposed by the Access file layer, including read-only complex values. */
export type AccessValue = AccessScalarValue | AccessComplexValue;

export interface AccessColumnDefinition {
    readonly name: string;
    readonly accessType: ColumnType;
    readonly nullable: boolean;
    readonly fixedLength: boolean;
    readonly size: number;
    readonly precision?: number;
    readonly scale?: number;
    readonly autoLong: boolean;
    readonly autoUuid: boolean;
    /** True when the column belongs to the table's primary-key index. */
    readonly isPrimaryKey: boolean;
    /** Complex type object id from MSysComplexColumns, when accessType is complex. */
    readonly complexTypeId?: number;
    /** Table-definition page of the conceptual table for a complex column. */
    readonly complexTableDefinitionPage?: number;
}

export interface AccessIndexDefinition {
    readonly name: string;
    readonly columns: readonly string[];
    readonly primaryKey: boolean;
    readonly unique: boolean;
    readonly ignoreNulls: boolean;
    readonly required: boolean;
}

export interface AccessTableDefinition {
    readonly name: string;
    readonly columns: readonly AccessColumnDefinition[];
    readonly rowCount: number;
    readonly isSystem: boolean;
    /** Object description stored in the table-definition property block. */
    readonly description?: string;
}

export interface AccessRelationshipDefinition {
    readonly name: string;
    /** Referencing (child) table. */
    readonly table: string;
    readonly columns: readonly string[];
    /** Referenced (parent) table. */
    readonly foreignTable: string;
    readonly foreignColumns: readonly string[];
    readonly enforced: boolean;
    readonly updateCascade: boolean;
    readonly deleteCascade: boolean;
}

export interface AccessLinkedTableDefinition {
    readonly name: string;
    /** Connection string from MSysObjects.Connect (e.g. "DBQ=C:\\data\\x.mdb;"). */
    readonly target: string;
    /** Object name on the remote side when the link renames it. */
    readonly foreignName: string;
    readonly isSystem: boolean;
}

export interface AccessTableSnapshot {
    readonly definition: AccessTableDefinition;
    readonly rows: readonly (readonly AccessValue[])[];
}

export type AccessQueryType =
    | 'select'
    | 'make-table'
    | 'append'
    | 'update'
    | 'delete'
    | 'crosstab'
    | 'data-definition'
    | 'pass-through'
    | 'union'
    | 'unknown';

export interface AccessQueryDefinition {
    readonly name: string;
    readonly objectId: number;
    readonly type: AccessQueryType;
    readonly sql?: string;
    readonly hasParameters: boolean;
}

export interface AccessReadOptions {
    readonly rowOffset?: number;
    readonly rowLimit?: number;
}

export interface AccessFileSessionOptions {
    readonly filePath: string;
    readonly password?: string;
    readonly readOnly?: boolean;
}

export interface AccessFileCreationOptions {
    readonly filePath: string;
    readonly format: AccessFileCreationFormat;
    /** Optional replacement template, primarily for custom/fixture files. */
    readonly templatePath?: string;
    readonly password?: string;
}

export interface AccessAtomicWriteContext {
    readonly sourcePath: string;
    readonly stagedPath: string;
    readonly format: AccessFileFormat;
}

export type AccessAtomicWriter = (context: AccessAtomicWriteContext) => Promise<void> | void;

export interface AccessAtomicWriteResult {
    readonly targetPath: string;
    readonly format: AccessFileFormat;
}
