# Privacy Notes

JustyBase is a VS Code extension for SQL authoring, database browsing, query execution, import/export, and optional AI-assisted workflows.

## Local data

Connection profiles, query history, favorites, metadata cache files, and result-panel state may be stored locally by VS Code or the extension. Credentials should be stored through VS Code secret storage where supported.

## Database data

Queries run against databases configured by the user. Query text, result sets, schema metadata, and object definitions may be displayed or cached locally as part of normal extension behavior.

## AI-assisted features

When GitHub Copilot assisted features are used, selected context may be sent to external Microsoft/GitHub services. This can include SQL text, diagnostics, schema metadata, table/profile notes, query history snippets, or small result previews depending on the command.

Do not use AI features with confidential data unless your organization permits that use.

## Public issues

Do not paste secrets, passwords, connection strings, private SQL, production data, customer data, or proprietary schema details into public GitHub issues.
