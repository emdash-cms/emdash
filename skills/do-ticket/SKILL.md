---
name: do-ticket
description: "Implement a piece of work based on a github ticket."
disable-model-invocation: true
---

Require the user to give a ticket number. Do nothing without a ticket number.

Start an agent in a fresh worktree:

```bash
created=$(herdr worktree create --path ../emdash-ticket-{ticket-number} --branch ticket-{ticket-number} --no-focus)
pane=$(echo "$created" | jq -r '.result.root_pane.pane_id')
herdr agent start ticket-{ticket-number} --kind pi --pane "$pane"
```

Give the new agent the prompt:

```
/implement #{ticket-number}.

Before starting the implementation:
1. Check the codebase if the ticket is whole or partly implemented
2. Grill me if you find gaps, contradictions and/or blockers

In the commit body, append `Closes #{ticket-number}.`

Open a PR using the /pr skill.
```
