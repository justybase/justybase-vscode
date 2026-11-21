import { tokenMatcher, type CstNode, type TokenType } from 'chevrotain';
import { BaseSqlParser } from '../../../sqlParser/BaseSqlParser';
import * as t from './lexer';

type Rule = () => CstNode;

/**
 * Command tails (`GRANT …`, `COPY …`, `SET …`, `VACUUM …`) are not a
 * structured grammar: they mix keywords that are reserved elsewhere. The
 * shared tail only accepts the narrow relaxed-identifier set, which made
 * PostgreSQL report syntax errors on valid administrative statements
 * (`GRANT SELECT …`, `SET search_path TO …`, `COPY … FROM …`).
 *
 * `Identifier` and `StringLiteral` are categories in the PostgreSQL lexer, so
 * consuming them also accepts their members (unicode identifiers, dollar
 * quoted and escape strings). Members are excluded to avoid duplicate
 * alternatives for the same token.
 */
const POSTGRESQL_COMMAND_TAIL_EXCLUDED_TOKENS = new Set([
  'UnicodeIdentifier',
  'DollarQuotedString',
  'EscapeString',
  'UnterminatedEscapeString',
  'Semicolon',
  'WhiteSpace',
  'LineComment',
  'BlockComment',
]);

/** Statement heads that lex as identifiers because PostgreSQL reserves no keyword for them. */
const POSTGRESQL_IDENTIFIER_COMMAND_HEADS = new Set([
  'ABORT',
  'ANALYZE',
  'CHECKPOINT',
  'CLUSTER',
  'DEALLOCATE',
  'DISCARD',
  'IMPORT',
  'LISTEN',
  'LOAD',
  'NOTIFY',
  'PREPARE',
  'REASSIGN',
  'REFRESH',
  'RELEASE',
  'SAVEPOINT',
  'SECURITY',
  'START',
  'UNLISTEN',
  'VACUUM',
  'MOVE',
  'CLOSE',
]);

/**
 * Words that end a routine type. Most routine attributes lex as identifiers in
 * PostgreSQL, so a type rule must stop before them instead of consuming them
 * as an extra type word.
 */
const POSTGRESQL_ROUTINE_TYPE_STOP_WORDS = new Set([
  'IMMUTABLE',
  'STABLE',
  'VOLATILE',
  'LEAKPROOF',
  'STRICT',
  'CALLED',
  'SECURITY',
  'PARALLEL',
  'COST',
  'ROWS',
  'SUPPORT',
  'EXTERNAL',
  'EXISTS',
  'FORMAT',
  'NESTED',
]);

/** `CREATE <object>` forms that have no dedicated rule yet. */
const POSTGRESQL_MODELED_CREATE_HEADS = new Set<string>([
  'FunctionKeyword',
  'Procedure',
  'Type',
  'Domain',
  'Index',
  'Unique',
  'Do',
  'Merge',
  'Global',
  'Temp',
  'Temporary',
  'Table',
  'Sequence',
  'Schema',
  'Materialized',
  'View',
]);

/** `DROP <object>` forms already modeled by the shared drop rule. */
const POSTGRESQL_MODELED_DROP_HEADS = new Set<string>([
  'Table',
  'View',
  'Procedure',
  'Database',
  'Group',
  'Schema',
  'Sequence',
  'Session',
  'Synonym',
]);

/** `CREATE <object>` tails accepted as untyped PostgreSQL commands. */
const POSTGRESQL_CREATE_FALLBACK_OBJECTS = new Set([
  'ACCESS',
  'AGGREGATE',
  'CAST',
  'COLLATION',
  'CONSTRAINT',
  'CONVERSION',
  'DATABASE',
  'EVENT',
  'EXTENSION',
  'FOREIGN',
  'LANGUAGE',
  'OPERATOR',
  'POLICY',
  'PUBLICATION',
  'ROLE',
  'RULE',
  'SERVER',
  'STATISTICS',
  'SUBSCRIPTION',
  'TABLESPACE',
  'TEXT',
  'TRANSFORM',
  'TRIGGER',
  'USER',
]);

/** `DROP <object>` tails accepted as untyped PostgreSQL commands. */
const POSTGRESQL_DROP_FALLBACK_OBJECTS = new Set([
  'ACCESS',
  'AGGREGATE',
  'CAST',
  'COLLATION',
  'CONSTRAINT',
  'CONVERSION',
  'EVENT',
  'EXTENSION',
  'FOREIGN',
  'LANGUAGE',
  'OPERATOR',
  'OWNED',
  'POLICY',
  'PUBLICATION',
  'ROLE',
  'ROUTINE',
  'RULE',
  'SERVER',
  'STATISTICS',
  'SUBSCRIPTION',
  'TABLESPACE',
  'TEXT',
  'TRANSFORM',
  'TRIGGER',
]);

/** `ALTER <object>` tails accepted as untyped PostgreSQL commands. */
const POSTGRESQL_ALTER_FALLBACK_OBJECTS = new Set([
  'ACCESS',
  'AGGREGATE',
  'CAST',
  'COLLATION',
  'CONVERSION',
  'DATABASE',
  'DEFAULT',
  'DOMAIN',
  'EVENT',
  'EXTENSION',
  'FOREIGN',
  'FUNCTION',
  'GROUP',
  'INDEX',
  'LANGUAGE',
  'LARGE',
  'MATERIALIZED',
  'OPERATOR',
  'POLICY',
  'PROCEDURE',
  'PUBLICATION',
  'ROLE',
  'RULE',
  'SCHEMA',
  'SEQUENCE',
  'SERVER',
  'STATISTICS',
  'SUBSCRIPTION',
  'SYSTEM',
  'TABLESPACE',
  'TEXT',
  'TRANSFORM',
  'TRIGGER',
  'TYPE',
  'USER',
  'VIEW',
]);

function isTokenType(value: unknown): value is TokenType {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { name?: unknown }).name === 'string'
    && typeof (value as { tokenTypeIdx?: unknown }).tokenTypeIdx === 'number';
}

/** PostgreSQL rules keep shared CST names without inheriting Netezza grammar. */
export class PostgreSqlParser extends BaseSqlParser {
  declare postgresqlReturning: Rule;
  declare postgresqlOnConflict: Rule;
  declare arrayExpression: Rule;
  declare postgresqlPostfixExpression: Rule;
  declare postgresqlJsonExpression: Rule;
  declare postgresqlWindowClause: Rule;
  declare postgresqlWindowSpec: Rule;
  declare postgresqlValuesQuery: Rule;
  declare postgresqlUsingClause: Rule;
  declare postgresqlTransaction: Rule;
  declare postgresqlCreateRoutine: Rule;
  declare postgresqlDoStatement: Rule;
  declare postgresqlCreateType: Rule;
  declare postgresqlCreateIndex: Rule;
  declare postgresqlMergeWhen: Rule;
  declare postgresqlJsonTable: Rule;
  declare postgresqlJsonTableColumn: Rule;
  declare postgresqlJsonTableRegularColumn: Rule;
  declare postgresqlJsonTableNested: Rule;
  declare postgresqlJsonTableWrapper: Rule;
  declare postgresqlJsonTableQuotes: Rule;
  declare postgresqlJsonTableOnClause: Rule;
  declare postgresqlRoutineArgument: Rule;
  declare postgresqlRoutineType: Rule;
  declare postgresqlRoutineTypeWord: Rule;
  declare postgresqlRoutineTableColumn: Rule;
  declare postgresqlRoutineOption: Rule;
  declare postgresqlRoutineAttribute: Rule;
  declare postgresqlRoutineSecurityOption: Rule;
  declare postgresqlRoutineSet: Rule;
  declare postgresqlRoutineSetValue: Rule;
  declare postgresqlRoutineBody: Rule;
  declare postgresqlReloptionValue: Rule;
  declare postgresqlAtomicBody: Rule;
  declare postgresqlAlterAction: Rule;
  declare postgresqlTableOption: Rule;
  declare postgresqlEnableDisableAction: Rule;
  declare postgresqlForceRowSecurityAction: Rule;
  declare postgresqlNoForceRowSecurityAction: Rule;
  declare postgresqlInheritAction: Rule;
  declare postgresqlReloptionName: Rule;
  declare postgresqlSetTableAction: Rule;
  declare postgresqlReplicaIdentityAction: Rule;
  declare postgresqlValidateConstraintAction: Rule;
  declare postgresqlPartitionValueList: Rule;
  declare postgresqlPartitionBound: Rule;
  declare postgresqlPartitionAction: Rule;
  declare postgresqlReloptionList: Rule;
  declare postgresqlLikeClause: Rule;
  declare postgresqlIndexColumn: Rule;
  declare postgresqlLockingClause: Rule;
  declare postgresqlTableSampleClause: Rule;
  declare postgresqlRowExpression: Rule;
  declare postgresqlSubstringExpression: Rule;
  declare postgresqlTrimExpression: Rule;
  declare postgresqlPositionExpression: Rule;
  declare postgresqlOverlayExpression: Rule;
  declare postgresqlDropRoutineStatement: Rule;
  declare postgresqlCommandTailTokenPart1: Rule;
  declare postgresqlCommandTailTokenPart2: Rule;
  declare postgresqlCommandTailTokenPart3: Rule;
  declare postgresqlIdentifierCommandStatement: Rule;
  declare postgresqlCreateFallbackStatement: Rule;
  declare postgresqlAlterFallbackStatement: Rule;
  declare postgresqlDropFallbackStatement: Rule;
  declare postgresqlDeclareStatement: Rule;
  declare postgresqlFetchStatement: Rule;
  declare postgresqlDropUserMappingStatement: Rule;

  constructor() {
    super(t);
    this.registerPostgresqlRules();
    this.registerAdvancedPostgresqlRules();
    this.registerPostgresqlStatementOverrides();
    this.registerPostgresqlFallbackRules();
    this.finalizeParser();
  }

  protected supportsDropIfExistsBeforeTarget(): boolean { return true; }
  protected supportsStandaloneOffsetClause(): boolean { return true; }

