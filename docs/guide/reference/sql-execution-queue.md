---
title: SQL execution queue
description: Submit, inspect, pause, cancel and recover independent SQL requests per editor tab.
audience: reference
category: Reference
status: Supported
last_verified: 2026-10-06
product_version: 3.18.6
---

# SQL execution queue

Run Query (`Ctrl+Enter`), Run Query Continue on Error, and Run Query Batch submit
independent requests to the current SQL editor tab's execution lane. Each tab
with **Keep Connection Open** runs at most one request at a time on its shared
session. Additional requests run in submission order; other tabs remain independent.

With **Keep Connection Open disabled**, requests own separate transient sessions
and may run concurrently, by default up to **4 active requests per SQL tab**
and **12 across the extension host**. Configure `justybase.query.maxParallelPerTab`
and `justybase.query.maxParallelGlobal` (integers from 1 to 100). Each request
opens its own connection and closes it after execution. Further requests wait
for a slot and start in submission order; completion order may differ. The queue
shows every active request separately and displays the running count / configured tab limit.
Connection ownership is captured when submitting, so changing the setting does
not move an already submitted request onto another request's session.

A batch remains one request: its statements run sequentially on that request's
owned session, preserving dependent statements and temporary-object semantics.

Open **JustyBase: Show SQL Execution Queue** from the Command Palette, or click
the status bar's **Running | N queued** indicator. The **SQL Queue** tree in the
JustyBase sidebar shows each tab's running SQL, pending SQL previews, queue count,
and latest terminal status.

- Click a running SQL row to request cancellation of that request only. Other
  independent sessions continue; cancellation identities and result sources
  are distinct for every transient request.
- Click a pending SQL row to remove it before execution.
- **Clear queued** discards pending requests without cancelling running SQL.
- **Pause queue** prevents the next request from starting; **Resume queue** continues it.
- **Recover running execution…** opens the existing force-unlock, DROP SESSION,
  and fresh-connection recovery flow for a request that never settles. Recovery
  retires that request and the next queued request starts automatically.

The queue displays submissions immediately, including requests preparing inputs.
Check the count if you press the execution shortcut repeatedly: repeated SQL is
not deduplicated, and each submission can perform its own database changes.

## Captured inputs and results

A submission captures SQL, document identity, selection range, connection
profile, and database override. Editing SQL afterward does not change pending
requests. Required variable values are collected when submitting; simultaneous
variable dialogs are presented sequentially. Macro include files discovered
while preparing inputs are captured too. An include that cannot be captured is
rejected rather than read from a changed file later.

Database-dependent macros (`%SQL`), Python macros, and exports keep their existing
semantics: they execute only when the request owns the tab's execution lane.
Their results can depend on the session and external environment at that time.
Safety confirmation for SQL introduced by macro expansion can also occur then.

Changing the tab's connection, database override, or saved connection profile
invalidates execution against that target. The request fails and is closed like
any other terminal request; the queue continues with the next submission. Restore
the original target and submit the failed SQL again, or remove pending requests
and submit against the intended new target. A failed request is never
automatically replayed by the queue.

Each executed request uses normal result streaming, row limits, Logs, timing,
and query history. Removing a request before execution does not create an
executed history entry. One SQL document owns one Results workspace, including
all concurrent executions and one combined Logs tab. Overlapping submissions
preserve earlier result tabs without creating manual pins. A fresh run after the
queue becomes idle clears unpinned results; manually pinned results remain.

## Errors, cancellation, and lifecycle

Normal database and syntax errors on reusable sessions do not block the queue. A request that fails is terminal: it shows its
error result and the next queued request starts automatically. A failed request
is never retried or replayed. Continue on Error applies to statements within its
single request only.

Cancellation acknowledgement does not advance the lane; the request must first
settle and clean up. Persistent sessions are reset before advancing after
cancellation or uncertain cleanup; confirmed closed transient sessions advance
directly. If the shared session cannot be verified safe, persistent requests wait
behind a **Recovery required** blocker. **Recover connection…** offers reset,
fresh connection, and DROP SESSION where supported. Resume cannot bypass this
blocker. Independent transient requests remain isolated and eligible. Recovery
is also available for requests that never settle. A reset can discard
session-local state such as temporary tables.

Closing the document discards pending SQL and retires/cancels running work using
the existing document and connection cleanup. A reopened untitled URI receives
a separate document identity. Extension shutdown discards every pending request.
Queues are held only in memory and are never restored after restarting VS Code.

## Queue overview in Logs

The result panel's **Logs** tab shows the document's running requests and queued
SQL above the execution transcript. Independent sessions display a count such as
**3 running / 4**, and each running request has its own **Cancel** action.
**Remove** discards one waiting request. **Clear queued** discards waiting requests
without cancelling active sessions. **Pause queue** prevents new starts; it does
not interrupt running SQL. **Resume queue** continues admission after a pause.
The overview updates from coordinator events and returns after panel revival;
SQL previews are bounded and the transcript scrolls independently.

Both queued items and the individual execution transcripts are collapsible.
Expand a request to inspect SQL and its target; expand a run to inspect its
messages, timing and outcome. Logs can also include completed sibling sessions
from the same document (bounded to 1,000 recent messages, 200 per session).
Manually choosing **Logs** keeps it selected as new results arrive, including
results from independent sessions in that document. Choosing a result tab
restores the usual automatic activation of new results. Other documents retain
their own selection, and a closed/reopened document does not inherit this choice.
