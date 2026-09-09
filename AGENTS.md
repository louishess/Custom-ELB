# LabMate project handoff

Read `docs/HANDOFF.md` before continuing implementation. Preserve the current
frontend and distinguish working capabilities from planned controls.

## Delegation limits

The user permits up to 9 concurrent subagents for this project, excluding the
primary agent. Maximum nesting depth is 2: primary at depth 0, children at depth
1, grandchildren at depth 2. Agents at depth 2 must not spawn further agents.
Include the assigned depth in each delegated task. Respect any lower limit
enforced by the active runtime. This permission is a ceiling, not a requirement
to use agents for every task.
