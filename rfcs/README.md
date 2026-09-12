# EmDash RFCs

Significant changes to EmDash — protocol, schema, the plugin system, cross-cutting architecture — go through a lightweight RFC process before implementation. Bug fixes, docs, and self-contained features do not; they land as regular PRs.

## When to RFC

Open an RFC when your change:

- Defines or evolves a protocol or schema that third parties depend on (lexicons, plugin manifests, registry wire formats).
- Crosses multiple packages or touches the public extension surface in a way that is hard to reverse.
- Introduces user-facing concepts that plugin authors or site operators need to learn.
- Is genuinely load-bearing architecturally — the kind of change where "we'll figure it out in the implementation PR" leaves too many stakeholders out.

If in doubt, open a Discussion first and ask.

## Flow

This is a simplified version of the Astro RFC process. Two steps:

### 1. Discussion

Open a Discussion in the [Ideas category](https://github.com/emdash-cms/emdash/discussions/categories/ideas) describing the problem and the proposed direction. This is where "is this worth doing?" gets answered. No formal spec is required at this stage — prose, sketches and open questions are fine.

A maintainer signals acceptance by adding the `rfc-accepted` label to the Discussion (or commenting that it's ready to move to an RFC).

### 2. RFC PR

Once a Discussion is accepted, write the full RFC as a new file in `rfcs/` and open a PR.

- **File name:** `NNNN-short-slug.md`, zero-padded to four digits. Numbers are assigned in PR order; claim the next unused one when you open the PR.
- **Template:** copy [`0000-template.md`](./0000-template.md) and fill in each section.
- **Status header:** every RFC has a YAML frontmatter block. See the template for fields.
- **Discussion links are required.** Every RFC must link back to the Discussion(s) that motivated it via the `discussions:` field in the header. This is how readers understand the context the RFC was written in, and how the maintainer review gate remains traceable. An RFC PR with no linked Discussion will be sent back for a Discussion first.

Line-level review happens in the PR. When maintainers are satisfied, the PR merges and the RFC moves from `Draft` to `Accepted`. Implementation PRs then reference the accepted RFC number.

## Statuses

- **Draft** — RFC is open for review.
- **Accepted** — PR merged. The design is the plan of record. Implementation may or may not have landed.
- **Implemented** — the design has shipped. Update the status when the implementing PR lands.
- **Superseded** — a later RFC replaces this one. Include a `superseded-by: NNNN-foo.md` pointer in the header.

## Amendments

Accepted RFCs are historical records of the decision at the time. Small corrections (typos, clarifications, broken links) can land as direct PRs to the existing file. Substantive changes — modifying the design, loosening a rule, adding a field to a spec that's already shipped — require a new RFC that either supersedes the old one (`supersedes: NNNN-foo.md`) or amends it (`amends: NNNN-foo.md`).

## Numbering

RFCs are numbered sequentially starting at `0001`. `0000` is reserved for the template. Pick the next unused number when your PR is ready to open, renaming if necessary before merging.
