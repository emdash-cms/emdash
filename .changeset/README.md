# Writing and reviewing changesets

A changeset determines the version bump for a published package, and its description becomes public documentation in the package CHANGELOG. Readers commonly encounter it while deciding whether and how to upgrade. Write and review it for someone who runs the package, not someone who has read the pull request or diff.

## When to add a changeset

Add a changeset for any change to a published package's behavior or API, including bug fixes, features, and behavior-changing refactors. Without one, the change will not trigger a release.

- Multi-package changes need one changeset listing all affected packages.
- A pull request with several distinct changes can include one changeset per change; each becomes a separate CHANGELOG entry.
- Several pull requests that build one feature for the same release, such as a stack of dependent pull requests, need one changeset describing the complete user-facing capability. Put it in one pull request in the stack rather than documenting the implementation sequence. Use one changeset only when release coordination guarantees that every pull request will ship together; otherwise, each independently releasable pull request needs its own changeset.
- Docs-only, test-only, CI/tooling, demo, and template changes do not need a changeset. [`config.json`](config.json) lists packages that are excluded from releases.

Create a changeset with the following command, then edit the generated Markdown file:

```bash
pnpm changeset
```

The pull request author selects the affected packages and bump type in the changeset frontmatter. Use `patch` for bug fixes and small improvements, and `minor` for new backwards-compatible features. EmDash does not currently accept `major` bumps while it is pre-1.0. A breaking change or significant default change requires prior maintainer approval; use the package and bump strategy agreed with the maintainers.

## Lead with the released behavior

Lead with a present-tense verb such as **Fixes**, **Adds**, **Updates**, **Removes**, or **Deprecates**. In the opening sentence:

- Name the user-facing API, option, command, component, or behavior when readers will recognize it.
- Identify who is affected and what they can now do, or state the observable problem that is fixed.
- Describe the released behavior, not file names, private functions, refactors, queries, or implementation choices.

Give detail in proportion to the impact. One specific sentence is often enough for a patch. A significant minor feature usually needs the capability, basic usage, defaults and compatibility, affected environments, and any action readers must take. Put the most important capability first; do not bury it under incidental fixes or implementation details.

Breaking changes and default changes must be unmistakable. State who is affected, the previous and current behavior, the action required to migrate, and how to restore the previous behavior when that is possible. Prefer a minimal configuration or before-and-after example over a general warning.

Longer entries can use Markdown headings, but start at h4 (`####`). Changesets are embedded below headings in generated CHANGELOG files, so h2 or h3 headings break the document hierarchy.

Do not keep useful explanations or examples only in a changeset or PR description. Add them to the canonical feature or upgrade documentation too; the CHANGELOG is usually read once, while the docs remain the reference.

## Examples

The following patch entry names the affected command and the problem a script author observes:

```md
---
"emdash": patch
---

Fixes `emdash migrate --json` so progress messages go to stderr, allowing scripts to parse stdout as JSON.
```

The following minor-feature entry explains the capability, basic usage, and exit-code contract:

````md
---
"emdash": minor
---

Adds `--check` to `emdash migrate` so deployment pipelines can detect pending or unknown migration records without changing the database.

Run the check after deploying the application artifact that produced the migration manifest:

```sh
pnpm exec emdash migrate --check
```

The command exits with `0` when the database matches the build, `2` when known migrations are pending, and `3` when the database contains migration records unknown to the build. It works with every database adapter supported by the migration manifest.
````

The following approved default-change entry records its `minor` bump and makes the impact and reversion path explicit:

````md
---
"emdash": minor
---

Updates `memoryCache()` to use a five-minute default TTL instead of one hour, so sites using the in-memory object cache refresh cached pages more frequently after an upgrade.

Sites that depend on the previous one-hour lifetime can keep it explicitly:

```ts
objectCache: memoryCache({ defaultTtl: 3600 });
```

#### What should I do?

Set `defaultTtl: 3600` before upgrading if the shorter cache lifetime would add unacceptable load to your site.
````

Use the same level of detail for a breaking change: name the removed or changed surface in the first sentence, then provide the smallest working migration. Do not submit a breaking change until maintainers have approved its package and release strategy.

## Bad and good descriptions

These comparisons show the difference between technically related prose and useful release documentation:

```diff
- Fixes a bug in media handling.
+ Fixes R2 media uploads larger than 10 MB failing before the upload begins.
```

```diff
- Refactors `hydrateEntryBylines` to chunk SQL IN clauses.
+ Fixes D1 errors when loading an entry with more bylines than the database bind-parameter limit.
```

```diff
- Updates migration status handling and exit codes.
+ Adds `emdash migrate --check` so deployment pipelines can detect pending or unknown migrations without changing the database.
```

## Review changesets as documentation

Request a rewrite when an entry is vague, describes internal mechanics, reads like a commit message, buries a significant capability under incidental details, or does not help readers decide whether the release matters to them. Frontmatter validity and technical accuracy are necessary but not sufficient.

Review the description as documentation alongside the bump type and package list.

For Changesets CLI and configuration behavior, see the [Changesets documentation](https://github.com/changesets/changesets/tree/main/docs).
