## Summary

- What changed:
- Why:
- Risk level (`low` / `medium` / `high`):

## Risk and compatibility

- [ ] I identified the affected contract, state owner, or runtime boundary.
- [ ] For medium/high-risk work, I documented the state and failure matrix below.
- [ ] Backward compatibility, migration, and rollback behavior are described.
- [ ] Credentials, customer data, traces, and screenshots remain out of the PR.

### State and failure matrix (required for medium/high risk)

| State/phase | Failure or race | Expected recovery | Evidence |
| --- | --- | --- | --- |
|  |  |  |  |

## Validation

- [ ] `npm run check-types`
- [ ] `npm run lint`
- [ ] `npm run lint:extended:check`
- [ ] `npm run test:quality-tools`
- [ ] `npm run test:coverage`
- [ ] Changed high-risk coverage checked (when `src/` paths in the baseline scope changed).
- [ ] Nearest integration, browser, or Extension Host gate run for high-risk behavior.
- [ ] Result Panel changes passed the `Result panel regression` GitHub Actions workflow; its weekly cron runs the 20x Linux race gate.
- [ ] `npm run docs:check` (if a public feature, manifest, contract, route, format, or setting changed)

## Cleanup and failure-path evidence

- [ ] Timers, listeners, workers, pending requests, temporary files, connections,
      and database sessions are disposed or awaited.
- [ ] Cancellation, empty/partial data, retry, and late-callback behavior are covered where applicable.
- [ ] The full Jest suite exits naturally (no forced worker exit).

## Documentation impact

- [ ] User/admin/developer guide updated for a user-visible behavior change.
- [ ] Status, permission, platform, and database boundaries are documented.
- [ ] Generated command/setting/capability tables were checked when source contracts changed.

## Notes for reviewers

- Expected behavior change:
- Backward compatibility impact:
- Follow-up tasks (if any):
