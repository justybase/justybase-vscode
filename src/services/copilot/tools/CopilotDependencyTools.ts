import { ConnectionManager } from '../../../core/connectionManager';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../../../utils/sqlUtils';
import { TableReferenceExtractor } from '../TableReferenceExtractor';
import { CopilotToolRuntime } from './copilotToolRuntime';

type DependencyObjectType = 'TABLE' | 'VIEW' | 'PROCEDURE';
type DependencyRelationship = 'FOREIGN_KEY' | 'VIEW_SQL_REFERENCE' | 'PROCEDURE_SQL_REFERENCE';
type DependencySource =
    | 'foreign_key_metadata'
    | 'view_definition_sql_parse'
    | 'view_definition_text'
    | 'procedure_source_sql_parse'
    | 'procedure_source_text';

interface ParsedDependencyTargetInput {
    input: string;
    database?: string;
    schema?: string;
    objectName: string;
    explicitDatabase: boolean;
}

interface ResolvedDependencyTarget {
    id: string;
    database: string;
    schema: string;
    objectName: string;
    objectType: DependencyObjectType;
}

interface DependencyCandidate {
    id: string;
    targetId: string;
    database: string;
    schema: string;
    objectName: string;
    objectType: DependencyObjectType;
    relationship: DependencyRelationship;
    evidence: string;
    confidence: number;
    source: DependencySource;
}

interface CopilotDependencyToolsDeps {
    connectionManager: ConnectionManager;
    runtime: CopilotToolRuntime;
}

export class CopilotDependencyTools {
    constructor(private readonly deps: CopilotDependencyToolsDeps) { }

    private normalizeDependencyObjectType(value?: string): DependencyObjectType | undefined {
        const normalized = value?.trim().toUpperCase();
        if (normalized === 'TABLE' || normalized === 'VIEW' || normalized === 'PROCEDURE') {
            return normalized;
        }
        return undefined;
    }

