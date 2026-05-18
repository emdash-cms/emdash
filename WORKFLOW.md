---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "67e68d3e6585"
  active_states:
    - In Progress
  terminal_states:
    - Completed
    - Canceled

polling:
  interval_ms: 10000

workspace:
  root: ./symphony-workspaces

hooks:
  after_create: |
    git clone --depth 1 https://github.com/AbreuOliver/emdash.git .
    git checkout -B symphony/{{ issue.identifier }}
    pnpm install
    pnpm run check
    pnpm run build

  before_run: |
    git checkout -B symphony/{{ issue.identifier }}
    pnpm install
    pnpm run format:check
    pnpm run check
    pnpm run lint
    pnpm run build

agent:
  max_concurrent_agents: 1
  max_turns: 3

ollama:
  base_url: http://127.0.0.1:11434
  model: gemma4:26b
  turn_timeout_ms: 3600000
  read_timeout_ms: 300000
  stall_timeout_ms: 1800000

server:
  port: 4321
---

You are working on a Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from current workspace state; do not restart from scratch.
- Do not repeat already-completed investigation unless needed for new changes.
  {% endif %}

Issue context:
ID: {{ issue.id }}
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Linear state management is mandatory:
   - At the start of each run, move the issue to `In Progress` if it is currently `Backlog` or `Planned`.
   - When implementation is complete and checks pass, move the issue to `Completed`.
   - If truly blocked (missing auth/secrets/permissions/external dependency), leave a blocker comment and move the issue to `Canceled`.
3. Use the `linear_graphql` tool for state changes:
   - Query states:
   ```graphql
   query GetWorkflowStates {
     workflowStates {
       nodes {
         id
         name
       }
     }
   }
   ```

   - Move issue:
   ```graphql
   mutation MoveIssue($id: String!, $stateId: String!) {
     issueUpdate(id: $id, input: { stateId: $stateId }) {
       success
     }
   }
   ```

   - Add comment:
   ```graphql
   mutation CommentIssue($issueId: String!, $body: String!) {
     commentCreate(input: { issueId: $issueId, body: $body }) {
       success
     }
   }
   ```
4. Work only in the provided repository copy. Do not touch any other path.
5. Keep changes scoped to this ticket. Prefer small, direct edits.
6. Do not introduce new dependencies unless clearly required by the ticket.
7. Do not weaken/skip/remove checks to force a pass.
8. After code changes, run:
   - `pnpm run quality`
   - If UI/UX behavior changed: `pnpm run test:e2e`
9. If checks fail, fix and rerun until passing.
10. Before ending, ensure formatting and production build succeed.
11. Final response must not include speculative future work.
12. Linear comment requirements are mandatory. Use `linear_graphql` to add comments in these cases:

- Blocked run:
  - Include blocker type (missing secret/permission/dependency/tool failure), exact failing command(s), short error output, and what was attempted.
  - Then move the issue to `Canceled`.
- Successful run:
  - Include files changed, commands run, check/test results, and remaining risks (if any).
- State transition:
  - Whenever you move state (for example `In Progress` or `Completed`), post a short reason comment.

13. Reuse the GraphQL operations defined in step 3 for all state transitions and comments.
14. For comments, always use `issueId = {{ issue.id }}`.
15. Final response must include: files changed, commands run, checks passed, blockers (if any), and confirmation that a Linear comment was posted.
