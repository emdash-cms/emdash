# Maintaining EmDash

This guide defines review, approval, and merge requirements for EmDash Maintainers. [GOVERNANCE.md](GOVERNANCE.md) lists the current Maintainers and separates project roles from repository access.

## Merge requirements

A normal pull request can merge when:

- required checks pass;
- blocking review threads are resolved;
- at least one human Maintainer other than the author has approved the current revision; and
- the change follows an accepted design when the contribution process requires one.

These requirements apply to the Project Lead, Cloudflare employees, external Maintainers, and other contributors. Routine self-merge is not permitted.

The author is the pull request's main author. A Maintainer who has made substantial changes to someone else's pull request, including an EmDashBot pull request, also counts as an author and cannot provide its approval. Automation only excludes the account that opened the pull request, so Maintainers apply this rule themselves.

An approval applies to the reviewed revision. A later substantive commit requires another approval. A merge commit that only updates the branch from `main` does not invalidate an approval.

Project Team reviews, automated reviews, test results, and static analysis help the human reviewer. They do not replace Maintainer approval. A bot with repository permissions is still a bot, not a Maintainer.

An approval means the approving Maintainer reviewed and verified the change themselves. An agent-written review, including one posted from the Maintainer's own account under the [AI usage policy](AI_POLICY.md#implementation-pull-request-comments-and-reviews), is evidence for that decision, not a substitute for it.

## Changes that require two approvals

The following changes require approval from two human Maintainers other than the author:

- governance and contribution policy;
- protected-branch and required-check automation;
- release and package-publishing automation;
- settings or automation that control access to the repository, published packages, production systems, or credentials; and
- another privileged supply-chain path where a compromise could approve, alter, or publish a release.

The approval workflow (`.github/workflows/approval.yml`) lists the repository paths that enforce these controls. When a change affects the same privileged boundary through a new path, apply the two-approval rule even before the path list is updated.

## Review responsibilities

Before approving, verify the parts relevant to the change:

- the contribution is in scope and uses the correct contribution path;
- the implementation matches its linked accepted design, if it has one;
- backwards compatibility, data, security, localization, accessibility, and performance constraints are addressed;
- the tests exercise observable behavior and the reported bug when applicable;
- user-facing package changes have a useful changeset;
- required screenshots or other runtime evidence are present; and
- automated findings have been resolved, rebutted with evidence, or consciously accepted.

An accepted design reduces implementation review, but it does not make review mechanical. If implementation exposes a flaw in the design, amend the proposal explicitly instead of changing the design implicitly through code review.

## Maintainer decisions

Maintainers can merge, close, or redirect work where documented policy or an accepted design supplies the direction. Escalate to the Project Lead when a decision establishes new direction, conflicts with an accepted design, changes governance, or cannot reach agreement.

Explain a public decision in the relevant public GitHub artifact. Keep personnel, conduct, embargoed security, credentials, legal, and privacy matters in the restricted channels defined by [GOVERNANCE.md](GOVERNANCE.md#public-and-private-channels).

## Emergency bypass

During an urgent security or production incident, the Project Lead or a nominated Maintainer can bypass the normal approval requirement when waiting would create greater risk.

Record the bypass and obtain retrospective review as soon as it is safe to disclose and review the change. Do not use the emergency path for scheduling pressure or ordinary CI failures.

## Access is separate from the role

Grant only the access needed for an agreed responsibility. Review GitHub Write or Admin access, package publishing, releases, production systems, secrets, and Discord administration independently.

The canonical Maintainer list is in [GOVERNANCE.md](GOVERNANCE.md#maintainers). Repository automation checks that a qualifying reviewer is human, appears on that list, did not open the pull request, and approved the current revision. GitHub permissions alone do not establish Maintainer status.
