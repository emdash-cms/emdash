# AI usage policy

EmDash welcomes contributions created with AI tools. The human contributor remains responsible for the result, and conversations with community members remain human except for the narrow implementation-pull-request review cases below.

This policy covers generative AI agents. Ordinary CI automation, dependency updates, test results, and deterministic status comments are outside its scope.

## Human responsibility

- Disclose material AI assistance and name the model or tool used.
- Review all generated work before submitting it. Inspect the complete diff, run the relevant tests, and exercise changed behavior yourself.
- Authorise each external action separately. An agent can open a particular pull request or issue only after a human explicitly authorises that item.
- Do not give an agent standing permission to choose work and open pull requests or issues. Autonomous contribution agents such as Claws are not permitted.
- Do not use an agent to reply to a human except for the implementation-pull-request review cases permitted below.

Posting from an identifiable bot account removes the need for a signature. It does not override a surface where AI participation is prohibited.

## Pull request eligibility

Open a pull request only when at least one of these conditions applies:

- You use EmDash and the change addresses a concrete problem you encountered.
- You maintain or substantially contribute to a tool, dependency, or service that EmDash uses, and the change directly concerns that integration.
- An EmDash Maintainer approved that specific change before you opened the pull request.

Do not ask an agent to scan the repository for contribution opportunities or manufacture plausible work. Speculative cleanups, generic refactors, bulk fixes, and changes selected only because an agent can generate them are not accepted.

Explain your connection to the change and how you verified it in the pull request. Obtain Maintainer approval before opening the pull request when none of the listed conditions applies.

## Code and pull requests

AI-generated code is held to the same quality standard as human-written code. The submitter must understand, review, test, and be able to maintain the change.

An agent can create commits, draft a pull request description, and open a pull request under direct human control. The human must authorise that specific pull request and review the complete change before submission.

Use the repository pull request template and complete every applicable section. The AI disclosure names every model or tool that materially generated code or pull request text. The template disclosure is sufficient for the pull request body; it does not need a separate bot signature.

## Issues

A human must reproduce a reported bug before opening an issue. Screenshots, logs, and agent analysis do not replace human reproduction.

Issues are normally written and posted by a human. An agent can help prepare or open a specific issue only after a human has verified the report, reviewed the complete issue, explicitly authorised that issue, and disclosed the assistance in its body.

Agents must not write or post comments or replies on issues after they are opened.

## Discussions and design pull requests

AI can help prepare the initial text of a proposal for a Discussion. Before posting it, a human must review and edit it for correctness, coherence, and length, disclose the assistance, and post it manually.

Agents and bots must not write or post comments or replies in Discussions. Discussions are spaces for direct human deliberation, including comments on proposals.

AI can help prepare the initial proposal in a design pull request under the same human-review and disclosure rules. All reviews, comments, and replies on design pull requests must be written and posted by humans. Automated AI reviewers skip design pull requests.

## Implementation pull request comments and reviews

AI participation in pull request conversation is limited to code review and replies to code review on implementation pull requests.

- An agent can help reply to review comments on your implementation pull request under human control.
- An agent can review another person's implementation pull request only when a human explicitly requests that specific code review.
- An agent must not post other comments on another person's pull request.
- An agent must not comment on a design pull request.
- An authorised project bot can perform only its configured implementation-pull-request review task.

A code review examines code for correctness, security, compatibility, tests, and conformance with an accepted design. It does not include project-management discussion, persuasion, general conversation, or replying on a human's behalf.

Sign every substantially agent-written review, inline comment, and review reply posted from a human account:

> ~ 🤖 Agent name (model name)

Name the actual model used. Add the signature to each agent-written comment rather than only the final comment in a thread.

## Project-operated bots

Project-operated AI bots can perform narrowly configured code-review tasks on implementation pull requests. They use identifiable bot accounts and must not:

- open contribution pull requests or issues autonomously;
- participate in Discussions;
- comment on issues; or
- comment on design pull requests.

Deterministic repository automation can report status or perform an action explicitly requested through a documented repository command.
