## Summary

- What changed:
- Why:
- Risk level (`low`/`medium`/`high`):

## Validation

- [ ] `npm run check-types`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run test:playwright` (if scroll persistence or WebView code changed)

## Branch Coverage Gate (TQ01-03)

For PRs touching `FEAT03` or `CQ01` scope, merge is blocked unless branch tests cover each new condition path.

`FEAT03` scope:
- `src/services/tuning/**`
- `src/services/copilotTools/tuningAdviceTool.ts`
- `src/commands/queryCommands.ts` (tuning advisor paths)
- `src/activation/copilotRegistration.ts` (tuning tool registration)

`CQ01` scope:
- `src/commands/schema/utilityCommands.ts`
- `src/commands/schema/revealCommands.ts`
- `src/commands/schema/historyCommands.ts`
- `src/commands/schema/favoritesCommands.ts`
- `src/commands/schema/editorInsertCommands.ts`

Checklist:
- [ ] Every new `if`/`else`/`switch`/ternary branch in FEAT03/CQ01 has at least one test case.
- [ ] I ran targeted coverage for touched FEAT03/CQ01 modules and reviewed branch coverage output.
- [ ] I attached coverage evidence in this PR (command + output snippet or screenshot).

Suggested commands:

```bash
# Targeted tests
npm test -- --testPathPattern="tuning|utilityCommands|wizardCommands|queryCommands|copilotTools"

# Targeted branch coverage for changed files
npm test -- --coverage --collectCoverageFrom="src/commands/schema/revealCommands.ts"
npm test -- --coverage --collectCoverageFrom="src/services/tuning/netezzaTuningAdvisor.ts"
```

## Notes for Reviewers

- Expected behavior change:
- Backward compatibility impact:
- Follow-up tasks (if any):
