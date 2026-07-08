# Optional Dialect Integration Steps

This repository uses two integration models:

- built-in runtimes inside `src/dialects`
- optional sibling runtimes inside `extensions/<dialect>`

## PostgreSQL Checklist

Use PostgreSQL as the reference implementation for a first-class optional runtime:

1. Add traits and SQL authoring in `extensions/postgresql/src/dialect/` and `extensions/postgresql/src/sql/`
2. Register the runtime dialect from `extensions/postgresql/src/extension.ts`
3. Implement a `pg`-backed connection runtime without native dependencies
4. Map PostgreSQL metadata queries into the shared `MetadataCache` contract
5. Provide DDL, import type mapping, explain/tuning helpers, and reference guidance
6. Add unit tests plus optional integration coverage
7. Document packaging and docker-compose based validation

## Validation Commands

```bash
npm run check-types
npm run test -- --testPathPatterns="postgresql"
npm run verify:postgresql
```

## Snowflake Checklist

Use Snowflake when you need a cloud-only optional runtime with stricter auth and cost controls:

1. Keep SQL authoring in `extensions/snowflake/src/sql/` and traits in `src/shared/dialect-traits/snowflake.ts`
2. Keep the runtime package in `extensions/snowflake`
3. Use `snowflake-sdk` only in the optional extension and keep it external to esbuild output
4. Map `INFORMATION_SCHEMA` and `SHOW ... ->> SELECT ... FROM $1` results into the shared metadata contracts
5. Expose warehouse/role/session controls through shared commands, not custom hidden state
6. Generate stage-based `COPY INTO` workflows rather than bundling local upload tooling
7. Gate all live-account tests behind explicit opt-in environment variables

## Snowflake Validation Commands

```bash
npm run check-types
npm run check-types:snowflake
npm run test -- --testPathPatterns="snowflake|optionalDialects.unit.test.ts|wizardCommands.test.ts|importCommands.test.ts"
RUN_SNOWFLAKE_INTEGRATION=1 npm run test:snowflake:integration
```
