---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "small-business-cms-67e68d3e6585"
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 10000

workspace:
  root: ./symphony-workspaces

hooks:
  after_create: |
    git clone --depth 1 https://github.com/AbreuOliver/kassidy-website.git .
    git checkout -B symphony/{{ issue.identifier }}
    npm install
    npm run check
    npm run build

  before_run: |
    git checkout -B symphony/{{ issue.identifier }}
    npm install
    npm run format:check
    npm run check
    npm run lint
    npm run build

  after_run: |
    npm run format
    npm run quality
    git status --short
    git add .
    git commit -m "Symphony work for {{ issue.identifier }}" || true

agent:
  backend: ollama
  max_concurrent_agents: 1
  max_turns: 3

ollama:
  host: http://127.0.0.1:11434
  model: gemma4:26b
  timeout_ms: 120000
---
You are working on a Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker, such as missing required auth, permissions, or secrets.
3. If blocked, record the blocker clearly in the workpad and move the issue according to the workflow.
4. Final message must report completed actions and blockers only. Do not include "next steps for user".
5. Work only in the provided repository copy. Do not touch any other path.
6. Reference DESIGN.md for all design guidance, unless the issue has more specific design requirements.
7. Keep changes scoped to the current Linear ticket.
8. Prefer small, direct edits over broad refactors.
9. Do not introduce new dependencies unless the issue clearly requires them.
10. If a new dependency is necessary, explain why in the workpad.
11. Do not weaken, skip, delete, or bypass existing checks to make the task pass.
12. Do not remove tests unless they are obsolete because of an intentional behavior change.
13. After making code changes, run the deterministic quality gate:

    npm run quality

14. If the change affects routing, forms, navigation, layout, accessibility, or visible page behavior, also run:

    npm run test:e2e

15. If any quality command fails, fix the code and rerun the failing command.
16. Before ending, ensure the repository is formatted and the production build succeeds.
17. The final response must include:
    - files changed
    - commands run
    - whether checks passed
    - any blockers
18. The final response must not include speculative future work.