    private parseDependencyTargetInput(object: string, database?: string): ParsedDependencyTargetInput {
        const input = object.trim();
        if (!input) {
            throw new Error('Object name is required.');
        }

        let explicitDatabase = false;
        let parsedDatabase: string | undefined;
        let parsedSchema: string | undefined;
        let parsedObjectName: string | undefined;

        if (input.includes('..')) {
            const parts = input.split('..');
            if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
                throw new Error('Invalid object format. Use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
            }

            explicitDatabase = true;
            parsedDatabase = parts[0].trim();
            const rightSide = parts[1].trim();
            const rightParts = rightSide.split('.');
            if (rightParts.length === 1) {
                parsedObjectName = rightParts[0];
            } else if (rightParts.length === 2) {
                parsedSchema = rightParts[0];
                parsedObjectName = rightParts[1];
            } else {
                throw new Error('Invalid DATABASE..OBJECT format. Expected DATABASE..TABLE or DATABASE..SCHEMA.TABLE.');
            }
        } else {
            const parts = input.split('.');
            if (parts.length === 1) {
                parsedObjectName = parts[0];
            } else if (parts.length === 2) {
                parsedSchema = parts[0];
                parsedObjectName = parts[1];
            } else if (parts.length === 3) {
                explicitDatabase = true;
                parsedDatabase = parts[0];
                parsedSchema = parts[1];
                parsedObjectName = parts[2];
            } else {
                throw new Error('Invalid object format. Use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
            }
        }

        if (!parsedObjectName || parsedObjectName.trim().length === 0) {
            throw new Error('Object name is required.');
        }

        const normalizedDatabase = (parsedDatabase || this.deps.runtime.normalizeScopeDatabase(database) || undefined)?.toUpperCase();
        return {
            input,
            database: normalizedDatabase,
            schema: parsedSchema?.trim().toUpperCase(),
            objectName: parsedObjectName.trim().toUpperCase(),
            explicitDatabase
        };
    }

    private getDependencySearchTokens(target: ResolvedDependencyTarget): string[] {
        const tokens = new Set<string>();
        tokens.add(target.objectName.toUpperCase());
        if (target.schema) {
            tokens.add(`${target.schema.toUpperCase()}.${target.objectName.toUpperCase()}`);
        }
        tokens.add(`${target.database.toUpperCase()}..${target.objectName.toUpperCase()}`);
        if (target.schema) {
            tokens.add(`${target.database.toUpperCase()}.${target.schema.toUpperCase()}.${target.objectName.toUpperCase()}`);
        }
        return Array.from(tokens);
    }

    private buildContainsPredicate(column: string, tokens: string[]): string {
        const conditions = tokens.map(token => {
            const escapedToken = token.replace(/'/g, "''");
            return `UPPER(${column}) LIKE '%${escapedToken}%'`;
        });
        return conditions.length > 0 ? conditions.join(' OR ') : '1 = 0';
    }

    private normalizeDependencyIdentifier(value?: string): string | undefined {
        if (!value) {
            return undefined;
        }
        const normalized = value.replace(/["`]/g, '').trim().toUpperCase();
        return normalized.length > 0 ? normalized : undefined;
    }

    private formatDependencyReferenceToken(reference: {
        database?: string;
        schema?: string;
        name?: string;
    }): string {
        const name = this.normalizeDependencyIdentifier(reference.name);
        const schema = this.normalizeDependencyIdentifier(reference.schema);
        const database = this.normalizeDependencyIdentifier(reference.database);
        if (!name) {
            return 'UNKNOWN_REFERENCE';
        }
        if (database && schema) {
            return `${database}.${schema}.${name}`;
        }
        if (database) {
            return `${database}..${name}`;
        }
        if (schema) {
            return `${schema}.${name}`;
        }
        return name;
    }

    private tableReferenceMatchesTarget(
        reference: {
            database?: string;
            schema?: string;
            name?: string;
        },
        target: ResolvedDependencyTarget
    ): boolean {
        const refName = this.normalizeDependencyIdentifier(reference.name);
        if (!refName || refName !== target.objectName) {
            return false;
        }

        const refDatabase = this.normalizeDependencyIdentifier(reference.database);
        if (refDatabase && refDatabase !== target.database) {
            return false;
        }

        const refSchema = this.normalizeDependencyIdentifier(reference.schema);
        if (refSchema && refSchema !== target.schema) {
            return false;
        }

        return true;
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private findDependencyTokenEvidence(sourceText: string, target: ResolvedDependencyTarget): string | undefined {
        const sourceUpper = sourceText.toUpperCase();
        const tokens = this.getDependencySearchTokens(target).sort((left, right) => right.length - left.length);

        for (const token of tokens) {
            if (token.includes('.') || token.includes('..')) {
                if (sourceUpper.includes(token)) {
                    return token;
                }
                continue;
            }

            const pattern = new RegExp(`\\b${this.escapeRegExp(token)}\\b`, 'i');
            if (pattern.test(sourceText)) {
                return token;
            }
        }

        return undefined;
    }

    private evaluateSourceDependencyEvidence(
        sourceText: string | undefined,
        target: ResolvedDependencyTarget,
        sourceKind: 'view' | 'procedure',
        extractor: TableReferenceExtractor
    ): { evidence: string; source: DependencySource; confidence: number } | undefined {
        if (!sourceText || sourceText.trim().length === 0) {
            return undefined;
        }

        const parsedReferences = extractor.extract(sourceText);
        const parsedMatch = parsedReferences.find(reference => this.tableReferenceMatchesTarget(reference, target));
        if (parsedMatch) {
            const token = this.formatDependencyReferenceToken(parsedMatch);
            if (sourceKind === 'view') {
                return {
                    evidence: `Parsed VIEW source references ${token}`,
                    source: 'view_definition_sql_parse',
                    confidence: 0.9
                };
            }
            return {
                evidence: `Parsed PROCEDURE source references ${token}`,
                source: 'procedure_source_sql_parse',
                confidence: 0.88
            };
        }

        const tokenEvidence = this.findDependencyTokenEvidence(sourceText, target);
        if (tokenEvidence) {
            if (sourceKind === 'view') {
                return {
                    evidence: `Matched VIEW source token ${tokenEvidence}`,
                    source: 'view_definition_text',
                    confidence: 0.75
                };
            }
            return {
                evidence: `Matched PROCEDURE source token ${tokenEvidence}`,
                source: 'procedure_source_text',
                confidence: 0.72
            };
        }

        return undefined;
    }

    async getObjectDependencies(
        object: string,
        database?: string,
        objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE'
    ): Promise<string> {
        const errors: string[] = [];
        let partial = false;

        try {
            const parsed = this.parseDependencyTargetInput(object, database);
            const requestedType = this.normalizeDependencyObjectType(objectType);
            const { connectionName } = await this.deps.runtime.getActiveConnectionDetails();

            let targetDatabase = parsed.database;
            if (!targetDatabase) {
                targetDatabase = await this.deps.connectionManager.getCurrentDatabase(connectionName) || undefined;
            }
            if (!targetDatabase) {
                throw new Error('Could not determine database. Provide database or use DATABASE..OBJECT format.');
            }

            targetDatabase = targetDatabase.toUpperCase();
            const useScopedDatabase = parsed.explicitDatabase || !!this.deps.runtime.normalizeScopeDatabase(database);

            const runDependencyQuery = async (sql: string, description: string): Promise<Array<Record<string, unknown>>> => {
                try {
                    const result = await this.deps.runtime.runQuerySafe(sql, description, useScopedDatabase ? targetDatabase : undefined);
                    return this.deps.runtime.parseStructuredQueryResult(result);
                } catch (error) {
                    partial = true;
                    const message = error instanceof Error ? error.message : String(error);
                    errors.push(`${description}: ${message}`);
                    return [];
                }
            };

            const safeDatabaseIdentifier = escapeSqlIdentifier(targetDatabase);
            const safeObjectLiteral = escapeSqlLiteral(parsed.objectName);
            const schemaFilter = parsed.schema ? ` AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(parsed.schema)})` : '';
            const typeFilter = requestedType
                ? ` AND OBJTYPE = '${requestedType}'`
                : ` AND OBJTYPE IN ('TABLE', 'VIEW', 'PROCEDURE')`;

            const targetLookupSql = `
                SELECT DBNAME, SCHEMA, OBJNAME, OBJTYPE
                FROM ${safeDatabaseIdentifier}.._V_OBJECT_DATA
                WHERE DBNAME = '${targetDatabase}'
                    AND UPPER(OBJNAME) = UPPER(${safeObjectLiteral})
                    ${schemaFilter}
                    ${typeFilter}
                ORDER BY SCHEMA, OBJTYPE
                LIMIT 25
            `;

            const targetRows = await runDependencyQuery(targetLookupSql, 'resolve dependency target');
            const resolvedTargets: ResolvedDependencyTarget[] = [];

            for (const row of targetRows) {
                const db = this.deps.runtime.getRowValue(row, 'DBNAME', 'DATABASE')?.toUpperCase() || targetDatabase;
                const schema = this.deps.runtime.getRowValue(row, 'SCHEMA')?.toUpperCase() || parsed.schema || 'ADMIN';
                const objectName = this.deps.runtime.getRowValue(row, 'OBJNAME', 'OBJECT_NAME', 'TABLENAME', 'VIEWNAME', 'PROCEDURE')?.toUpperCase();
                const normalizedType = this.normalizeDependencyObjectType(this.deps.runtime.getRowValue(row, 'OBJTYPE', 'OBJECT_TYPE'));
                const finalType = normalizedType || requestedType;

                if (!objectName || !finalType) {
                    continue;
                }

                const id = `${db}.${schema}.${objectName}:${finalType}`;
                if (resolvedTargets.some(target => target.id === id)) {
                    continue;
                }

                resolvedTargets.push({
                    id,
                    database: db,
                    schema,
                    objectName,
                    objectType: finalType
                });
            }

            if (resolvedTargets.length === 0) {
                errors.push(
                    requestedType
                        ? `No ${requestedType} object found for '${parsed.input}' in database '${targetDatabase}'.`
                        : `No table/view/procedure object found for '${parsed.input}' in database '${targetDatabase}'.`
                );

                return this.deps.runtime.formatStructuredToolResponse({
                    summary: 'Dependency analysis completed with no resolved target.',
                    data: {
                        input: parsed.input,
                        requestedObjectType: requestedType ?? null,
                        database: targetDatabase,
                        partial: true,
                        targets: [],
                        dependencies: [],
                        graph: {
                            nodes: [],
                            edges: []
                        },
                        counts: {
                            targets: 0,
                            dependencies: 0,
                            byType: {
                                TABLE: 0,
                                VIEW: 0,
                                PROCEDURE: 0
                            }
                        }
                    },
                    errors,
                    nextActions: [
                        'Verify object name, schema and database scope.',
                        'Provide objectType explicitly when duplicates exist across object types.',
                        'Run get_ddl for the object to confirm it is visible in the current connection scope.'
                    ]
                });
            }

            if (resolvedTargets.length > 1) {
                partial = true;
                errors.push(
                    `Resolved ${resolvedTargets.length} candidate targets for '${parsed.input}'. Results include all candidates.`
                );
            }

            const dependenciesById = new Map<string, DependencyCandidate>();
            const addDependency = (candidate: Omit<DependencyCandidate, 'id'>) => {
                const id = `${candidate.targetId}|${candidate.database}|${candidate.schema}|${candidate.objectName}|${candidate.objectType}|${candidate.relationship}`;
                if (dependenciesById.has(id)) {
                    return;
                }
                dependenciesById.set(id, { ...candidate, id });
            };
            const sourceReferenceExtractor = new TableReferenceExtractor();

            for (const target of resolvedTargets) {
                const targetObjectLiteral = escapeSqlLiteral(target.objectName);
                const targetSchemaLiteral = escapeSqlLiteral(target.schema);
                const tokenPredicateForViews = this.buildContainsPredicate('DEFINITION', this.getDependencySearchTokens(target));
                const tokenPredicateForProcedures = this.buildContainsPredicate(
                    'PROCEDURESOURCE',
                    this.getDependencySearchTokens(target)
                );

                if (target.objectType === 'TABLE') {
                    const foreignKeySql = `
                        SELECT DATABASE, SCHEMA, RELATION AS DEPENDENT_OBJECT, CONSTRAINTNAME
                        FROM ${safeDatabaseIdentifier}.._V_RELATION_KEYDATA
                        WHERE CONTYPE = 'f'
                            AND UPPER(PKRELATION) = UPPER(${targetObjectLiteral})
                            AND UPPER(PKSCHEMA) = UPPER(${targetSchemaLiteral})
                        ORDER BY SCHEMA, RELATION, CONSTRAINTNAME
                        LIMIT 200
                    `;

                    const foreignKeyRows = await runDependencyQuery(foreignKeySql, 'find foreign-key dependencies');
                    for (const row of foreignKeyRows) {
                        const dependentDatabase = this.deps.runtime.getRowValue(row, 'DATABASE')?.toUpperCase() || target.database;
                        const dependentSchema = this.deps.runtime.getRowValue(row, 'SCHEMA')?.toUpperCase() || target.schema;
                        const dependentObjectName = this.deps.runtime.getRowValue(row, 'DEPENDENT_OBJECT', 'RELATION')?.toUpperCase();
                        if (!dependentObjectName) {
                            continue;
                        }

                        const isSelfReference =
                            dependentDatabase === target.database &&
                            dependentSchema === target.schema &&
                            dependentObjectName === target.objectName &&
                            target.objectType === 'TABLE';
                        if (isSelfReference) {
                            continue;
                        }

                        addDependency({
                            targetId: target.id,
                            database: dependentDatabase,
                            schema: dependentSchema,
                            objectName: dependentObjectName,
                            objectType: 'TABLE',
                            relationship: 'FOREIGN_KEY',
                            evidence: this.deps.runtime.getRowValue(row, 'CONSTRAINTNAME') || 'Foreign key reference',
                            confidence: 0.98,
                            source: 'foreign_key_metadata'
                        });
                    }
                }

                const viewDependenciesSql = `
                    SELECT DATABASE, SCHEMA, VIEWNAME AS DEPENDENT_OBJECT, DEFINITION
                    FROM ${safeDatabaseIdentifier}.._V_VIEW
                    WHERE (${tokenPredicateForViews})
                        AND UPPER(VIEWNAME) <> UPPER(${targetObjectLiteral})
                    ORDER BY SCHEMA, VIEWNAME
                    LIMIT 200
                `;

                const dependentViewRows = await runDependencyQuery(viewDependenciesSql, 'find dependent views');
                for (const row of dependentViewRows) {
                    const dependentDatabase = this.deps.runtime.getRowValue(row, 'DATABASE')?.toUpperCase() || target.database;
                    const dependentSchema = this.deps.runtime.getRowValue(row, 'SCHEMA')?.toUpperCase() || target.schema;
                    const dependentObjectName = this.deps.runtime.getRowValue(row, 'DEPENDENT_OBJECT', 'VIEWNAME')?.toUpperCase();
                    if (!dependentObjectName) {
                        continue;
                    }

                    const isSelfReference =
                        dependentDatabase === target.database &&
                        dependentSchema === target.schema &&
                        dependentObjectName === target.objectName &&
                        target.objectType === 'VIEW';
                    if (isSelfReference) {
                        continue;
                    }

                    const viewEvidence =
                        this.evaluateSourceDependencyEvidence(
                            this.deps.runtime.getRowValue(row, 'DEFINITION'),
                            target,
                            'view',
                            sourceReferenceExtractor
                        )
                        || {
                            evidence: `Matched object token in VIEW.DEFINITION for ${target.objectName}`,
                            source: 'view_definition_text' as const,
                            confidence: 0.7
                        };

                    addDependency({
                        targetId: target.id,
                        database: dependentDatabase,
                        schema: dependentSchema,
                        objectName: dependentObjectName,
                        objectType: 'VIEW',
                        relationship: 'VIEW_SQL_REFERENCE',
                        evidence: viewEvidence.evidence,
                        confidence: viewEvidence.confidence,
                        source: viewEvidence.source
                    });
                }

                const procedureDependenciesSql = `
                    SELECT DATABASE, SCHEMA, PROCEDURE AS DEPENDENT_OBJECT, PROCEDURESOURCE
                    FROM ${safeDatabaseIdentifier}.._V_PROCEDURE
                    WHERE (${tokenPredicateForProcedures})
                        AND UPPER(PROCEDURE) <> UPPER(${targetObjectLiteral})
                    ORDER BY SCHEMA, PROCEDURE
                    LIMIT 200
                `;

                const dependentProcedureRows = await runDependencyQuery(procedureDependenciesSql, 'find dependent procedures');
                for (const row of dependentProcedureRows) {
                    const dependentDatabase = this.deps.runtime.getRowValue(row, 'DATABASE')?.toUpperCase() || target.database;
                    const dependentSchema = this.deps.runtime.getRowValue(row, 'SCHEMA')?.toUpperCase() || target.schema;
                    const dependentObjectName = this.deps.runtime.getRowValue(row, 'DEPENDENT_OBJECT', 'PROCEDURE')?.toUpperCase();
                    if (!dependentObjectName) {
                        continue;
                    }

                    const isSelfReference =
                        dependentDatabase === target.database &&
                        dependentSchema === target.schema &&
                        dependentObjectName === target.objectName &&
                        target.objectType === 'PROCEDURE';
                    if (isSelfReference) {
                        continue;
                    }

                    const procedureEvidence =
                        this.evaluateSourceDependencyEvidence(
                            this.deps.runtime.getRowValue(row, 'PROCEDURESOURCE'),
                            target,
                            'procedure',
                            sourceReferenceExtractor
                        )
                        || {
                            evidence: `Matched object token in PROCEDURESOURCE for ${target.objectName}`,
                            source: 'procedure_source_text' as const,
                            confidence: 0.68
                        };

                    addDependency({
                        targetId: target.id,
                        database: dependentDatabase,
                        schema: dependentSchema,
                        objectName: dependentObjectName,
                        objectType: 'PROCEDURE',
                        relationship: 'PROCEDURE_SQL_REFERENCE',
                        evidence: procedureEvidence.evidence,
                        confidence: procedureEvidence.confidence,
                        source: procedureEvidence.source
                    });
                }
            }

            const dependencies = Array.from(dependenciesById.values()).sort((left, right) => {
                if (left.objectType !== right.objectType) {
                    return left.objectType.localeCompare(right.objectType);
                }
                if (left.schema !== right.schema) {
                    return left.schema.localeCompare(right.schema);
                }
                return left.objectName.localeCompare(right.objectName);
            });

            const nodeMap = new Map<string, {
                id: string;
                role: 'target' | 'dependent';
                database: string;
                schema: string;
                objectName: string;
                objectType: DependencyObjectType;
            }>();
            const edges: Array<{
                from: string;
                to: string;
                relationship: DependencyRelationship;
                evidence: string;
                confidence: number;
                source: DependencySource;
                evidenceSource: DependencySource;
            }> = [];

            for (const target of resolvedTargets) {
                nodeMap.set(target.id, {
                    id: target.id,
                    role: 'target',
                    database: target.database,
                    schema: target.schema,
                    objectName: target.objectName,
                    objectType: target.objectType
                });
            }

            for (const dependency of dependencies) {
                const dependencyNodeId = `${dependency.database}.${dependency.schema}.${dependency.objectName}:${dependency.objectType}`;
                if (!nodeMap.has(dependencyNodeId)) {
                    nodeMap.set(dependencyNodeId, {
                        id: dependencyNodeId,
                        role: 'dependent',
                        database: dependency.database,
                        schema: dependency.schema,
                        objectName: dependency.objectName,
                        objectType: dependency.objectType
                    });
                }

                edges.push({
                    from: dependencyNodeId,
                    to: dependency.targetId,
                    relationship: dependency.relationship,
                    evidence: dependency.evidence,
                    confidence: dependency.confidence,
                    source: dependency.source,
                    evidenceSource: dependency.source
                });
            }

            const countsByType = {
                TABLE: dependencies.filter(d => d.objectType === 'TABLE').length,
                VIEW: dependencies.filter(d => d.objectType === 'VIEW').length,
                PROCEDURE: dependencies.filter(d => d.objectType === 'PROCEDURE').length
            };
            const countsBySource: Record<DependencySource, number> = {
                foreign_key_metadata: 0,
                view_definition_sql_parse: 0,
                view_definition_text: 0,
                procedure_source_sql_parse: 0,
                procedure_source_text: 0
            };
            for (const dependency of dependencies) {
                countsBySource[dependency.source] += 1;
            }

            const summaryPrefix = partial ? 'Dependency analysis completed with partial results.' : 'Dependency analysis completed.';
            return this.deps.runtime.formatStructuredToolResponse({
                summary: `${summaryPrefix} Found ${dependencies.length} dependency(ies) for ${resolvedTargets.length} target object(s).`,
                data: {
                    input: parsed.input,
                    requestedObjectType: requestedType ?? null,
                    database: targetDatabase,
                    partial,
                    targets: resolvedTargets,
                        dependencies: dependencies.map(item => ({
                            targetId: item.targetId,
                            database: item.database,
                            schema: item.schema,
                            objectName: item.objectName,
                            objectType: item.objectType,
                            relationship: item.relationship,
                            evidence: item.evidence,
                            confidence: item.confidence,
                            source: item.source,
                            evidenceSource: item.source
                        })),
                        graph: {
                            nodes: Array.from(nodeMap.values()),
                            edges
                        },
                        counts: {
                            targets: resolvedTargets.length,
                            dependencies: dependencies.length,
                            byType: countsByType,
                            bySource: countsBySource
                        }
                    },
                errors,
                nextActions: dependencies.length === 0
                    ? [
                        'No dependencies were detected. Confirm object scope (database/schema/objectType).',
                        'Run get_ddl and inspect source for dynamic SQL patterns not visible in metadata.',
                        'For cross-database checks, pass database explicitly in the tool input.'
                    ]
                    : [
                        'Review dependencies before changing or dropping the target object.',
                        'Use get_ddl for each dependent object to validate exact impact.',
                        'Validate migration scripts with validate_sql_on_database before execution.'
                    ]
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.deps.runtime.formatStructuredToolResponse({
                summary: 'Dependency analysis failed.',
                data: {
                    input: object,
                    database: database ?? null
                },
                errors: [message],
                nextActions: [
                    'Verify the object format and active connection state.',
                    'Use objectName in TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE format.',
                    'Retry with explicit database and objectType for deterministic matching.'
                ]
            });
        }
    }
}
