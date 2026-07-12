# SAS-like macros

JustyBase supports a small set of SAS-style directives in Netezza SQL files. Directives are processed before SQL is sent to the database.

## `%python`

`%python script.py [args...];` runs the configured Python interpreter and replaces the directive with the script's standard output.

```sql
%let script = scripts/build_filter.py;
%python &script --region EAST;
```

The script path and arguments support `%let` variables, `&name`, and `${name}` references. Standard error is included in the execution error when the script exits non-zero. The interpreter is configured with `justybase.pythonPath` and defaults to `python`.

Python macros run during asynchronous query execution. They are not executed by synchronous parser-only preprocessing.

## `%do` and conditional blocks

Use `%do; ... %end;` for an unconditional block, or use it with `%if`:

```sql
%if &run_report = 1 %then %do;
  SELECT * FROM reporting.daily;
%end;
```

`%else %do; ... %end;` is also supported. Blocks may be nested.

## `%export`

`%export(...)` executes an inner query and writes its result during preprocessing:

```sql
%export(
  format='xlsx',
  file='/tmp/daily.xlsx',
  sheet='Daily',
  query=(SELECT * FROM reporting.daily),
  overwrite=false
);
```

Supported formats are `xlsx`, `xlsb`, `parquet`, `csv`, and `xpt`. Export directives do not add SQL to the database request.

## Other directives

These directives can be combined with the macros above:

- `%let name = value;` declares an execution-scoped variable.
- `%put message;` writes a resolved message to the query log.
- `%include 'path.sql';` includes a local SQL file using the same macro environment.
- `%sql(...)`, `%sqllist(...)`, and `%eval(...)` provide inline substitutions.

Macro directives are highlighted and have completion/snippet support in the Netezza SQL language.