  protected getForeignKeyActions(): readonly string[] { return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']; }

  protected registerCreateTableDialectClauses(): void {
    this.MANY(() => this.SUBRULE(this.postgresqlTableOption));
  }

  private functionAhead(): boolean {
    let i = 1;
    while (i < 12) {
      if (this.LA(i + 1).tokenType === t.LParen) return true;
      if (this.LA(i + 1).tokenType !== t.Dot) return false;
      i += 2;
    }
    return false;
  }


  private registerAdvancedPostgresqlRules(): void {
    this.RULE('postgresqlTableOption', () => this.OR([
      { ALT: () => {
        this.CONSUME(t.PartitionBy);
        this.OR1([
          { ALT: () => this.CONSUME(t.Range) },
          { ALT: () => this.CONSUME(t.Hash) },
          { GATE: () => this.LA(1).image.toUpperCase() === 'LIST', ALT: () => this.CONSUME(t.Identifier) },
        ]);
        this.SUBRULE(this.columnList);
      } },
      { ALT: () => {
        this.CONSUME(t.Tablespace); this.SUBRULE(this.identifier);
      } },
      { ALT: () => {
        this.CONSUME(t.On); this.CONSUME(t.Commit);
        this.OR2([
          { ALT: () => this.CONSUME(t.Drop) },
          { ALT: () => { this.CONSUME(t.Delete); this.CONSUME(t.Rows); } },
          { GATE: () => this.LA(1).image.toUpperCase() === 'PRESERVE', ALT: () => { this.CONSUME2(t.Identifier); this.CONSUME1(t.Rows); } },
        ]);
      } },
      { GATE: () => this.isPostgresqlImageOneOf('INHERITS'), ALT: () => {
        this.CONSUME3(t.Identifier); // INHERITS
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.qualifiedName) });
        this.CONSUME(t.RParen);
      } },
      { ALT: () => {
        this.CONSUME(t.With);
        this.SUBRULE(this.postgresqlReloptionList);
      } },
      { GATE: () => this.isPostgresqlImageOneOf('WITHOUT'), ALT: () => {
        this.CONSUME4(t.Identifier); // WITHOUT
        this.CONSUME5(t.Identifier); // OIDS
      } },
      { ALT: () => {
        this.CONSUME(t.Using);
        this.SUBRULE1(this.identifier);
      } },
    ]));

    this.RULE('postgresqlAlterAction', () => {
      let addIfNotExists = false;
      this.OR([
      { GATE: () => this.isPostgresqlImageOneOf('ENABLE', 'DISABLE'), ALT: () => this.SUBRULE(this.postgresqlEnableDisableAction) },
      { GATE: () => this.isPostgresqlImageOneOf('FORCE'), ALT: () => this.SUBRULE(this.postgresqlForceRowSecurityAction) },
      { GATE: () => this.isPostgresqlImageOneOf('NO'), ALT: () => this.SUBRULE(this.postgresqlNoForceRowSecurityAction) },
      { GATE: () => this.isPostgresqlImageOneOf('INHERIT'), ALT: () => this.SUBRULE(this.postgresqlInheritAction) },
      { GATE: () => this.LA(1).tokenType === t.Set || this.LA(1).tokenType === t.Reset, ALT: () => this.SUBRULE(this.postgresqlSetTableAction) },
      { GATE: () => this.isPostgresqlImageOneOf('REPLICA'), ALT: () => this.SUBRULE(this.postgresqlReplicaIdentityAction) },
      { GATE: () => this.isPostgresqlImageOneOf('VALIDATE'), ALT: () => this.SUBRULE(this.postgresqlValidateConstraintAction) },
      { GATE: () => this.isPostgresqlImageOneOf('ATTACH', 'DETACH'), ALT: () => this.SUBRULE(this.postgresqlPartitionAction) },
      { ALT: () => {
        this.CONSUME(t.Add); this.OPTION(() => this.CONSUME(t.Column));
        this.OPTION6(() => {
          this.CONSUME(t.If); this.CONSUME2(t.Not); this.CONSUME(t.Exists);
          addIfNotExists = true;
        });
        this.OR1([
          { GATE: () => !addIfNotExists, ALT: () => this.SUBRULE(this.tableConstraintDefinition) },
          { ALT: () => this.SUBRULE(this.columnDefinition) },
        ]);
      } },
      { ALT: () => {
        this.CONSUME(t.Drop);
        this.OPTION1(() => this.OR2([{ ALT: () => this.CONSUME1(t.Column) }, { ALT: () => this.CONSUME(t.Constraint) }]));
        this.OPTION7(() => { this.CONSUME1(t.If); this.CONSUME1(t.Exists); });
        this.SUBRULE(this.identifier);
        this.OPTION2(() => this.OR3([{ ALT: () => this.CONSUME(t.Cascade) }, { ALT: () => this.CONSUME(t.Restrict) }]));
      } },
      { ALT: () => {
        this.CONSUME(t.Alter); this.OPTION3(() => this.CONSUME2(t.Column)); this.SUBRULE1(this.identifier);
        this.OR4([
          { ALT: () => { this.CONSUME(t.Type); this.SUBRULE(this.typeName); this.OPTION4(() => { this.CONSUME(t.Using); this.SUBRULE(this.expression); }); } },
          { ALT: () => { this.CONSUME(t.Set); this.OR5([
            { ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Null); } },
            { ALT: () => { this.CONSUME(t.Default); this.SUBRULE1(this.expression); } },
          ]); } },
          { ALT: () => { this.CONSUME1(t.Drop); this.OR6([
            { ALT: () => { this.CONSUME1(t.Not); this.CONSUME1(t.Null); } },
            { ALT: () => this.CONSUME1(t.Default) },
          ]); } },
        ]);
      } },
      { ALT: () => {
        this.CONSUME(t.Rename);
        this.OPTION5(() => { this.CONSUME3(t.Column); this.SUBRULE2(this.identifier); });
        this.CONSUME(t.To); this.SUBRULE3(this.identifier);
      } },
      { ALT: () => { this.CONSUME(t.Owner); this.CONSUME1(t.To); this.SUBRULE4(this.identifier); } },
      ]);
    });

    this.RULE('postgresqlEnableDisableAction', () => {
      this.CONSUME(t.Identifier); // ENABLE | DISABLE
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.Row, ALT: () => {
          this.CONSUME(t.Row);
          this.CONSUME1(t.Identifier); // LEVEL
          this.CONSUME2(t.Identifier); // SECURITY
        } },
        { GATE: () => this.isPostgresqlImageOneOf('ALWAYS', 'REPLICA'), ALT: () => {
          this.CONSUME3(t.Identifier); // ALWAYS | REPLICA
          this.CONSUME1(t.Row);
          this.CONSUME4(t.Identifier); // LEVEL
          this.CONSUME5(t.Identifier); // SECURITY
        } },
        { GATE: () => this.isPostgresqlImageOneOf('TRIGGER'), ALT: () => {
          this.CONSUME6(t.Identifier); // TRIGGER
          this.OPTION(() => this.OR1([
            { ALT: () => this.CONSUME(t.All) },
            { ALT: () => this.SUBRULE(this.identifier) },
          ]));
        } },
        { GATE: () => this.LA(1).tokenType === t.Rule, ALT: () => {
          this.CONSUME(t.Rule);
          this.SUBRULE1(this.identifier);
        } },
      ]);
    });

    this.RULE('postgresqlForceRowSecurityAction', () => {
      this.CONSUME(t.Identifier); // FORCE
      this.CONSUME(t.Row);
      this.CONSUME1(t.Identifier); // LEVEL
      this.CONSUME2(t.Identifier); // SECURITY
    });

    this.RULE('postgresqlNoForceRowSecurityAction', () => {
      this.CONSUME(t.Identifier); // NO
      this.OR([
        { GATE: () => this.isPostgresqlImageOneOf('FORCE'), ALT: () => {
          this.CONSUME1(t.Identifier); // FORCE
          this.CONSUME(t.Row);
          this.CONSUME2(t.Identifier); // LEVEL
          this.CONSUME3(t.Identifier); // SECURITY
        } },
        { GATE: () => this.isPostgresqlImageOneOf('INHERIT'), ALT: () => {
          this.CONSUME4(t.Identifier); // INHERIT
          this.SUBRULE(this.qualifiedName);
        } },
      ]);
    });

    this.RULE('postgresqlInheritAction', () => {
      this.CONSUME(t.Identifier); // INHERIT
      this.SUBRULE(this.qualifiedName);
    });

    this.RULE('postgresqlReloptionName', () => {
      this.SUBRULE(this.identifier);
      this.MANY(() => {
        this.CONSUME(t.Dot);
        this.SUBRULE1(this.identifier);
      });
    });

    this.RULE('postgresqlReloptionValue', () => this.OR([
      { ALT: () => this.CONSUME(t.StringLiteral) },
      { ALT: () => this.CONSUME(t.NumberLiteral) },
      { ALT: () => this.CONSUME(t.Identifier) },
      { ALT: () => this.CONSUME(t.QuotedIdentifier) },
      { ALT: () => this.CONSUME(t.Default) },
      { ALT: () => this.CONSUME(t.On) },
      { ALT: () => this.CONSUME(t.None) },
      { ALT: () => this.CONSUME(t.All) },
      { ALT: () => this.CONSUME(t.Current) },
      { ALT: () => this.CONSUME(t.Public) },
    ]));

    this.RULE('postgresqlSetTableAction', () => {
      this.OR([
        { ALT: () => this.CONSUME(t.Set) },
        { ALT: () => this.CONSUME(t.Reset) },
      ]);
      this.OR1([
        { GATE: () => this.LA(1).tokenType === t.LParen, ALT: () => {
          this.CONSUME(t.LParen);
          this.AT_LEAST_ONE_SEP({
            SEP: t.Comma,
            DEF: () => {
              this.SUBRULE(this.postgresqlReloptionName);
              this.OPTION(() => {
                this.CONSUME(t.Equals);
                this.SUBRULE(this.expression);
              });
            },
          });
          this.CONSUME(t.RParen);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('TABLESPACE', 'SCHEMA', 'ACCESS'), ALT: () => {
          this.OR2([
            { ALT: () => this.CONSUME(t.Schema) },
            { ALT: () => this.CONSUME(t.Tablespace) },
            { ALT: () => { this.CONSUME(t.Access); this.CONSUME1(t.Identifier); } }, // ACCESS METHOD
          ]);
          this.OR3([
            { ALT: () => this.SUBRULE(this.identifier) },
            { ALT: () => this.CONSUME(t.StringLiteral) },
          ]);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('LOGGED', 'UNLOGGED'), ALT: () => {
          this.CONSUME3(t.Identifier);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('WITHOUT'), ALT: () => {
          this.CONSUME4(t.Identifier); // WITHOUT
          this.CONSUME5(t.Identifier); // OIDS | CLUSTER
        } },
      ]);
    });

    this.RULE('postgresqlReplicaIdentityAction', () => {
      this.CONSUME(t.Identifier); // REPLICA
      this.CONSUME(t.Identity);
      this.OR([
        { GATE: () => this.isPostgresqlImageOneOf('DEFAULT', 'FULL', 'NOTHING'), ALT: () => this.OR1([
          { ALT: () => this.CONSUME(t.Default) },
          { ALT: () => this.CONSUME(t.Full) },
          { ALT: () => this.CONSUME(t.Nothing) },
        ]) },
        { GATE: () => this.LA(1).tokenType === t.Using, ALT: () => {
          this.CONSUME(t.Using);
          this.CONSUME(t.Index);
          this.SUBRULE(this.identifier);
        } },
      ]);
    });

    this.RULE('postgresqlValidateConstraintAction', () => {
      this.CONSUME(t.Identifier); // VALIDATE
      this.CONSUME(t.Constraint);
      this.SUBRULE(this.identifier);
    });

    this.RULE('postgresqlPartitionValueList', () => {
      this.CONSUME(t.LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: t.Comma,
        DEF: () => this.SUBRULE(this.expression),
      });
      this.CONSUME(t.RParen);
    });

    this.RULE('postgresqlPartitionBound', () => {
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.Default, ALT: () => this.CONSUME(t.Default) },
        { GATE: () => this.LA(1).tokenType === t.For, ALT: () => {
          this.CONSUME(t.For);
          this.CONSUME(t.Values);
          this.OR1([
            { GATE: () => this.LA(1).tokenType === t.From, ALT: () => {
              this.CONSUME(t.From);
              this.SUBRULE(this.postgresqlPartitionValueList);
              this.CONSUME(t.To);
              this.SUBRULE1(this.postgresqlPartitionValueList);
            } },
            { GATE: () => this.LA(1).tokenType === t.In, ALT: () => {
              this.CONSUME(t.In);
              this.SUBRULE2(this.postgresqlPartitionValueList);
            } },
            { GATE: () => this.LA(1).tokenType === t.With, ALT: () => {
              this.CONSUME(t.With);
              this.CONSUME(t.LParen);
              this.AT_LEAST_ONE_SEP({
                SEP: t.Comma,
                DEF: () => {
                  this.SUBRULE(this.identifier);
                  this.SUBRULE(this.expression);
                },
              });
              this.CONSUME(t.RParen);
            } },
          ]);
        } },
      ]);
    });

    this.RULE('postgresqlPartitionAction', () => {
      this.CONSUME(t.Identifier); // ATTACH | DETACH
      this.CONSUME1(t.Identifier); // PARTITION
      this.SUBRULE(this.qualifiedName);
      this.OPTION(() => this.SUBRULE(this.postgresqlPartitionBound));
      this.OPTION1(() => this.OR([
        { ALT: () => this.CONSUME(t.Concurrently) },
        { ALT: () => this.CONSUME2(t.Identifier) }, // FINALIZE
      ]));
    });

    this.OVERRIDE_RULE('alterTableStatement', () => {
      this.CONSUME(t.Alter); this.CONSUME(t.Table); this.SUBRULE(this.qualifiedName);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlAlterAction) });
    });

    this.RULE('postgresqlJsonTable', () => {
      this.CONSUME(t.JsonTable); this.CONSUME(t.LParen);
      this.SUBRULE(this.expression); this.CONSUME(t.Comma); this.CONSUME(t.StringLiteral);
      this.OPTION(() => { this.CONSUME(t.As); this.SUBRULE(this.identifier); });
      this.OPTION1({ GATE: () => this.isPostgresqlImageOneOf('PASSING'), DEF: () => {
        this.CONSUME(t.Identifier); // PASSING
        this.AT_LEAST_ONE_SEP1({ SEP: t.Comma, DEF: () => {
          this.SUBRULE1(this.expression);
          this.CONSUME1(t.As);
          this.SUBRULE1(this.identifier);
        } });
      } });
      this.CONSUME(t.Columns); this.CONSUME1(t.LParen);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlJsonTableColumn) });
      this.CONSUME(t.RParen);
      this.OPTION2(() => {
        this.OR([
          { ALT: () => this.CONSUME(t.Error) },
          { GATE: () => this.isPostgresqlImageOneOf('EMPTY'), ALT: () => {
            this.CONSUME1(t.Identifier); // EMPTY
            this.OPTION3(() => this.CONSUME(t.ArrayKeyword));
          } },
        ]);
        this.CONSUME(t.On); this.CONSUME1(t.Error);
      });
      this.CONSUME1(t.RParen);
    });
    this.RULE('postgresqlJsonTableColumn', () => {
      this.OR([
        { GATE: () => this.isPostgresqlImageOneOf('NESTED'), ALT: () => this.SUBRULE(this.postgresqlJsonTableNested) },
        { ALT: () => this.SUBRULE(this.postgresqlJsonTableRegularColumn) },
      ]);
    });
    this.RULE('postgresqlJsonTableRegularColumn', () => {
      this.SUBRULE(this.identifier);
      this.OR([
        { ALT: () => { this.CONSUME(t.For); this.CONSUME(t.Ordinality); } },
        { ALT: () => {
          this.SUBRULE(this.postgresqlRoutineType);
          this.OPTION(() => {
            this.CONSUME(t.Identifier); // FORMAT
            this.CONSUME1(t.Identifier); // JSON
            this.OPTION1(() => { this.CONSUME2(t.Identifier); this.CONSUME3(t.Identifier); }); // ENCODING UTF8
          });
          this.OPTION2({ GATE: () => this.LA(1).tokenType === t.Exists, DEF: () => this.CONSUME(t.Exists) });
          this.OPTION3(() => { this.CONSUME(t.Path); this.CONSUME(t.StringLiteral); });
          this.OPTION4(() => this.SUBRULE(this.postgresqlJsonTableWrapper));
          this.OPTION5(() => this.SUBRULE(this.postgresqlJsonTableQuotes));
          this.MANY(() => this.SUBRULE(this.postgresqlJsonTableOnClause));
        } },
      ]);
    });
    this.RULE('postgresqlJsonTableNested', () => {
      this.CONSUME(t.Identifier); // NESTED
      this.OPTION(() => this.CONSUME(t.Path));
      this.CONSUME(t.StringLiteral);
      this.OPTION1(() => { this.CONSUME(t.As); this.SUBRULE(this.identifier); });
      this.CONSUME(t.Columns);
      this.CONSUME(t.LParen);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlJsonTableColumn) });
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlJsonTableWrapper', () => {
      this.OR([
        { ALT: () => {
          this.CONSUME(t.With);
          this.OPTION({ GATE: () => this.isPostgresqlImageOneOf('CONDITIONAL', 'UNCONDITIONAL'), DEF: () => this.CONSUME(t.Identifier) });
          this.OPTION1(() => this.CONSUME(t.ArrayKeyword));
          this.CONSUME1(t.Identifier); // WRAPPER
        } },
        { GATE: () => this.isPostgresqlImageOneOf('WITHOUT'), ALT: () => {
          this.CONSUME2(t.Identifier); // WITHOUT
          this.OPTION2({ GATE: () => this.isPostgresqlImageOneOf('CONDITIONAL', 'UNCONDITIONAL'), DEF: () => this.CONSUME3(t.Identifier) });
          this.OPTION3(() => this.CONSUME1(t.ArrayKeyword));
          this.CONSUME4(t.Identifier); // WRAPPER
        } },
      ]);
    });
    this.RULE('postgresqlJsonTableQuotes', () => {
      this.OR([
        { GATE: () => this.isPostgresqlImageOneOf('KEEP'), ALT: () => this.CONSUME(t.Identifier) },
        { GATE: () => this.isPostgresqlImageOneOf('OMIT'), ALT: () => this.CONSUME1(t.Identifier) },
      ]);
      this.CONSUME2(t.Identifier); // QUOTES
      this.OPTION(() => {
        this.CONSUME(t.On);
        this.CONSUME3(t.Identifier); // SCALAR
        this.CONSUME4(t.Identifier); // STRING
      });
    });
    this.RULE('postgresqlJsonTableOnClause', () => {
      this.OR([
        { ALT: () => this.CONSUME(t.Error) },
        { ALT: () => this.CONSUME(t.Null) },
        { GATE: () => this.isPostgresqlImageOneOf('EMPTY'), ALT: () => {
          this.CONSUME(t.Identifier); // EMPTY
          this.OPTION(() => this.CONSUME(t.ArrayKeyword));
          this.OPTION1(() => this.CONSUME1(t.Identifier)); // OBJECT
        } },
        { ALT: () => { this.CONSUME(t.Default); this.SUBRULE(this.expression); } },
        { GATE: () => this.isPostgresqlImageOneOf('TRUE', 'FALSE', 'UNKNOWN'), ALT: () => this.CONSUME2(t.Identifier) },
      ]);
      this.CONSUME(t.On);
      this.OR1([
        { GATE: () => this.isPostgresqlImageOneOf('EMPTY'), ALT: () => this.CONSUME3(t.Identifier) },
        { ALT: () => this.CONSUME1(t.Error) },
      ]);
    });
    this.RULE('postgresqlMergeWhen', () => {
      let notMatched = false;
      let bySource = false;
      this.CONSUME(t.When);
      this.OPTION(() => { this.CONSUME(t.Not); notMatched = true; });
      this.CONSUME(t.Matched);
      this.OPTION1({ GATE: () => notMatched, DEF: () => {
        this.CONSUME(t.By);
        this.OR([{ ALT: () => { this.CONSUME(t.Source); bySource = true; } }, { ALT: () => this.CONSUME(t.Target) }]);
      } });
      this.OPTION2(() => { this.CONSUME(t.And); this.SUBRULE(this.expression); });
      this.CONSUME(t.Then);
      this.OR1([
        { GATE: () => !notMatched || bySource, ALT: () => {
          this.CONSUME(t.Update); this.CONSUME(t.Set);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.updateSetItem) });
        } },
        { GATE: () => !notMatched || bySource, ALT: () => this.CONSUME(t.Delete) },
        { ALT: () => { this.CONSUME(t.Do); this.CONSUME(t.Nothing); } },
        { GATE: () => notMatched && !bySource, ALT: () => {
          this.CONSUME(t.Insert);
          this.OPTION3(() => this.SUBRULE(this.columnList));
          this.OR2([{ ALT: () => this.SUBRULE(this.valuesClause) }, { ALT: () => { this.CONSUME(t.Default); this.CONSUME(t.Values); } }]);
        } },
      ]);
    });
    this.OVERRIDE_RULE('mergeStatement', () => {
      this.CONSUME(t.Merge); this.CONSUME(t.Into); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.CONSUME(t.Using); this.SUBRULE(this.tableSource);
      this.CONSUME(t.On); this.SUBRULE(this.expression);
      this.AT_LEAST_ONE(() => this.SUBRULE(this.postgresqlMergeWhen));
      this.OPTION1(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.RULE('postgresqlRoutineTypeWord', () => {
      this.OR([
        { ALT: () => this.CONSUME(t.Identifier) },
        { ALT: () => this.CONSUME(t.QuotedIdentifier) },
        { ALT: () => this.CONSUME(t.To) },
        { ALT: () => this.CONSUME(t.With) },
      ]);
    });
    this.RULE('postgresqlRoutineType', () => {
      this.SUBRULE(this.postgresqlRoutineTypeWord);
      this.MANY({ GATE: () => this.LA(1).tokenType === t.Dot || this.isPostgresqlRoutineTypeWordAhead(), DEF: () => {
        this.OR([
          { ALT: () => { this.CONSUME(t.Dot); this.SUBRULE1(this.postgresqlRoutineTypeWord); } },
          { ALT: () => this.SUBRULE2(this.postgresqlRoutineTypeWord) },
        ]);
      } });
      this.OPTION(() => {
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.typeArgument) });
        this.CONSUME(t.RParen);
      });
      this.MANY1(() => {
        this.CONSUME(t.LBracket);
        this.OPTION1(() => this.CONSUME(t.NumberLiteral));
        this.CONSUME(t.RBracket);
      });
      this.OPTION2(() => {
        this.CONSUME(t.ArrayKeyword);
        this.OPTION3(() => { this.CONSUME1(t.LBracket); this.CONSUME1(t.RBracket); });
      });
    });
    this.RULE('postgresqlRoutineTableColumn', () => {
      this.SUBRULE(this.identifier);
      this.SUBRULE(this.postgresqlRoutineType);
      this.OPTION(() => { this.CONSUME(t.Collate); this.SUBRULE1(this.identifier); });
    });
    this.RULE('postgresqlRoutineSetValue', () => {
      this.OR([
        { ALT: () => this.CONSUME(t.StringLiteral) },
        { ALT: () => this.CONSUME(t.NumberLiteral) },
        { ALT: () => this.CONSUME(t.Identifier) },
        { ALT: () => this.CONSUME(t.QuotedIdentifier) },
        { ALT: () => this.CONSUME(t.Default) },
        { ALT: () => this.CONSUME(t.On) },
        { ALT: () => this.CONSUME(t.None) },
        { ALT: () => this.CONSUME(t.All) },
        { ALT: () => this.CONSUME(t.Current) },
        { ALT: () => this.CONSUME(t.Public) },
      ]);
    });
    this.RULE('postgresqlRoutineArgument', () => {
      this.OPTION({ GATE: () => this.LA(1).tokenType === t.In || this.LA(1).tokenType === t.Out
        || this.LA(1).tokenType === t.Inout || this.isPostgresqlImageOneOf('VARIADIC'), DEF: () => this.OR([
        { ALT: () => this.CONSUME(t.In) },
        { ALT: () => this.CONSUME(t.Out) },
        { ALT: () => this.CONSUME(t.Inout) },
        { GATE: () => this.isPostgresqlImageOneOf('VARIADIC'), ALT: () => this.CONSUME(t.Identifier) },
      ]) });
      this.OPTION1({ GATE: () => this.isPostgresqlRoutineArgumentNameAhead(), DEF: () => this.SUBRULE(this.identifier) });
      this.SUBRULE(this.postgresqlRoutineType);
      this.OPTION2(() => { this.OR1([{ ALT: () => this.CONSUME(t.Default) }, { ALT: () => this.CONSUME(t.Equals) }]); this.SUBRULE(this.expression); });
    });
    this.RULE('postgresqlRoutineOption', () => {
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.Language, ALT: () => { this.CONSUME(t.Language); this.SUBRULE(this.identifier); } },
        { GATE: () => this.isPostgresqlImageOneOf('TRANSFORM'), ALT: () => {
          this.CONSUME(t.Identifier); // TRANSFORM
          this.CONSUME(t.For); this.CONSUME(t.Type);
          this.SUBRULE(this.postgresqlRoutineType);
          this.MANY(() => {
            this.CONSUME(t.Comma); this.CONSUME1(t.For); this.CONSUME1(t.Type);
            this.SUBRULE1(this.postgresqlRoutineType);
          });
        } },
        { GATE: () => this.LA(1).tokenType === t.Window, ALT: () => this.CONSUME(t.Window) },
        { GATE: () => this.LA(1).tokenType === t.Set, ALT: () => this.SUBRULE(this.postgresqlRoutineSet) },
        { GATE: () => this.isPostgresqlRoutineAttributeStart(), ALT: () => this.SUBRULE(this.postgresqlRoutineAttribute) },
        { GATE: () => this.isPostgresqlRoutineSecurityOptionStart(), ALT: () => this.SUBRULE(this.postgresqlRoutineSecurityOption) },
      ]);
    });
    this.RULE('postgresqlRoutineAttribute', () => {
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.Not, ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Identifier); } },
        { GATE: () => this.isPostgresqlImageOneOf('IMMUTABLE', 'STABLE', 'VOLATILE', 'LEAKPROOF', 'STRICT'), ALT: () => this.CONSUME1(t.Identifier) },
        { GATE: () => this.isPostgresqlImageOneOf('CALLED'), ALT: () => {
          this.CONSUME2(t.Identifier); this.CONSUME(t.On); this.CONSUME(t.Null); this.CONSUME3(t.Identifier); // INPUT
        } },
        { GATE: () => this.LA(1).tokenType === t.Returns && this.LA(2).tokenType === t.Null, ALT: () => {
          this.CONSUME(t.Returns); this.CONSUME1(t.Null); this.CONSUME1(t.On); this.CONSUME2(t.Null); this.CONSUME4(t.Identifier); // INPUT
        } },
      ]);
    });
    this.RULE('postgresqlRoutineSecurityOption', () => {
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.External, ALT: () => {
          this.CONSUME(t.External); this.CONSUME(t.Identifier); // SECURITY
          this.SUBRULE(this.identifier); // INVOKER | DEFINER
        } },
        { GATE: () => this.isPostgresqlImageOneOf('SECURITY'), ALT: () => {
          this.CONSUME1(t.Identifier); this.SUBRULE1(this.identifier);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('PARALLEL'), ALT: () => {
          this.CONSUME2(t.Identifier); this.SUBRULE2(this.identifier);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('COST'), ALT: () => { this.CONSUME3(t.Identifier); this.CONSUME(t.NumberLiteral); } },
        { GATE: () => this.LA(1).tokenType === t.Rows, ALT: () => { this.CONSUME(t.Rows); this.CONSUME1(t.NumberLiteral); } },
        { GATE: () => this.isPostgresqlImageOneOf('ROWS'), ALT: () => { this.CONSUME4(t.Identifier); this.CONSUME2(t.NumberLiteral); } },
        { GATE: () => this.isPostgresqlImageOneOf('SUPPORT'), ALT: () => { this.CONSUME5(t.Identifier); this.SUBRULE(this.qualifiedName); } },
      ]);
    });
    this.RULE('postgresqlRoutineSet', () => {
      this.CONSUME(t.Set); this.SUBRULE(this.qualifiedName);
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.From, ALT: () => { this.CONSUME(t.From); this.CONSUME(t.Current); } },
        { ALT: () => {
          this.OR1([
            { ALT: () => this.CONSUME(t.To) },
            { ALT: () => this.CONSUME(t.Equals) },
          ]);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlRoutineSetValue) });
        } },
      ]);
    });
    this.RULE('postgresqlAtomicBody', () => {
      this.CONSUME(t.Begin); this.CONSUME(t.Atomic);
      this.AT_LEAST_ONE(() => { this.SUBRULE(this.statement); this.CONSUME(t.Semicolon); });
      this.CONSUME(t.End);
    });
    this.RULE('postgresqlRoutineBody', () => {
      this.OR([
        { ALT: () => {
          this.CONSUME(t.As);
          this.CONSUME(t.StringLiteral);
          this.OPTION(() => { this.CONSUME(t.Comma); this.CONSUME1(t.StringLiteral); });
        } },
        { ALT: () => this.SUBRULE(this.postgresqlAtomicBody) },
      ]);
    });
    this.RULE('postgresqlCreateRoutine', () => {
      this.CONSUME(t.Create);
      this.OPTION(() => { this.CONSUME(t.Or); this.CONSUME(t.Replace); });
      let isProcedure = false;
      this.OR([
        { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => { this.CONSUME(t.Procedure); isProcedure = true; } },
      ]);
      this.SUBRULE(this.qualifiedName); this.CONSUME(t.LParen);
      this.OPTION1(() => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlRoutineArgument) }));
      this.CONSUME(t.RParen);
      this.OR1([
        { GATE: () => !isProcedure, ALT: () => {
          this.CONSUME(t.Returns);
          this.OR2([
            { GATE: () => this.LA(1).tokenType === t.Table, ALT: () => {
              this.CONSUME1(t.Table);
              this.CONSUME1(t.LParen);
              this.AT_LEAST_ONE_SEP2({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlRoutineTableColumn) });
              this.CONSUME1(t.RParen);
            } },
            { ALT: () => this.SUBRULE(this.postgresqlRoutineType) },
          ]);
        } },
        { GATE: () => isProcedure, ALT: () => { /* Procedures do not declare RETURNS. */ } },
      ]);
      this.MANY(() => this.SUBRULE(this.postgresqlRoutineOption));
      this.SUBRULE(this.postgresqlRoutineBody);
      this.MANY1(() => this.SUBRULE1(this.postgresqlRoutineOption));
    });
    this.RULE('postgresqlDoStatement', () => {
      this.CONSUME(t.Do);
      this.OPTION(() => { this.CONSUME(t.Language); this.SUBRULE(this.identifier); });
      this.CONSUME(t.StringLiteral);
      this.OPTION1(() => { this.CONSUME1(t.Language); this.SUBRULE1(this.identifier); });
    });
    this.RULE('postgresqlCreateType', () => {
      this.CONSUME(t.Create);
      this.OR([
        { ALT: () => {
          this.CONSUME(t.Type); this.SUBRULE(this.qualifiedName); this.CONSUME(t.As);
          this.OR1([
            { ALT: () => { this.CONSUME(t.Enum); this.CONSUME(t.LParen); this.MANY_SEP({ SEP: t.Comma, DEF: () => this.CONSUME(t.StringLiteral) }); this.CONSUME(t.RParen); } },
            { ALT: () => { this.CONSUME1(t.LParen); this.SUBRULE(this.columnDefinitionList); this.CONSUME1(t.RParen); } },
          ]);
        } },
        { ALT: () => {
          this.CONSUME(t.Domain); this.SUBRULE1(this.qualifiedName);
          this.OPTION(() => this.CONSUME1(t.As)); this.SUBRULE(this.typeName);
          this.MANY(() => this.OR2([
            { ALT: () => { this.CONSUME(t.Default); this.SUBRULE(this.additiveExpression); } },
            { ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Null); } },
            { ALT: () => this.SUBRULE(this.checkConstraint) },
          ]));
        } },
      ]);
    });
    this.RULE('postgresqlIndexColumn', () => {
      this.SUBRULE(this.expression);
      this.OPTION(() => { this.CONSUME(t.Collate); this.SUBRULE(this.identifier); });
      this.OPTION1({ GATE: () => this.LA(1).tokenType === t.Identifier || this.LA(1).tokenType === t.QuotedIdentifier, DEF: () => {
        this.SUBRULE1(this.identifier); // operator class
        this.OPTION2(() => {
          this.CONSUME(t.LParen);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => {
            this.SUBRULE(this.postgresqlReloptionName);
            this.CONSUME(t.Equals);
            this.SUBRULE(this.postgresqlReloptionValue);
          } });
          this.CONSUME(t.RParen);
        });
      } });
      this.OPTION3(() => this.OR([
        { ALT: () => this.CONSUME(t.Asc) },
        { ALT: () => this.CONSUME(t.Desc) },
      ]));
      this.OPTION4(() => {
        this.CONSUME(t.Nulls);
        this.OR1([
          { ALT: () => this.CONSUME(t.First) },
          { ALT: () => this.CONSUME(t.Identifier) }, // LAST
        ]);
      });
    });
    this.RULE('postgresqlCreateIndex', () => {
      this.CONSUME(t.Create); this.OPTION(() => this.CONSUME(t.Unique));
      this.CONSUME(t.Index); this.OPTION1(() => this.CONSUME(t.Concurrently));
      this.OPTION2(() => { this.CONSUME(t.If); this.CONSUME(t.Not); this.CONSUME(t.Exists); });
      this.OPTION3(() => this.SUBRULE(this.identifier)); // index name is optional
      this.CONSUME(t.On); this.SUBRULE(this.tableName);
      this.OPTION4(() => { this.CONSUME(t.Using); this.SUBRULE1(this.identifier); });
      this.CONSUME(t.LParen);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlIndexColumn) });
      this.CONSUME(t.RParen);
      this.OPTION5(() => { this.CONSUME(t.Include); this.SUBRULE(this.columnList); });
      this.OPTION6(() => { this.CONSUME(t.Nulls); this.CONSUME1(t.Not); this.CONSUME(t.Distinct); });
      this.OPTION7(() => { this.CONSUME(t.With); this.SUBRULE(this.postgresqlReloptionList); });
      this.OPTION8(() => { this.CONSUME(t.Tablespace); this.SUBRULE2(this.identifier); });
      this.OPTION9(() => this.SUBRULE(this.whereClause));
    });
    this.OVERRIDE_RULE('columnDefinition', () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.postgresqlLikeClause) },
        { ALT: () => {
      this.SUBRULE(this.columnName); this.SUBRULE(this.typeName);
      this.MANY(() => this.OR1([
        { ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Null); } },
        { ALT: () => this.CONSUME1(t.Null) },
        { ALT: () => { this.CONSUME(t.Default); this.SUBRULE(this.additiveExpression); } },
        { ALT: () => this.SUBRULE(this.constraintDefinition) },
        { ALT: () => {
          this.CONSUME(t.Generated);
          this.OR2([{ ALT: () => this.CONSUME(t.Always) }, { ALT: () => { this.CONSUME(t.By); this.CONSUME1(t.Default); } }]);
          this.CONSUME(t.As);
          this.OR3([
            { ALT: () => this.CONSUME(t.Identity) },
            { ALT: () => {
              this.CONSUME(t.LParen); this.SUBRULE(this.expression); this.CONSUME(t.RParen);
              this.OR4([{ ALT: () => this.CONSUME(t.Stored) }, { ALT: () => this.CONSUME(t.Virtual) }]);
            } },
          ]);
        } },
      ]));
        } },
      ]);
    });
    this.OVERRIDE_RULE('dropStatement', () => {
      this.CONSUME(t.Drop);
      this.OR([
        { ALT: () => this.CONSUME(t.Table) }, { ALT: () => this.CONSUME(t.View) },
        { ALT: () => { this.CONSUME(t.Materialized); this.CONSUME1(t.View); } },
        { ALT: () => this.CONSUME(t.Index) }, { ALT: () => this.CONSUME(t.Type) },
        { ALT: () => this.CONSUME(t.Domain) }, { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => this.CONSUME(t.Procedure) }, { ALT: () => this.CONSUME(t.Sequence) },
        { ALT: () => this.CONSUME(t.Schema) },
      ]);
      this.OPTION(() => { this.CONSUME(t.If); this.CONSUME(t.Exists); });
      this.SUBRULE(this.dropTargetList);
      this.OPTION1(() => this.OR1([{ ALT: () => this.CONSUME(t.Cascade) }, { ALT: () => this.CONSUME(t.Restrict) }]));
    });
  }

  private registerPostgresqlRules(): void {
    const commandTailTokens = Array.from(new Set(
      Object.values(t)
        .filter(isTokenType)
        .filter(tokenType => !POSTGRESQL_COMMAND_TAIL_EXCLUDED_TOKENS.has(tokenType.name)),
    ));
    // Chevrotain limits a single alternation to 256 alternatives. Split the
    // token vocabulary so the tail stays a flat, deterministic decision.
    const groupSize = Math.ceil(commandTailTokens.length / 3);
    const commandTailGroups = [
      commandTailTokens.slice(0, groupSize),
      commandTailTokens.slice(groupSize, groupSize * 2),
      commandTailTokens.slice(groupSize * 2),
    ];
    this.RULE('postgresqlCommandTailTokenPart1', () => this.OR(this.getTokenAlternatives(commandTailGroups[0])));
    this.RULE('postgresqlCommandTailTokenPart2', () => this.OR(this.getTokenAlternatives(commandTailGroups[1])));
    this.RULE('postgresqlCommandTailTokenPart3', () => this.OR(this.getTokenAlternatives(commandTailGroups[2])));
    this.OVERRIDE_RULE('commandTailToken', () => this.OR([
      { ALT: () => this.SUBRULE(this.postgresqlCommandTailTokenPart1) },
      { ALT: () => this.SUBRULE(this.postgresqlCommandTailTokenPart2) },
      { ALT: () => this.SUBRULE(this.postgresqlCommandTailTokenPart3) },
    ]));

    const nameTokens: TokenType[] = [
      t.Identifier, t.QuotedIdentifier, t.Replace, t.Left, t.Right,
      t.User, t.Type, t.Key, t.Public, t.Schema, t.Database, t.Materialized, t.Conflict, t.Nothing,
      t.FunctionKeyword, t.Index, t.Domain, t.Enum, t.Value, t.System,
      t.Identity, t.Stored, t.Virtual, t.Generated, t.Always, t.Include, t.Old, t.New, t.Path,
      t.Mapping, t.Unlogged, t.Copy, t.Hash, t.Add,
      t.Substring, t.Trim, t.Position, t.Overlay, t.Tablespace, t.Access,
    ];
    this.OVERRIDE_RULE('identifier', () => this.OR(this.getTokenAlternatives(nameTokens)));
    this.OVERRIDE_RULE('alias', () => this.SUBRULE(this.identifier));
    this.OVERRIDE_RULE('columnReference', () => {
      this.SUBRULE(this.identifier);
      this.MANY(() => { this.CONSUME(t.Dot); this.SUBRULE1(this.identifier); });
    });
    this.OVERRIDE_RULE('starExpression', () => {
      this.OPTION(() => { this.SUBRULE(this.identifier); this.CONSUME(t.Dot); });
      this.CONSUME(t.Multiply);
    });

    this.RULE('arrayExpression', () => {
      this.CONSUME(t.ArrayKeyword);
      this.CONSUME(t.LBracket);
      this.OPTION(() => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.expression) }));
      this.CONSUME(t.RBracket);
    });
    this.RULE('postgresqlRowExpression', () => {
      this.CONSUME(t.Row);
      this.CONSUME(t.LParen);
      this.OPTION(() => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.expression) }));
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlSubstringExpression', () => {
      this.CONSUME(t.Substring);
      this.CONSUME(t.LParen);
      this.SUBRULE(this.additiveExpression);
      this.OR([
        { ALT: () => {
          this.CONSUME(t.From);
          this.SUBRULE1(this.additiveExpression);
          this.OPTION(() => { this.CONSUME(t.For); this.SUBRULE2(this.additiveExpression); });
        } },
        { ALT: () => this.MANY(() => { this.CONSUME(t.Comma); this.SUBRULE3(this.additiveExpression); }) },
      ]);
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlTrimExpression', () => {
      this.CONSUME(t.Trim);
      this.CONSUME(t.LParen);
      this.OPTION({ GATE: () => this.isPostgresqlImageOneOf('BOTH', 'LEADING', 'TRAILING'), DEF: () => this.CONSUME(t.Identifier) });
      this.OPTION1({ GATE: () => this.LA(1).tokenType !== t.From, DEF: () => this.SUBRULE(this.additiveExpression) });
      this.OPTION2(() => { this.CONSUME(t.From); this.SUBRULE1(this.additiveExpression); });
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlPositionExpression', () => {
      this.CONSUME(t.Position);
      this.CONSUME(t.LParen);
      this.SUBRULE(this.additiveExpression);
      this.CONSUME(t.In);
      this.SUBRULE1(this.additiveExpression);
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlOverlayExpression', () => {
      this.CONSUME(t.Overlay);
      this.CONSUME(t.LParen);
      this.SUBRULE(this.additiveExpression);
      this.CONSUME(t.Identifier); // PLACING
      this.SUBRULE1(this.additiveExpression);
      this.CONSUME(t.From);
      this.SUBRULE2(this.additiveExpression);
      this.OPTION(() => { this.CONSUME(t.For); this.SUBRULE3(this.additiveExpression); });
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlPostfixExpression', () => {
      this.SUBRULE(this.primaryExpression);
      this.MANY({
        GATE: () => {
          const tokenType = this.LA(1).tokenType;
          return tokenType === t.DoubleColon
            || tokenType === t.LBracket
            || (this.isPostgresqlImageOneOf('AT') && this.LA(2).image?.toUpperCase() === 'TIME')
            || (this.isPostgresqlImageOneOf('SIMILAR') && this.LA(2).tokenType === t.To);
        },
        DEF: () => this.OR([
        { ALT: () => {
          this.CONSUME(t.DoubleColon);
          this.SUBRULE(this.typeName);
          this.MANY1(() => { this.CONSUME(t.LBracket); this.CONSUME(t.RBracket); });
        } },
        { ALT: () => {
          this.CONSUME1(t.LBracket);
          this.OR1([
            { ALT: () => { this.SUBRULE(this.expression); this.OPTION(() => { this.CONSUME(t.Colon); this.OPTION1(() => this.SUBRULE1(this.expression)); }); } },
            { ALT: () => { this.CONSUME1(t.Colon); this.OPTION2(() => this.SUBRULE2(this.expression)); } },
          ]);
          this.CONSUME1(t.RBracket);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('AT') && this.LA(2).image?.toUpperCase() === 'TIME', ALT: () => {
          this.CONSUME(t.Identifier); // AT
          this.CONSUME1(t.Identifier); // TIME
          this.CONSUME2(t.Identifier); // ZONE
          this.SUBRULE3(this.expression);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('SIMILAR') && this.LA(2).tokenType === t.To, ALT: () => {
          this.CONSUME3(t.Identifier); // SIMILAR
          this.CONSUME(t.To);
          this.SUBRULE4(this.expression);
          this.OPTION3(() => { this.CONSUME(t.Escape); this.SUBRULE5(this.expression); });
        } },
      ]),
      });
    });
    this.RULE('postgresqlJsonExpression', () => {
      this.SUBRULE(this.postgresqlPostfixExpression);
      this.MANY(() => {
        this.OR(this.getTokenAlternatives([
          t.JsonTextPath, t.JsonPath, t.JsonTextArrow, t.JsonArrow,
          t.JsonExists, t.JsonExistsAny, t.JsonExistsAll, t.JsonContains, t.JsonContained,
        ]));
        this.SUBRULE1(this.postgresqlPostfixExpression);
      });
    });
    this.OVERRIDE_RULE('castExpression', () => this.SUBRULE(this.postgresqlJsonExpression));
    this.OVERRIDE_RULE('primaryExpression', () => {
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.ArrayKeyword, ALT: () => this.SUBRULE(this.arrayExpression) },
        { GATE: () => this.LA(1).tokenType === t.Row && this.LA(2).tokenType === t.LParen, ALT: () => this.SUBRULE(this.postgresqlRowExpression) },
        { GATE: () => this.LA(1).tokenType === t.Substring && this.LA(2).tokenType === t.LParen, ALT: () => this.SUBRULE(this.postgresqlSubstringExpression) },
        { GATE: () => this.LA(1).tokenType === t.Trim && this.LA(2).tokenType === t.LParen, ALT: () => this.SUBRULE(this.postgresqlTrimExpression) },
        { GATE: () => this.LA(1).tokenType === t.Position && this.LA(2).tokenType === t.LParen, ALT: () => this.SUBRULE(this.postgresqlPositionExpression) },
        { GATE: () => this.LA(1).tokenType === t.Overlay && this.LA(2).tokenType === t.LParen, ALT: () => this.SUBRULE(this.postgresqlOverlayExpression) },
        { GATE: () => tokenMatcher(this.LA(1), t.StringLiteral) || [t.NumberLiteral, t.Null, t.DollarNumber].includes(this.LA(1).tokenType) || tokenMatcher(this.LA(2), t.StringLiteral), ALT: () => this.SUBRULE(this.literal) },
        { GATE: () => this.functionAhead(), ALT: () => this.SUBRULE(this.functionCall) },
        { ALT: () => this.SUBRULE(this.castFunctionExpression) },
        { ALT: () => this.SUBRULE(this.extractExpression) },
        { ALT: () => this.SUBRULE(this.caseExpression) },
        { ALT: () => this.SUBRULE(this.existsExpression) },
        { GATE: () => this.LA(2).tokenType === t.Select || this.LA(2).tokenType === t.With || this.LA(2).tokenType === t.Values, ALT: () => this.SUBRULE(this.subquery) },
        { ALT: () => this.SUBRULE(this.expressionList) },
        { ALT: () => this.CONSUME(t.Default) },
        { ALT: () => this.SUBRULE(this.columnReference) },
      ]);
    });
    this.OVERRIDE_RULE('functionCall', () => {
      this.SUBRULE(this.identifier);
      this.MANY(() => { this.CONSUME(t.Dot); this.SUBRULE1(this.identifier); });
      this.CONSUME(t.LParen);
      this.OPTION(() => this.OR([{ ALT: () => this.CONSUME(t.Distinct) }, { ALT: () => this.CONSUME(t.All) }]));
      this.OPTION1(() => this.SUBRULE(this.functionArguments));
      this.CONSUME(t.RParen);
      this.OPTION2(() => this.SUBRULE(this.filterClause));
      this.OPTION3(() => this.SUBRULE(this.withinGroupClause));
      this.OPTION4(() => this.SUBRULE(this.overClause));
    });
    this.OVERRIDE_RULE('functionArguments', () => {
      this.OR([
        { ALT: () => this.CONSUME(t.Multiply) },
        { ALT: () => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.expression) }) },
      ]);
      this.OPTION(() => this.SUBRULE(this.orderByClause));
    });

    this.OVERRIDE_RULE('typeName', () => {
      this.SUBRULE(this.typeNameWord);
      this.MANY({
        GATE: () => !this.isPostgresqlImageOneOf('SIMILAR', 'AT'),
        DEF: () => this.SUBRULE1(this.typeNameWord),
      });
      this.OPTION(() => {
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.typeArgument) });
        this.CONSUME(t.RParen);
      });
    });

    this.OVERRIDE_RULE('limitClause', () => {
      this.CONSUME(t.Limit);
      this.OR([
        { ALT: () => this.CONSUME(t.All) },
        { ALT: () => this.SUBRULE(this.expression) },
      ]);
    });

    this.OVERRIDE_RULE('updateSetItem', () => this.OR([
      { GATE: () => this.LA(1).tokenType === t.LParen, ALT: () => {
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.columnReference) });
        this.CONSUME(t.RParen);
        this.CONSUME(t.Equals);
        this.CONSUME1(t.LParen);
        this.OR1([
          { ALT: () => this.SUBRULE(this.selectStatement) },
          { ALT: () => this.SUBRULE(this.withStatement) },
          { ALT: () => this.AT_LEAST_ONE_SEP1({ SEP: t.Comma, DEF: () => this.SUBRULE(this.expression) }) },
        ]);
        this.CONSUME1(t.RParen);
      } },
      { ALT: () => {
        this.SUBRULE1(this.columnReference);
        this.CONSUME1(t.Equals);
        this.SUBRULE1(this.expression);
      } },
    ]));

    this.RULE('postgresqlValuesQuery', () => this.SUBRULE(this.valuesClause));
    this.OVERRIDE_RULE('subquery', () => {
      this.CONSUME(t.LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
      ]);
      this.CONSUME(t.RParen);
    });
    this.OVERRIDE_RULE('tableSource', () => {
      this.OPTION(() => this.CONSUME(t.Lateral));
      this.OR([
        { ALT: () => this.SUBRULE(this.postgresqlJsonTable) },
        { ALT: () => this.SUBRULE(this.subquery) },
        { GATE: () => this.functionAhead(), ALT: () => this.SUBRULE(this.functionCall) },
        { ALT: () => this.SUBRULE(this.tableName) },
      ]);
      this.OPTION1({ GATE: () => this.LA(1).tokenType === t.With && this.LA(2).tokenType === t.Ordinality, DEF: () => { this.CONSUME(t.With); this.CONSUME(t.Ordinality); } });
      this.OPTION2({ GATE: () => !this.isPostgresqlImageOneOf('TABLESAMPLE'), DEF: () => this.SUBRULE(this.aliasOptional) });
      this.OPTION4({ GATE: () => this.isPostgresqlImageOneOf('TABLESAMPLE'), DEF: () => this.SUBRULE(this.postgresqlTableSampleClause) });
      this.OPTION3(() => this.SUBRULE(this.cteColumnList));
    });
    this.OVERRIDE_RULE('cteDefinition', () => {
      this.CONSUME(t.Identifier);
      this.OPTION(() => this.SUBRULE(this.cteColumnList));
      this.CONSUME(t.As);
      this.OPTION1(() => { this.OPTION2(() => this.CONSUME(t.Not)); this.CONSUME(t.Materialized); });
      this.CONSUME(t.LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
        { ALT: () => this.SUBRULE(this.insertStatement) },
        { ALT: () => this.SUBRULE(this.updateStatement) },
        { ALT: () => this.SUBRULE(this.deleteStatement) },
      ]);
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlWindowSpec', () => {
      this.CONSUME(t.LParen);
      this.OPTION(() => this.CONSUME(t.Identifier));
      this.OPTION1(() => this.SUBRULE(this.partitionByClause));
      this.OPTION2(() => this.SUBRULE(this.orderByClause));
      this.OPTION3(() => this.SUBRULE(this.windowFrameClause));
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlWindowClause', () => {
      this.CONSUME(t.Window);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => {
        this.SUBRULE(this.identifier);
        this.CONSUME(t.As);
        this.SUBRULE(this.postgresqlWindowSpec);
      } });
    });
    this.OVERRIDE_RULE('overClause', () => {
      this.CONSUME(t.Over);
      this.OR([{ ALT: () => this.SUBRULE(this.postgresqlWindowSpec) }, { ALT: () => this.SUBRULE(this.identifier) }]);
    });
    this.OVERRIDE_RULE('selectStatement', () => {
      this.SUBRULE(this.selectClause);
      this.OPTION1(() => this.SUBRULE(this.fromClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
      this.OPTION3(() => this.SUBRULE(this.groupByClause));
      this.OPTION4(() => this.SUBRULE(this.havingClause));
      this.OPTION5(() => this.SUBRULE(this.postgresqlWindowClause));
      this.OPTION6(() => this.SUBRULE(this.orderByClause));
      this.MANY(() => this.OR([
        { GATE: () => this.LA(1).tokenType === t.Limit, ALT: () => this.SUBRULE(this.limitClause) },
        { GATE: () => this.LA(1).tokenType === t.Offset, ALT: () => this.SUBRULE(this.offsetClause) },
        { GATE: () => this.LA(1).tokenType === t.Fetch, ALT: () => this.SUBRULE(this.fetchFirstClause) },
        { GATE: () => this.LA(1).tokenType === t.For, ALT: () => this.SUBRULE(this.postgresqlLockingClause) },
      ]));
      this.MANY1(() => { this.SUBRULE(this.setOperation); this.SUBRULE1(this.selectStatement); });
    });
    this.OVERRIDE_RULE('setOperation', () => {
      this.OR([{ ALT: () => this.CONSUME(t.Union) }, { ALT: () => this.CONSUME(t.Intersect) }, { ALT: () => this.CONSUME(t.Except) }]);
      this.OPTION(() => this.OR1([{ ALT: () => this.CONSUME(t.All) }, { ALT: () => this.CONSUME(t.Distinct) }]));
    });
    this.OVERRIDE_RULE('selectModifier', () => this.OR([
      { ALT: () => { this.CONSUME(t.Distinct); this.OPTION(() => { this.CONSUME(t.On); this.SUBRULE(this.expressionList); }); } },
      { ALT: () => this.CONSUME(t.All) },
    ]));

    this.OVERRIDE_RULE('intoClause', () => {
      this.CONSUME(t.Into);
      this.OPTION(() => this.OR([
        { ALT: () => this.CONSUME(t.Temp) },
        { ALT: () => this.CONSUME(t.Temporary) },
      ]));
      this.OPTION1(() => this.CONSUME(t.Table));
      this.SUBRULE(this.qualifiedName);
    });

    this.RULE('postgresqlLockingClause', () => {
      this.CONSUME(t.For);
      this.OR([
        { ALT: () => this.CONSUME(t.Update) },
        { GATE: () => this.isPostgresqlImageOneOf('NO'), ALT: () => {
          this.CONSUME(t.Identifier); // NO
          this.CONSUME(t.Key);
          this.CONSUME1(t.Update);
        } },
        { GATE: () => this.isPostgresqlImageOneOf('SHARE'), ALT: () => this.CONSUME1(t.Identifier) },
        { GATE: () => this.isPostgresqlImageOneOf('KEY'), ALT: () => {
          this.CONSUME1(t.Key);
          this.CONSUME2(t.Identifier); // SHARE
        } },
      ]);
      this.OPTION(() => {
        this.CONSUME(t.Of);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.qualifiedName) });
      });
      this.OPTION1(() => this.OR1([
        { GATE: () => this.isPostgresqlImageOneOf('NOWAIT'), ALT: () => this.CONSUME3(t.Identifier) },
        { GATE: () => this.isPostgresqlImageOneOf('SKIP'), ALT: () => {
          this.CONSUME4(t.Identifier); // SKIP
          this.CONSUME5(t.Identifier); // LOCKED
        } },
      ]));
    });

    this.RULE('postgresqlTableSampleClause', () => {
      this.CONSUME(t.Identifier); // TABLESAMPLE
      this.SUBRULE(this.identifier); // method
      this.CONSUME(t.LParen);
      this.SUBRULE(this.expression);
      this.CONSUME(t.RParen);
      this.OPTION(() => {
        this.CONSUME1(t.Identifier); // REPEATABLE
        this.CONSUME1(t.LParen);
        this.SUBRULE1(this.expression);
        this.CONSUME1(t.RParen);
      });
    });

    this.OVERRIDE_RULE('comparisonRhs', () => this.OR([
      { GATE: () => [t.Any, t.Some, t.All].includes(this.LA(1).tokenType) && this.LA(2).tokenType === t.LParen, ALT: () => {
        this.OR1([
          { ALT: () => this.CONSUME(t.Any) },
          { ALT: () => this.CONSUME(t.Some) },
          { ALT: () => this.CONSUME(t.All) },
        ]);
        this.CONSUME(t.LParen);
        this.OR2([
          { GATE: () => this.LA(1).tokenType === t.ArrayKeyword, ALT: () => this.SUBRULE(this.arrayExpression) },
          { ALT: () => this.SUBRULE(this.selectStatement) },
          { ALT: () => this.SUBRULE(this.withStatement) },
          { ALT: () => this.SUBRULE(this.expression) },
        ]);
        this.CONSUME(t.RParen);
      } },
      { ALT: () => this.SUBRULE(this.additiveExpression) },
    ]));

    this.OVERRIDE_RULE('isExpression', () => {
      this.CONSUME(t.Is);
      this.OPTION(() => this.CONSUME(t.Not));
      this.OR([
        { ALT: () => this.CONSUME(t.Null) },
        { ALT: () => {
          this.CONSUME(t.Distinct);
          this.CONSUME(t.From);
          this.SUBRULE(this.additiveExpression);
        } },
        { ALT: () => this.CONSUME(t.Identifier) }, // TRUE | FALSE | UNKNOWN
      ]);
    });

    this.RULE('postgresqlReturning', () => {
      this.CONSUME(t.Returning);
      this.OPTION(() => {
        this.CONSUME(t.With); this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP1({ SEP: t.Comma, DEF: () => {
          this.OR([{ ALT: () => this.CONSUME(t.Old) }, { ALT: () => this.CONSUME(t.New) }]);
          this.CONSUME(t.As); this.SUBRULE(this.identifier);
        } });
        this.CONSUME(t.RParen);
      });
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.selectItem) });
    });
    this.RULE('postgresqlOnConflict', () => {
      let hasTarget = false;
      this.CONSUME(t.On); this.CONSUME(t.Conflict);
      this.OPTION(() => {
        hasTarget = true;
        this.OR([
          { ALT: () => {
            this.SUBRULE(this.expressionList);
            this.OPTION1(() => this.SUBRULE(this.whereClause));
          } },
          { ALT: () => { this.CONSUME1(t.On); this.CONSUME(t.Constraint); this.SUBRULE(this.identifier); } },
        ]);
      });
      this.CONSUME(t.Do);
      this.OR1([
        { ALT: () => this.CONSUME(t.Nothing) },
        { GATE: () => hasTarget, ALT: () => {
          this.CONSUME(t.Update); this.CONSUME(t.Set);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.updateSetItem) });
          this.OPTION2(() => this.SUBRULE1(this.whereClause));
        } },
      ]);
    });
    this.OVERRIDE_RULE('insertStatement', () => {
      this.CONSUME(t.Insert); this.CONSUME(t.Into); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => {
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.OR2([
          { ALT: () => this.CONSUME(t.Identifier) },
          { ALT: () => this.CONSUME(t.QuotedIdentifier) },
        ]) });
        this.CONSUME(t.RParen);
      });
      this.OPTION2(() => {
        this.CONSUME(t.Overriding);
        this.OR([{ ALT: () => this.CONSUME(t.System) }, { ALT: () => this.CONSUME(t.User) }]);
        this.CONSUME(t.Value);
      });
      this.OR1([
        { ALT: () => this.SUBRULE(this.valuesClause) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertWithClause) },
        { ALT: () => { this.CONSUME(t.Default); this.CONSUME(t.Values); } },
      ]);
      this.OPTION3(() => this.SUBRULE(this.postgresqlOnConflict));
      this.OPTION4(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.OVERRIDE_RULE('updateStatement', () => {
      this.CONSUME(t.Update); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.CONSUME(t.Set);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.updateSetItem) });
      this.OPTION1(() => this.SUBRULE(this.fromClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
      this.OPTION3(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.RULE('postgresqlUsingClause', () => {
      this.CONSUME(t.Using);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.tableReference) });
    });
    this.OVERRIDE_RULE('deleteStatement', () => {
      this.CONSUME(t.Delete); this.CONSUME(t.From); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => this.SUBRULE(this.postgresqlUsingClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
      this.OPTION3(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.OVERRIDE_RULE('explainStatement', () => {
      this.CONSUME(t.Explain);
      this.OR([
        { ALT: () => {
          this.CONSUME(t.LParen);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => {
            const format = this.LA(1).image.toUpperCase() === 'FORMAT';
            this.OR1([
              { GATE: () => /^(ANALYZE|COSTS|SETTINGS|GENERIC_PLAN|BUFFERS|WAL|TIMING|SUMMARY|FORMAT)$/i.test(this.LA(1).image), ALT: () => this.CONSUME(t.Identifier) },
              { ALT: () => this.CONSUME(t.Verbose) },
            ]);
            this.OR2([
              { GATE: () => format, ALT: () => {
                this.OR3([{ GATE: () => /^(TEXT|XML|JSON|YAML)$/i.test(this.LA(1).image), ALT: () => this.CONSUME1(t.Identifier) }]);
              } },
              { ALT: () => this.OPTION({ GATE: () => /^(TRUE|FALSE|ON|OFF|0|1)$/i.test(this.LA(1).image), DEF: () => {
                this.OR4([
                  { ALT: () => this.CONSUME2(t.Identifier) },
                  { ALT: () => this.CONSUME(t.On) },
                  { ALT: () => this.CONSUME(t.NumberLiteral) },
                ]);
              } }) },
            ]);
          } });
          this.CONSUME(t.RParen);
        } },
        { ALT: () => {
          this.OPTION1({ GATE: () => /^ANALYZE$/i.test(this.LA(1).image), DEF: () => this.CONSUME3(t.Identifier) });
          this.OPTION2(() => this.CONSUME1(t.Verbose));
        } },
      ]);
      this.OR5([
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
        { ALT: () => this.SUBRULE(this.insertStatement) },
        { ALT: () => this.SUBRULE(this.updateStatement) },
        { ALT: () => this.SUBRULE(this.deleteStatement) },
        { ALT: () => this.SUBRULE(this.mergeStatement) },
      ]);
    });
    this.RULE('postgresqlTransaction', () => {
      this.OR([{ ALT: () => this.CONSUME(t.Begin) }, { ALT: () => this.CONSUME(t.Commit) }, { ALT: () => this.CONSUME(t.Rollback) }]);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });
    this.OVERRIDE_RULE('statement', () => this.OR([
      { GATE: () => this.LA(2).tokenType === t.FunctionKeyword || this.LA(2).tokenType === t.Procedure || (this.LA(2).tokenType === t.Or && [t.FunctionKeyword, t.Procedure].includes(this.LA(4).tokenType)), ALT: () => this.SUBRULE(this.postgresqlCreateRoutine) },
      { GATE: () => [t.Type, t.Domain].includes(this.LA(2).tokenType), ALT: () => this.SUBRULE(this.postgresqlCreateType) },
      { GATE: () => this.LA(2).tokenType === t.Index || (this.LA(2).tokenType === t.Unique && this.LA(3).tokenType === t.Index), ALT: () => this.SUBRULE(this.postgresqlCreateIndex) },
      { ALT: () => this.SUBRULE(this.postgresqlDoStatement) },
      { ALT: () => this.SUBRULE(this.mergeStatement) },
      { ALT: () => this.SUBRULE(this.callStatement) },
      { ALT: () => this.SUBRULE(this.createTableStatement) },
      { ALT: () => this.SUBRULE(this.createSequenceStatement) },
      { ALT: () => this.SUBRULE(this.createSchemaStatement) },
      { ALT: () => this.SUBRULE(this.createViewStatement) },
      { ALT: () => this.SUBRULE(this.commentStatement) },
      { GATE: () => this.LA(1).tokenType === t.Drop && (this.LA(2).tokenType === t.FunctionKeyword || this.LA(2).tokenType === t.Procedure), ALT: () => this.SUBRULE(this.postgresqlDropRoutineStatement) },
      { GATE: () => this.LA(1).tokenType === t.Drop && this.LA(2).tokenType === t.User && this.LA(3).tokenType === t.Mapping, ALT: () => this.SUBRULE(this.postgresqlDropUserMappingStatement) },
      { ALT: () => this.SUBRULE(this.alterTableStatement) },
      { ALT: () => this.SUBRULE(this.dropStatement) },
      { ALT: () => this.SUBRULE(this.truncateStatement) },
      { ALT: () => this.SUBRULE(this.explainStatement) },
      { ALT: () => this.SUBRULE(this.grantStatement) },
      { ALT: () => this.SUBRULE(this.revokeStatement) },
      { ALT: () => this.SUBRULE(this.showStatement) },
      { ALT: () => this.SUBRULE(this.copyStatement) },
      { ALT: () => this.SUBRULE(this.lockStatement) },
      { ALT: () => this.SUBRULE(this.resetStatement) },
      { ALT: () => this.SUBRULE(this.withAnyStatement) },
      { ALT: () => this.SUBRULE(this.parenthesizedSetStatement) },
      { ALT: () => this.SUBRULE(this.selectStatement) },
      { ALT: () => this.SUBRULE(this.insertStatement) },
      { ALT: () => this.SUBRULE(this.updateStatement) },
      { ALT: () => this.SUBRULE(this.deleteStatement) },
      { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
      { ALT: () => this.SUBRULE(this.postgresqlTransaction) },
      { ALT: () => this.SUBRULE(this.setStatement) },
      { GATE: () => this.LA(1).tokenType === t.Reindex, ALT: () => this.SUBRULE(this.reindexStatement) },
      { GATE: () => this.LA(1).tokenType === t.Declare, ALT: () => this.SUBRULE(this.postgresqlDeclareStatement) },
      { GATE: () => this.LA(1).tokenType === t.Fetch, ALT: () => this.SUBRULE(this.postgresqlFetchStatement) },
      { GATE: () => this.isPostgresqlCreateFallback(), ALT: () => this.SUBRULE(this.postgresqlCreateFallbackStatement) },
      { GATE: () => this.isPostgresqlAlterFallback(), ALT: () => this.SUBRULE(this.postgresqlAlterFallbackStatement) },
      { GATE: () => this.isPostgresqlDropFallback(), ALT: () => this.SUBRULE(this.postgresqlDropFallbackStatement) },
      { GATE: () => this.isPostgresqlIdentifierCommand(), ALT: () => this.SUBRULE(this.postgresqlIdentifierCommandStatement) },
    ]));
  }

  /**
   * PostgreSQL table/view DDL differs from the shared ANSI subset:
   * `CREATE TABLE … PARTITION OF`, `INHERITS`, `LIKE`, `WITH (storage)`,
   * `UNLOGGED`, view storage parameters, and `WITH [NO] DATA`.
   */
  private registerPostgresqlStatementOverrides(): void {
    this.OVERRIDE_RULE('tableTypeClause', () => {
      this.OPTION(() => this.CONSUME(t.Global));
      this.OR([
        { ALT: () => this.CONSUME(t.Temp) },
        { ALT: () => this.CONSUME(t.Temporary) },
        { ALT: () => this.CONSUME(t.Unlogged) },
      ]);
    });

    this.RULE('postgresqlLikeClause', () => {
      this.CONSUME(t.Like);
      this.SUBRULE(this.qualifiedName);
      this.MANY(() => {
        this.OR([
          { GATE: () => this.isPostgresqlImageOneOf('INCLUDING'), ALT: () => this.CONSUME(t.Identifier) },
          { GATE: () => this.isPostgresqlImageOneOf('EXCLUDING'), ALT: () => this.CONSUME1(t.Identifier) },
        ]);
        this.OR1([
          { ALT: () => this.CONSUME(t.All) },
          { ALT: () => this.CONSUME2(t.Identifier) }, // DEFAULTS, CONSTRAINTS, INDEXES, STORAGE, COMMENTS, STATISTICS
          { ALT: () => this.CONSUME(t.Generated) },
          { ALT: () => this.CONSUME(t.Identity) },
        ]);
      });
    });

    this.RULE('postgresqlReloptionList', () => {
      this.CONSUME(t.LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: t.Comma,
        DEF: () => {
          this.SUBRULE(this.postgresqlReloptionName);
          this.OPTION(() => {
            this.CONSUME(t.Equals);
            this.SUBRULE(this.postgresqlReloptionValue);
          });
        },
      });
      this.CONSUME(t.RParen);
    });

    this.OVERRIDE_RULE('createTableStatement', () => {
      this.CONSUME(t.Create);
      this.OPTION({ GATE: () => this.supportsTableTypeClause(), DEF: () => this.SUBRULE(this.tableTypeClause) });
      this.CONSUME(t.Table);
      this.OPTION1(() => {
        this.CONSUME(t.If);
        this.CONSUME(t.Not);
        this.CONSUME(t.Exists);
      });
      this.SUBRULE(this.qualifiedName);
      this.OR([
        { GATE: () => this.isPostgresqlImageOneOf('PARTITION'), ALT: () => {
          this.CONSUME(t.Identifier); // PARTITION
          this.CONSUME(t.Of);
          this.SUBRULE1(this.qualifiedName); // parent table
          this.OPTION2(() => this.SUBRULE(this.postgresqlPartitionBound));
        } },
        { ALT: () => {
          this.OR1([
            { ALT: () => {
              this.CONSUME(t.As);
              this.OR2([
                { ALT: () => {
                  this.CONSUME(t.LParen);
                  this.OR3([
                    { ALT: () => this.SUBRULE(this.withStatement) },
                    { ALT: () => this.SUBRULE(this.selectStatement) },
                  ]);
                  this.CONSUME(t.RParen);
                } },
                { ALT: () => {
                  this.OR4([
                    { ALT: () => this.SUBRULE1(this.withStatement) },
                    { ALT: () => this.SUBRULE1(this.selectStatement) },
                  ]);
                } },
              ]);
            } },
            { GATE: () => {
              const second = this.LA(2).tokenType;
              const third = this.LA(3).tokenType;
              return (second === t.Identifier || second === t.QuotedIdentifier)
                && (third === t.Comma || third === t.RParen);
            }, ALT: () => {
              this.SUBRULE(this.columnList);
              this.CONSUME1(t.As);
              this.OR5([
                { ALT: () => this.SUBRULE2(this.withStatement) },
                { ALT: () => this.SUBRULE2(this.selectStatement) },
              ]);
            } },
            { ALT: () => {
              this.CONSUME1(t.LParen);
              this.SUBRULE(this.columnDefinitionList);
              this.CONSUME1(t.RParen);
            } },
          ]);
        } },
      ]);
      this.registerCreateTableDialectClauses();
    });

    this.OVERRIDE_RULE('createViewStatement', () => {
      this.CONSUME(t.Create);
      this.OPTION(() => {
        this.CONSUME(t.Or);
        this.CONSUME(t.Replace);
      });
      this.OPTION1(() => this.CONSUME(t.Materialized));
      this.CONSUME(t.View);
      this.SUBRULE(this.qualifiedName);
      this.OPTION2(() => this.SUBRULE(this.viewColumnAliasList));
      this.OPTION3(() => {
        this.CONSUME(t.With);
        this.SUBRULE(this.postgresqlReloptionList);
      });
      this.CONSUME(t.As);
      this.OR([
        { ALT: () => {
          this.CONSUME(t.LParen);
          this.OR1([
            { ALT: () => this.SUBRULE(this.withStatement) },
            { ALT: () => this.SUBRULE(this.selectStatement) },
          ]);
          this.CONSUME(t.RParen);
        } },
        { ALT: () => {
          this.OR2([
            { ALT: () => this.SUBRULE1(this.withStatement) },
            { ALT: () => this.SUBRULE1(this.selectStatement) },
          ]);
        } },
      ]);
      this.OPTION4(() => {
        this.CONSUME1(t.With);
        this.OPTION5(() => this.CONSUME(t.Identifier)); // CASCADED | LOCAL
        this.CONSUME(t.Check);
        this.CONSUME1(t.Identifier); // OPTION
      });
      this.OPTION6(() => {
        this.CONSUME2(t.With);
        this.OPTION7(() => this.CONSUME2(t.Identifier)); // NO
        this.CONSUME3(t.Identifier); // DATA
      });
    });

    this.OVERRIDE_RULE('commentStatement', () => {
      this.CONSUME(t.Comment);
      this.CONSUME(t.On);
      this.OR([
        { ALT: () => this.CONSUME(t.Table) },
        { ALT: () => this.CONSUME(t.View) },
        { ALT: () => { this.CONSUME(t.Materialized); this.CONSUME1(t.View); } },
        { ALT: () => { this.CONSUME(t.Foreign); this.CONSUME1(t.Table); } },
        { ALT: () => this.CONSUME(t.Index) },
        { ALT: () => this.CONSUME(t.Sequence) },
        { ALT: () => this.CONSUME(t.Schema) },
        { ALT: () => this.CONSUME(t.Database) },
        { ALT: () => this.CONSUME(t.Type) },
        { ALT: () => this.CONSUME(t.Domain) },
        { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => this.CONSUME(t.Procedure) },
        { ALT: () => this.CONSUME(t.Column) },
        { ALT: () => this.CONSUME(t.Tablespace) },
        { ALT: () => this.CONSUME(t.Access) },
        { ALT: () => this.CONSUME(t.Identifier) }, // TRIGGER, POLICY, EXTENSION, ROLE, ...
      ]);
      this.SUBRULE(this.qualifiedName);
      this.OPTION(() => {
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.typeName) });
        this.CONSUME(t.RParen);
      });
      this.CONSUME(t.Is);
      this.OR1([
        { ALT: () => this.CONSUME(t.StringLiteral) },
        { ALT: () => this.CONSUME(t.Null) },
      ]);
    });

    this.OVERRIDE_RULE('createSequenceStatement', () => {
      this.CONSUME(t.Create);
      this.CONSUME(t.Sequence);
      this.OPTION(() => {
        this.CONSUME(t.If);
        this.CONSUME(t.Not);
        this.CONSUME(t.Exists);
      });
      this.SUBRULE(this.qualifiedName);
      this.OPTION1(() => this.SUBRULE(this.commandTail));
    });

    this.RULE('postgresqlDropRoutineStatement', () => {
      this.CONSUME(t.Drop);
      this.OR([
        { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => this.CONSUME(t.Procedure) },
      ]);
      this.OPTION(() => {
        this.CONSUME(t.If);
        this.CONSUME(t.Exists);
      });
      this.SUBRULE(this.qualifiedName);
      this.OPTION1(() => {
        this.CONSUME(t.LParen);
        this.OPTION2(() => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.typeName) }));
        this.CONSUME(t.RParen);
      });
      this.OPTION3(() => this.OR1([
        { ALT: () => this.CONSUME(t.Cascade) },
        { ALT: () => this.CONSUME(t.Restrict) },
      ]));
    });
  }

  /**
   * PostgreSQL administrative statements that have no structured grammar.
   *
   * They are accepted as a command head plus an untyped tail instead of being
   * reported as syntax errors. This keeps strict validation for the statements
   * the parser models (SELECT/DML/table and routine DDL) while avoiding false
   * positives for `VACUUM`, `REFRESH MATERIALIZED VIEW`, `CREATE EXTENSION`,
   * `ALTER ROLE`, `DROP POLICY`, and similar commands.
   */
  private registerPostgresqlFallbackRules(): void {
    this.RULE('postgresqlIdentifierCommandStatement', () => {
      this.CONSUME(t.Identifier);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });

    this.RULE('postgresqlCreateFallbackStatement', () => {
      this.CONSUME(t.Create);
      this.OPTION(() => {
        this.CONSUME(t.Or);
        this.CONSUME(t.Replace);
      });
      this.OR([
        { ALT: () => this.CONSUME(t.Identifier) },
        { ALT: () => this.CONSUME(t.User) },
        { ALT: () => this.CONSUME(t.Database) },
        { ALT: () => this.CONSUME(t.Cast) },
        { ALT: () => this.CONSUME(t.Rule) },
        { ALT: () => this.CONSUME(t.Foreign) },
        { ALT: () => this.CONSUME(t.Constraint) },
        { ALT: () => this.CONSUME(t.Tablespace) },
        { ALT: () => this.CONSUME(t.Access) },
        { ALT: () => this.CONSUME(t.Group) },
      ]);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('postgresqlAlterFallbackStatement', () => {
      this.CONSUME(t.Alter);
      this.OR([
        { ALT: () => this.CONSUME(t.Identifier) },
        { ALT: () => this.CONSUME(t.System) },
        { ALT: () => this.CONSUME(t.User) },
        { ALT: () => this.CONSUME(t.Database) },
        { ALT: () => this.CONSUME(t.Sequence) },
        { ALT: () => this.CONSUME(t.Index) },
        { ALT: () => this.CONSUME(t.View) },
        { ALT: () => this.CONSUME(t.Materialized) },
        { ALT: () => this.CONSUME(t.Schema) },
        { ALT: () => this.CONSUME(t.Type) },
        { ALT: () => this.CONSUME(t.Domain) },
        { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => this.CONSUME(t.Procedure) },
        { ALT: () => this.CONSUME(t.Foreign) },
        { ALT: () => this.CONSUME(t.Default) },
        { ALT: () => this.CONSUME(t.Cast) },
        { ALT: () => this.CONSUME(t.Rule) },
        { ALT: () => this.CONSUME(t.Language) },
        { ALT: () => this.CONSUME(t.Tablespace) },
        { ALT: () => this.CONSUME(t.Access) },
      ]);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('postgresqlDropFallbackStatement', () => {
      this.CONSUME(t.Drop);
      this.OR([
        { ALT: () => this.CONSUME(t.Identifier) },
        { ALT: () => this.CONSUME(t.Index) },
        { ALT: () => this.CONSUME(t.Type) },
        { ALT: () => this.CONSUME(t.Domain) },
        { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => this.CONSUME(t.Materialized) },
        { ALT: () => this.CONSUME(t.Foreign) },
        { ALT: () => this.CONSUME(t.Constraint) },
        { ALT: () => this.CONSUME(t.Tablespace) },
        { ALT: () => this.CONSUME(t.Access) },
      ]);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('postgresqlDeclareStatement', () => {
      this.CONSUME(t.Declare);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('postgresqlFetchStatement', () => {
      this.CONSUME(t.Fetch);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('postgresqlDropUserMappingStatement', () => {
      this.CONSUME(t.Drop);
      this.CONSUME(t.User);
      this.CONSUME(t.Mapping);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });
  }

  private isPostgresqlImageOneOf(...images: string[]): boolean {
    const image = this.LA(1).image?.toUpperCase();
    return image !== undefined && images.includes(image);
  }

  private isPostgresqlRoutineTypeWordAhead(): boolean {
    const token = this.LA(1);
    if (token.tokenType !== t.Identifier && token.tokenType !== t.QuotedIdentifier
      && token.tokenType !== t.To && token.tokenType !== t.With) {
      return false;
    }
    return !POSTGRESQL_ROUTINE_TYPE_STOP_WORDS.has((token.image ?? '').toUpperCase());
  }

  /**
   * PostgreSQL arguments are `[mode] [name] type [DEFAULT expr]`, and both the
   * name and a user-defined type lex as identifiers. Treat the first identifier
   * as the name only when another identifier follows; a lone `integer` is a
   * type, while `x integer` is a named argument. Multi-word built-in types
   * still parse, with the first word read as a name in the rare unnamed case.
   */
  private isPostgresqlRoutineArgumentNameAhead(): boolean {
    const first = this.LA(1).tokenType;
    if (first !== t.Identifier && first !== t.QuotedIdentifier) return false;
    const next = this.LA(2).tokenType;
    return next === t.Identifier || next === t.QuotedIdentifier || next === t.To || next === t.With;
  }

  private isPostgresqlRoutineAttributeStart(): boolean {
    if (this.LA(1).tokenType === t.Not) return true;
    if (this.LA(1).tokenType === t.Returns && this.LA(2).tokenType === t.Null) return true;
    return this.isPostgresqlImageOneOf('IMMUTABLE', 'STABLE', 'VOLATILE', 'LEAKPROOF', 'STRICT', 'CALLED');
  }

  private isPostgresqlRoutineSecurityOptionStart(): boolean {
    if (this.LA(1).tokenType === t.External || this.LA(1).tokenType === t.Rows) return true;
    return this.isPostgresqlImageOneOf('SECURITY', 'PARALLEL', 'COST', 'SUPPORT', 'EXTERNAL', 'ROWS');
  }

  private isPostgresqlCreateFallback(): boolean {
    if (this.LA(1).tokenType !== t.Create) return false;
    const headIndex = this.LA(2).tokenType === t.Or && this.LA(3).tokenType === t.Replace ? 4 : 2;
    const head = this.LA(headIndex).tokenType;
    if (POSTGRESQL_MODELED_CREATE_HEADS.has(head.name)) return false;
    return head !== t.Identifier
      || POSTGRESQL_CREATE_FALLBACK_OBJECTS.has(this.LA(headIndex).image.toUpperCase());
  }

  private isPostgresqlAlterFallback(): boolean {
    if (this.LA(1).tokenType !== t.Alter || this.LA(2).tokenType === t.Table) return false;
    const head = this.LA(2).tokenType;
    return head !== t.Identifier
      || POSTGRESQL_ALTER_FALLBACK_OBJECTS.has(this.LA(2).image.toUpperCase());
  }

  private isPostgresqlDropFallback(): boolean {
    if (this.LA(1).tokenType !== t.Drop) return false;
    const head = this.LA(2).tokenType;
    if (POSTGRESQL_MODELED_DROP_HEADS.has(head.name)) return false;
    return head !== t.Identifier
      || POSTGRESQL_DROP_FALLBACK_OBJECTS.has(this.LA(2).image.toUpperCase());
  }

  private isPostgresqlIdentifierCommand(): boolean {
    return this.LA(1).tokenType === t.Identifier
      && POSTGRESQL_IDENTIFIER_COMMAND_HEADS.has(this.LA(1).image.toUpperCase());
  }
}
export class SqlParser extends PostgreSqlParser {}
let parserInstance: SqlParser | undefined;
/** Create an independent parser for nested/reentrant authoring requests. */
export function createSqlParserInstance(): SqlParser { return new SqlParser(); }
/** Reuse the parser for ordinary document sessions. */
export function getSqlParserInstance(): SqlParser { return parserInstance ??= createSqlParserInstance(); }
