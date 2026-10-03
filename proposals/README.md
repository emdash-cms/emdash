# Feature plans and RFCs

Design a feature before opening its implementation pull request. Use a short feature plan for bounded, additive functionality within the existing architecture. Use a request for comments (RFC) for broader or harder-to-reverse decisions.

Both proposal types live in this directory, use descriptive filenames, and are reviewed in design pull requests. The design pull request number identifies the review and acceptance event; filenames do not use manually allocated numbers.

## Choose a process

### Direct implementation pull request

Open an implementation pull request directly for changes that do not introduce a feature:

- bug fixes with regression evidence;
- translations;
- documentation and tests;
- chores and dependency automation; and
- behavior-preserving refactors and performance improvements.

A refactor or performance change that alters observable behavior uses a feature plan or RFC.

### Feature plan

Use a feature plan for bounded, additive functionality that fits the current architecture. A feature plan normally assumes that its author intends to implement the work.

Copy [`feature-plan-template.md`](./feature-plan-template.md) to a descriptive filename and open a design pull request. A separate Discussion is optional. Link an issue, Discussion, or roadmap initiative when one exists.

A feature plan can merge after one human Maintainer other than the author approves it. There is no fixed minimum review period.

### RFC

Use an RFC when the change affects a public API, stored data, plugin surface, security boundary, default, backwards compatibility, several packages or runtimes, critical-path performance, a privileged supply-chain system, a breaking change, or another decision that would be expensive to reverse.

Start with an [Ideas Discussion](https://github.com/emdash-cms/emdash/discussions/categories/ideas) to establish the problem, demand, and broad scope. Then copy [`rfc-template.md`](./rfc-template.md) to a descriptive filename and open a design pull request.

An RFC requires:

- a named champion;
- a Maintainer sponsor;
- support from two other Maintainers, excluding the sponsor and Project Lead;
- acceptance by the Project Lead; and
- a public review period, normally at least seven days.

The Project Lead can extend the review period when the decision needs more evidence or participants have not had a reasonable opportunity to respond.

## Open a design pull request

Use the [design pull request template](../.github/PULL_REQUEST_TEMPLATE/design.md), prefix the title with `design:`, and keep the pull request limited to files under `proposals/`. A design pull request contains no implementation code.

Draft design pull requests are encouraged. A draft can contain unresolved questions or lack a sponsor when it states what remains open.

Prototyping is encouraged during design. Test feasibility, interfaces, performance, or interactions locally or in a fork, then link the findings from the design pull request. Do not open prototype implementation pull requests against EmDash before the design is accepted.

After opening the design pull request, replace `pending` in the proposal's `design-pr` field with its pull request number. The number is assigned by GitHub, so it cannot collide with another proposal.

Set the proposal status to `accepted` in the revision that the Maintainers approve. Merging the design pull request accepts the design and permits implementation. Close the design pull request after rejection or withdrawal; do not keep it open during implementation.

## Implement an accepted design

Every implementation pull request marked as a Feature links a merged design pull request in the EmDash repository. This applies to Maintainers, the Project Lead, employees, and external contributors. There is no routine exemption for small features.

Implementation review verifies correctness, security, compatibility, tests, and conformance with the accepted design. If implementation exposes a design flaw, open a design pull request that amends the accepted proposal before changing the behavior.

The automated reviewer loads the linked accepted proposal and reports omissions, divergences, unplanned scope, and missing tests. Its report is evidence for the human Maintainer who approves the implementation.

## Change an accepted proposal

A design pull request can amend, supersede, or withdraw an accepted proposal. Resolve conflicts between accepted or pending proposals before merging a conflicting design. The later proposal must update the affected existing proposal in the same design pull request so readers have one consistent plan of record.

Small corrections that do not change the design can use a normal documentation pull request.

## Transition for existing feature pull requests

Feature pull requests opened before 3 October 2026 are not failed automatically for lacking a design PR. A settled design can be recorded retrospectively in a feature plan. When product or architecture decisions remain unresolved, move those decisions into a proposal before continuing implementation review.

## Proposal index

Add each accepted proposal to this index in its design pull request. Record implementation pull requests when they merge.

No proposals have yet been accepted under this process.

The numbered RFCs under [`rfcs/`](../rfcs/) predate this process and keep their existing paths as historical records.
