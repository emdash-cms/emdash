---
title: Run many sites from one place
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: Daniel Mueller (@danielmlr)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/139
  - https://github.com/emdash-cms/emdash/discussions/3636
  - https://github.com/emdash-cms/emdash/discussions/3079
created: 2026-11-10
---

# Run many sites from one place

> **Draft.** Acceptance waits on the prototype results for the [acceptance gates](#acceptance-gates).

## Summary

An agency or a public body that runs many EmDash sites gets one tool to create, update and watch them: `emdash fleet`. Each site stays an ordinary EmDash site with its own Worker, database, media bucket, users and schema. The tool works through the commands and routes EmDash already has, plus one small core option.

- **A site list in the operator's repository.** `fleet.yaml` names every site, how it's built, and the resources the tool created for it. It holds no secret.
- **Commands in the core CLI.** `emdash fleet list`, `adopt`, `status`, `update`, `deploy`, `provision`, `reconcile` and `remove`.
- **Two layouts.** Sites that share one codebase (`shared`) are migrated and deployed by the tool in waves. Sites with their own repository (`repo`) get an update request from [#4577](https://github.com/emdash-cms/emdash/pull/4577), and their own pipeline does the rest. The tool can create both.
- **A provider interface.** Core defines it, and `@emdash-cms/cloudflare` implements it. Creating sites works on Cloudflare only in this RFC.
- **An optional setup secret in core.** With `EMDASH_SETUP_TOKEN` set, only someone holding the site's setup link can create its first Admin.

This is the "multisite" answer for EmDash: many isolated sites run from one place, not many sites inside one runtime. One Worker serving many databases is a non-goal, for the reasons under [Alternatives](#alternatives).

## Problem and user case

[Discussion #139](https://github.com/emdash-cms/emdash/discussions/139) asks for multi-tenancy, so that a developer "managing dozens of client sites" doesn't carry the overhead of a separate deployment per site. It has 14 upvotes. The replies describe what the people asking actually do and where it hurts:

- An agency moving dozens of client sites from WordPress Multisite says the part they use is operational: "one upgrade, one place to provision a new site in minutes, one dashboard to see them all". Every site keeps its own domain, content, users and schema.
- An operator who already runs separate sites, each with its own D1 database and R2 bucket, names what's left: "schema migrations across N sites. I don't have an elegant answer to that yet."
- A French agency sees "multisite on an open-source CMS" as a hard requirement in local-government tenders: one tender asks for 14 mini-sites and a generator that creates new ones from a template, another for up to 28 municipality sites.
- An operator building managed hosting on Cloudflare for Platforms wants a database per site and a separate admin plane for managing the sites.

[Discussion #2929](https://github.com/emdash-cms/emdash/discussions/2929) adds a problem that every automated deployment has. Until someone finishes setup, the first visitor who opens the setup wizard becomes the site's Admin. A studio that deploys sites from a script can only shorten that window, and it now writes the first admin straight into the database to close it.

Today each operator builds this by hand: one deployment per site, a CI matrix, `emdash migrate` per database, a Cron Trigger per Worker, and a script that remembers which site has which database. #4577 gives a single site an update request and leaves "a view for managing many sites at once" out, noting that "the CLI command can be scripted across sites". This RFC is that script, written once.

The narrower asks stay open: [Discussion #3636](https://github.com/emdash-cms/emdash/discussions/3636) asks the Durable Object backend to accept an already-addressed database stub, and [Discussion #3079](https://github.com/emdash-cms/emdash/discussions/3079) asks for a Kysely plugin pass-through for row-level scoping. Neither is needed for the design below, and neither is ruled out by it.

## Example

An agency keeps its client sites in one repository. One Astro project builds most of them, and `fleet.yaml` lists them. Two of its entries:

```yaml title="fleet.yaml"
version: 1
defaults:
  layout: shared
  project: ./site
  cloudflare:
    accountId: 0123456789abcdef0123456789abcdef
    zone: example.com
    d1Location: weur
sites:
  - key: bakery
    url: https://bakery.example.com
    groups: [clients]
    tokenEnv: EMDASH_TOKEN_BAKERY
  - key: harbour
    layout: repo
    url: https://harbour.example.org
    groups: [clients]
    tokenEnv: EMDASH_TOKEN_HARBOUR
    github:
      repository: example-agency/harbour-site
      ref: main
```

`bakery` doesn't exist yet. The operator creates it:

```bash
export CLOUDFLARE_API_TOKEN=...
npx emdash fleet provision bakery
```

```txt
bakery  quota      ok (Workers 41/500, Cron Triggers 41/250)
bakery  database   created emdash-bakery (weur)
bakery  bucket     created emdash-bakery-media
bakery  config     wrote .emdash/fleet/bakery/wrangler.jsonc (cron "* * * * *")
bakery  migrate    applied 94 migrations (target fingerprint recorded)
bakery  deploy     deployed emdash-bakery (no public URL yet)
bakery  secrets    set EMDASH_ENCRYPTION_KEY, EMDASH_SETUP_TOKEN
bakery  domain     attached bakery.example.com
bakery  health     https://bakery.example.com reports emdash 1.4.0
bakery  setup      open within 24 hours:
                   https://bakery.example.com/_emdash/admin/setup?token=...
```

The tool writes the IDs it created back into `fleet.yaml` under `bakery.cloudflare`. The operator opens the setup link, registers a passkey and becomes Admin. Nobody else can start setup on that site.

When EmDash 1.5.0 is out, the operator updates the shared project, builds it once and deploys it to every shared site, two at a time:

```bash
npx emdash fleet deploy --group clients --wave-size 2
```

```txt
wave 1  bakery   migrate 1 pending -> applied   deploy ok   health 1.5.0
wave 1  corner   migrate 1 pending -> applied   deploy ok   health 1.5.0
wave 2  lantern  migrate 1 pending -> FAILED (MIGRATION_LOCK_HELD)
stopped after wave 2: 1 failed (lantern, still on 1.4.0), 1 skipped (harbour, repo layout)
```

`lantern` keeps its old Worker, and the sites in later waves aren't touched. `harbour` has its own repository, so `deploy` skips it. `npx emdash fleet update --site harbour` sends it an update request instead, and its own workflow opens the update pull request.

## Goals

- An operator can create a complete, working site on Cloudflare with one command, including the Cron Trigger that scheduled publishing needs, either from the shared codebase or as a new repository with its own pipeline.
- A site that a script deployed can't be claimed by anyone except the person who holds its setup link.
- An operator can update all sites that share one codebase in waves, migrating each database before its new code runs, and the update stops at the first site that fails.
- An operator can send update requests to sites that have their own pipeline, in the same waves.
- An operator can see every site's running version, newest available version and reachability in one table or as JSON.
- A provisioning run that stops halfway can be finished or cleaned up by running the tool again.
- Nothing changes for a single site that doesn't use the tool, and the logged-out path stays as it is.

## Non-goals

- One runtime that serves many sites, whether through one Worker with many databases, a request-resolved database name, or a tenant column. See [Alternatives](#alternatives).
- A hosted console, a registry service or a web dashboard. A later proposal can build one on the same site list.
- Creating sites on Node.js, Docker or other hosts. Sites there can be adopted, and `status` and `update` work for them.
- Creating repositories on Git hosts other than GitHub. A site on another host can be adopted and updated through #4577's webhook trigger.
- One sign-in across sites. The deployment guide describes Cloudflare Access for that, and its seat limit, without tooling.
- Fleet commands over MCP. An agent that acts across sites is a separate security decision.
- Sharing content between sites, a network role above Admin, or a site switcher in the admin.

## Detailed design

### Terms

- **Fleet:** the sites listed in one `fleet.yaml`.
- **Site key:** a site's name in the list. It never changes, even when the URL does. Resource names derive from it.
- **Layout:** how a site is built and deployed. `shared`: one project builds many sites, and the tool migrates and deploys them. `repo`: the site has its own repository and pipeline, and the tool sends update requests.
- **Provisioned or adopted:** a site the tool created, or an existing site the operator added. Both layouts can be either.
- **Provider:** the code that creates and deploys a site on one platform. This RFC ships the Cloudflare provider.
- **Wave:** a group of sites that one command changes at the same time.

### The site list

`fleet.yaml` sits in the operator's repository. The commands find it in the working directory or take `--fleet <path>`. The operator writes the site entries. The tool writes only the keys it owns under each site (the resource IDs under `cloudflare` and `github`, and `state`), and keeps comments and key order. The full schema is in [Appendix B](#appendix-b-the-site-list).

The file holds no secret. Before every command, the tool validates the file and stops with the path of the first wrong value. Before it writes, it checks that the file hasn't changed since it read it, so two runs can't overwrite each other's records.

Every command that changes something takes an explicit selection: `--site <key>` (repeatable), `--group <name>` (repeatable) or `--all`. Without one it stops.

### Credentials

- **EmDash tokens:** per site, from the existing CLI credential store, which `emdash login` fills and keys by the site's origin. The variable named in the site's `tokenEnv` overrides the store, so CI can hold one token per site. `EMDASH_TOKEN` alone isn't enough for a fleet and isn't used by fleet commands.
- **Cloudflare token:** `CLOUDFLARE_API_TOKEN` from the environment only, the variable `emdash migrate` already reads. The tool never writes it to a file, never puts it in `fleet.yaml` and never logs it.
- **GitHub token:** `GITHUB_TOKEN` from the environment, only for provisioning a `repo` site. The same rules apply.
- **Generated site secrets:** `provision` generates `EMDASH_ENCRYPTION_KEY` and `EMDASH_SETUP_TOKEN` per site and sets them as Worker secrets. They never reach `fleet.yaml`. The setup token is printed once, inside the setup link.

The permissions each token needs are listed in [Appendix D](#appendix-d-limits-and-permissions). `status`, `update`, `adopt` and `list` don't need a Cloudflare token.

### Commands

All commands accept `--json`, which prints one result object per site and a summary. Exit code 0 means every selected site reached the target state, 1 means at least one site failed, and 2 means the command stopped before changing anything (bad file, missing selection, quota).

#### `fleet list`

Prints the sites from the file with key, URL, layout, groups and last recorded status. It makes no network call.

#### `fleet adopt <key> --url <url> --layout shared|repo`

Adds an existing site. The tool reads `/_emdash/api/health` and stops unless the URL answers as EmDash.

- For the `shared` layout, `--worker`, `--database-id` and `--account-id` record the Cloudflare resources, and the tool reads the target fingerprint with `emdash migrate --status`.
- For the `repo` layout, `--repository <owner/name>` records the repository. Nothing else is needed, because the site's own pipeline deploys it.

The entry gets `origin: adopted`.

#### `fleet status`

For each selected site, or every site when nothing is selected:

- The running version from `/_emdash/api/health`, which needs no token.
- The newest available version and the update request state from `GET /_emdash/api/admin/core-update`, when the site has a token. Today that route needs a token with the `admin` scope. With #4577 a token with only the `updates:request` scope is enough.
- Reachable or not, the HTTP status, and the last recorded operation.

`status` changes nothing.

#### `fleet deploy` (shared layout)

Builds the shared project once, then deploys it to the selected `shared` sites in waves. `repo` sites in the selection are skipped and reported. For each site, the documented "build, migrate, deploy, check" steps run against the site's own target:

1. `emdash migrate --status` against the site's database through its generated Wrangler config. A target fingerprint that differs from the recorded one stops this site.
2. `emdash migrate` with `--expected-target-fingerprint` when migrations are pending.
3. `wrangler deploy` with the site's generated Wrangler config.
4. `emdash migrate --check`, then `/_emdash/api/health` until it reports the build's version, for at most `--timeout` (default 2 minutes).

`--dry-run` prints the steps and the pending migrations without changing anything.

#### `fleet update` (repo layout)

Sends an update request to each selected `repo` site through #4577's `POST /_emdash/api/admin/core-update/request`, then waits until `/_emdash/api/health` reports the requested version, for at most `--timeout` (default 60 minutes). `shared` sites in the selection are skipped and reported.

- The request always names the version the site's own update check reports, as #4577 requires. Sites with a different `minimumReleaseAge` can get different versions.
- `--version <x.y.z>` refuses any site that reports another version, so a wave can't mix versions by accident.
- Before it sends, the tool reads the site's update status. A site with no trigger, or a trigger that isn't ready, fails with #4577's error code before anything is sent.
- A site whose pipeline waits for a person to review the update pull request holds its wave until the timeout.

#### Waves

`--wave-size <k>` (default 1) sets how many sites run at the same time. Waves run one after another in the order of the file, or the order given by `--order <file>`. When any site in a wave fails, the sites already running finish and no further wave starts. Sites that weren't reached stay on their old version and are listed as skipped. A site counts as done only when its health route reports the target version, because only the running version proves that the update arrived.

#### `fleet provision <key>`

Creates a new site from its entry. Each step is idempotent: before it creates something, it looks for a resource under the name derived from the site key, and it records the result under `state.steps` before it moves on. The full list of steps for both layouts is in [Appendix C](#appendix-c-provision-steps). In short:

- **Shared layout:** quota check, D1 database, R2 bucket, a generated Wrangler config with the bindings and a Cron Trigger, core migrations, a first deploy without a public URL, the site secrets, the custom domain, a health check and the setup link. Optionally, the template's seed and title through the setup API, and a site package import once an Admin exists.
- **Repo layout:** the same Cloudflare resources, plus a new GitHub repository from a template, with the Wrangler config, the update trigger and #4577's workflow committed to it. The tool makes the first deploy from a checkout, then hands deploys to the repository's pipeline and prints which secrets the operator must set for it.

The Worker isn't reachable until its secrets are set: the generated config sets `workers_dev` and `preview_urls` to `false`, and the custom domain is attached only after `EMDASH_SETUP_TOKEN` exists. The setup link uses the site's final URL, because EmDash stores the site URL once during setup and passkeys are bound to that origin.

#### `fleet reconcile [--site <key>]`

Compares each selected site's recorded state with what exists. It completes provisioning steps that are missing or `waiting`, reports a Worker, database, bucket or repository that exists but isn't recorded (or the other way round), and reports a site whose Cron Trigger or custom domain is missing. With `--abandon`, it deletes the resources of a provisioning that never reached the setup step, after a confirmation. It never deletes a database whose setup is complete, and never deletes a repository.

#### `fleet remove <key>`

Takes a site out of service without deleting its data:

1. Exports the site with `emdash site export` into `--out <dir>`.
2. Removes the custom domain, so the site stops serving.
3. Removes the Cron Trigger, so it stops counting against the account limit.
4. Marks the entry `removed`.

The database, the bucket, the Worker script and, for a `repo` site, the repository stay. Deleting them is left to the operator. A removed site can be brought back with `reconcile`. For a `repo` site, the repository's pipeline would put the Cron Trigger back on its next deploy, so `remove` tells the operator to disable that pipeline.

### Provider interface

Core defines the interface and the commands. Everything that talks to the Cloudflare API lives in `@emdash-cms/cloudflare`, as the D1 migration code for `emdash migrate` does today, and core has no Cloudflare API client. The CLI loads the provider from the site's database adapter, the way `emdash migrate` loads the migration executor that the build manifest names. The Cloudflare provider deploys by running the project's Wrangler with the generated config and uses the Cloudflare API for everything else.

The GitHub part of `repo` provisioning sits behind its own small interface in core, with a GitHub implementation, so that tests can replace it and another host can be added later. Tests replace both with local implementations that create SQLite files, run `wrangler dev` and write to a local Git repository. The interfaces are in [Appendix A](#appendix-a-interfaces).

### Setup secret (core)

A new optional secret, `EMDASH_SETUP_TOKEN`, read from `process.env` like the other site secrets. When it isn't set, setup behaves exactly as today. When it's set, and until setup is complete, every path that can create the first Admin requires it:

| Path | Without a valid token |
| --- | --- |
| The setup wizard and `POST /_emdash/api/setup` | 403 `SETUP_TOKEN_REQUIRED` |
| `POST /_emdash/api/setup/admin` and `/setup/admin-verify` (passkey) | 403 `SETUP_TOKEN_REQUIRED` |
| The first sign-in through an OAuth provider while setup isn't complete | refused, no user is created |
| The AT Protocol provider's setup route and its first sign-in while setup isn't complete | refused, no user is created |
| The dev bypass routes | unchanged (development only) |

The token reaches the site in the setup link's `token` query parameter. The setup page sends it to the API in a header. The first request that presents it sets an HttpOnly, SameSite=Strict cookie scoped to `/_emdash`, so the provider redirects of an OAuth or AT Protocol sign-in carry it. The comparison is constant-time. The token stops working once setup is complete, so a link that leaks after setup grants nothing. With external authentication (Cloudflare Access), the provider's policy decides who reaches the site; see [Open questions](#open-questions).

The admin's setup screen shows a short message when the token is missing or wrong, translated like every other admin string. The error code is new and mapped in `mapErrorStatus`.

## Compatibility and migration

Every change is additive:

- `emdash fleet` is a new command group. No existing command changes.
- `EMDASH_SETUP_TOKEN` is new and optional. Sites that don't set it see no change, and local development and the documented first-run path stay as they are.
- The provider interfaces and the Cloudflare provider are new exports.
- There's no database migration and no change to stored data.
- `fleet.yaml` carries `version: 1`. A later format gets a new version, and the tool refuses a version it doesn't know.

A site can leave the fleet at any time: deleting its entry changes nothing on the site. Rolling back the setup secret means unsetting the Worker secret.

### Dependency on #4577

`fleet update` and provisioning a `repo` site use #4577's request route, its `updates:request` token scope, its error codes, its `updateCheck.trigger` option and its shipped workflow file. This RFC is written against #4577's current revision. If #4577 changes before this RFC is accepted, this RFC is amended in the same revision so that every name above matches #4577's text. If #4577 is accepted with changes after this RFC, the implementation follows #4577 and this proposal is amended by a design pull request. If #4577 is withdrawn, `fleet update` and `repo` provisioning are removed from this RFC before acceptance; `repo` sites can then still be adopted for `status`.

If [the env file plan (#4683)](https://github.com/emdash-cms/emdash/pull/4683) lands, its `--env-file` option works for fleet commands the same way. If [custom roles (#4156)](https://github.com/emdash-cms/emdash/pull/4156) land, a fleet token can belong to a role limited to what the tool needs.

## Security and privacy

- **The Cloudflare token** is the most valuable secret in the system. Creating a Worker needs product-level Workers Admin, so a token that can provision can also delete every Worker on the account. It stays in the operator's environment or CI secrets and is never stored by the tool. The docs recommend a token per environment, and a separate account where customers must be separated.
- **Repo layout:** the tool never copies a Cloudflare token into a repository's secrets. It prints which secrets the repository's pipeline needs, and the operator creates them. A deploy token can be scoped to that site's Worker, which the Cloudflare docs allow once the Worker exists. A deploy token isn't multiplied across many repositories by the tool.
- **The GitHub token** can create repositories in the target owner and push to them. It's needed only during `repo` provisioning.
- **EmDash tokens** are per site and scoped. `status` needs `admin` today and only `updates:request` with #4577; `deploy` and `provision` need no EmDash token; `remove` needs `transfer:export`. A token for one site can't act on another, because each site has its own users and token table.
- **The setup window:** with `EMDASH_SETUP_TOKEN`, the first Admin can only be created by someone who holds the link. The token is generated per site, set only as a Worker secret and printed once. Anyone who can read the operator's terminal output or CI log at that moment can claim the site, so `provision` prints the link only on an interactive terminal unless `--print-setup-link` is passed. The Worker has no public URL until the secret is set.
- **The site list** holds account IDs, database IDs, repository names and hostnames, no secrets. Those identifiers aren't credentials, but they tell a reader which customers an agency has, so operators keep the file in a private repository.
- **Untrusted input:** responses from sites are parsed as data. A site that reports an unexpected version or JSON shape fails its step, and nothing from a response is used as a URL or a command.
- **Privacy:** each site's users and content stay in that site's database. The tool reads only version and update state. `remove` writes an export file that holds personal data, and the docs say to treat it like a backup.

## Performance

No request path changes. The logged-out routes run the same queries, and the query-count snapshot stays the same. The setup secret check runs only on setup and first sign-in routes, and only while setup is incomplete.

The tool's own cost is outbound requests from the operator's machine or CI: one health request per site for `status`, plus one admin request when a token is present. Account limits matter more than speed. With one Worker and one Cron Trigger per site, the Cron Trigger limit (250 per account on Workers Paid) is the number of full sites per account. The limits are in [Appendix D](#appendix-d-limits-and-permissions).

## Failure handling

- **Provisioning stops halfway** (for example the deploy fails after the database exists): the steps that finished are recorded. Running `provision` or `reconcile` again continues from the first step that isn't done. `reconcile --abandon` removes the half-created resources.
- **The quota is reached:** `provision` stops before creating anything and names the limit. Options are a second account or a higher limit from Cloudflare.
- **A migration fails or the lock is held:** the wave stops, the site keeps its old Worker, and the output names the error from `emdash migrate`. The documented migration lock rules and the `--release-lock` and `--take-over-lock` options apply.
- **The target fingerprint changed:** the site stops before anything runs. The operator checks the database and records the new fingerprint with `adopt` or `reconcile`.
- **A site doesn't report the new version in time:** it counts as failed, and no further wave starts. For a `repo` site this is often a pull request waiting for review.
- **A site is unreachable:** `status` reports it and moves on. `deploy` and `update` count it as failed.
- **An update request is rejected:** #4577's error code (`UPDATE_NOT_AVAILABLE`, `UPDATE_ALREADY_REQUESTED`, `UPDATE_TRIGGER_NOT_READY` and the others) is printed for that site.
- **The repository already exists** during `repo` provisioning: the tool uses it only if it's empty or holds the tool's own first commit, and stops otherwise.
- **`fleet.yaml` changed during a run:** the tool doesn't write and prints the records it would have written, so they can be added by hand or recovered with `reconcile`.
- **Observability:** every command prints one line per site and step, and `--json` gives the same as structured output for CI logs.

## Verification

- Unit tests for the file format: validation errors with their path, `defaults`, comment-preserving writes, and the refusal to write after a concurrent change.
- Command tests against a local fleet of three sites with the local providers: `status` with and without tokens, `deploy` in waves with one injected failing migration, a fingerprint mismatch, and `update` against a stub of #4577's request route with one site that never reports the new version.
- Provisioning tests for both layouts that fail at each step and then run `provision` again, and `reconcile` finishing a half-done site.
- Provider tests at the HTTP boundary for Cloudflare and GitHub: request shapes, the quota check, idempotent creation when the resource exists, and token redaction in errors. `--dry-run` prints every API call.
- Setup secret tests on a real SQLite database for each path in the table: refused without the token, succeeds with it, and no change when the secret isn't set. Admin tests for the message, including Arabic.
- The query-count snapshot shows no change.
- A manual run of `provision` (both layouts), `deploy`, `update` and `remove` on a throwaway Cloudflare account and GitHub organization.

### Acceptance gates

This RFC moves to `accepted` only when these results are linked from the design pull request:

- **Fleet prototype** (a local branch, not a pull request, as `proposals/README.md` asks):
  - `status` over three local sites, with and without tokens.
  - `deploy` waves that stop at an injected migration failure and leave the other sites on their old version, and a fingerprint mismatch that stops one site before anything runs.
  - `provision` for the `shared` layout with the local provider, run again after a failure at every step, and `reconcile` finishing a half-done site.
  - The setup secret: every path in the table refuses without the token, setup succeeds with it, and a site without the secret behaves as today.
  - `update` waves against a stub of #4577's request route, including a site that never reports the new version.
  - A list of every place where the design needed a decision it doesn't state, each resolved in this text. In particular, whether `deploy` or `status` needs migration state over HTTP.
- **Isolate per site:** a local check of one parent Worker that loads each site as a Worker Loader child with its own database, with one verdict (works, works with named gaps, or fails) and the measured cold start and memory per site. The verdict decides what [Alternatives](#an-isolate-per-site-behind-one-worker) says. It doesn't change the fleet design unless it shows a path that needs no Worker per site.
- **Platform facts:** the limits and token permissions in Appendix D re-read in the Cloudflare docs, and whether user Workers in a dispatch namespace support Cron Triggers and the Workers Cache.
- **A real-account run** of `provision` and `remove` for the `shared` layout on a throwaway Cloudflare account, by the author.

The `repo` layout isn't prototyped before acceptance, because it needs #4577's workflow. Its gate is the manual run in the implementation slice that ships it.

## Rollout and implementation

Each slice is usable without the next:

1. `fleet.yaml`, `fleet list` and `fleet adopt`.
2. `fleet status`.
3. `EMDASH_SETUP_TOKEN` in core, with the docs for automated deployments. It helps every scripted deployment, not only fleets.
4. The provider interface, the Cloudflare provider, `fleet provision` for the `shared` layout and `fleet reconcile`.
5. `fleet deploy` and `fleet remove`.
6. **Waits for #4577's acceptance:** `fleet update`. It ships after #4577's request route and `updates:request` scope.
7. **Waits for #4577's acceptance:** `fleet provision` for the `repo` layout, with the GitHub interface. It ships after #4577's workflow file and `updateCheck.trigger` option.

A deployment guide page, "Run many sites from one codebase", ships with slice 4 and gains the `repo` layout with slice 7.

## Alternatives

### Many sites in one runtime

One Worker could pick the database from the hostname, as Discussion #139 asks, either through a request-resolved Durable Object name or a binding map. EmDash keeps state per runtime, not per database: site settings are cached per isolate, the locale configuration is a single global, and the runtime holds one plugin manager. Each piece would have to be keyed by site, and a missed one leaks one site's data into another. Locales and native plugins are fixed per build, so every site in the Worker would share them. Fleet tooling gives operators "one core, one upgrade" without that risk, and it doesn't block a later RFC for request-resolved databases.

### An isolate per site behind one Worker

A parent Worker could load each site as a Worker Loader child and hand it its own database. That would keep sites isolated in one deployment and would need the addressed stub from Discussion #3636. [Pending: the acceptance gate's verdict, with cold start, memory and cron behaviour.]

### Workers for Platforms

A dispatch namespace removes the per-account Worker limit. Scheduled publishing depends on a Cron Trigger per site. [Pending: whether user Workers in a dispatch namespace can have Cron Triggers and the Workers Cache, from the Cloudflare docs.] The provider interface leaves room for a Workers for Platforms provider once that's settled.

### A shared database with a tenant column

This is what Payload's multi-tenant plugin does. Every query has to carry the filter, raw SQL for content writes and search doesn't pass through a Kysely plugin, and each EmDash site keeps its own schema, which a shared table can't hold. Discussion #3079's pass-through remains useful for scoping inside one site.

### A separate tool outside the project

A tool outside the project would track the CLI, the migration protocol and the setup flow from the outside, and the setup window can't be closed without a core change. Keeping `fleet` in the CLI lets it share the credential store, the migration code and the release cadence.

### A hosted console

A registry Worker with a web dashboard matches what agencies know from WordPress fleet managers. It needs a long-lived Cloudflare token stored in a Worker. The CLI keeps that token in CI, and a console can be added later on the same site list.

### A repository per site only

`create-emdash` already creates a project per site, and this RFC's `repo` layout adds provisioning and update requests for such sites. On its own, a repository per site doesn't give the operators in Discussion #139 "one core, one upgrade", so the `shared` layout stays the default.

## Drawbacks

- Creating sites works only on Cloudflare in this RFC, and creating repositories only on GitHub.
- The Cloudflare token in the operator's CI can delete every Worker on the account.
- It isn't what Discussion #139 literally asked for: each site is still its own deployment, and an operator with many sites pays for one Worker, one database and one Cron Trigger each, within the account limits.
- `update` waits on pipelines it doesn't control, so a wave of `repo` sites can stall on one pull request.
- The tool rewrites part of a file the operator also edits.
- Half of the update story depends on #4577.

## Open questions

- **External authentication:** should `EMDASH_SETUP_TOKEN` also hold back the rule that the first user who passes Cloudflare Access becomes Admin? The Access policy already decides who reaches the site, but an open policy plus that rule reopens the setup window.
- **The encryption key:** `provision` sets `EMDASH_ENCRYPTION_KEY` as a Worker secret, which can't be read back, and losing it loses every plugin secret on the site. Should the tool write it to an operator-chosen file, print it once, or leave it to the operator's own secret manager?
- **Migration state over HTTP:** `deploy` reads migration status through `emdash migrate`, which needs the Cloudflare token. A read-only route for an EmDash token would let `status` show pending migrations without it. Is that worth a core change? [Pending: prototype finding.]
- **Waiting in `update`:** should there be a mode that sends requests in waves without waiting for the new version, for fleets where every update pull request is reviewed by hand?
- **Beyond one account:** should one `fleet.yaml` span several Cloudflare accounts, or should an operator keep one file per account?
- **The isolation unit:** if the isolate-per-site check is inconclusive, does that change anything in this design, or only a later RFC?

## Appendix A: Interfaces

### Provider

```ts
interface FleetProvider {
	readonly name: string;
	checkQuota(site: SiteEntry): Promise<QuotaReport>;
	ensureDatabase(site: SiteEntry): Promise<{ databaseId: string; created: boolean }>;
	ensureBucket(site: SiteEntry): Promise<{ bucket: string; created: boolean }>;
	writeDeployConfig(site: SiteEntry, projectDir: string): Promise<{ path: string }>;
	deploy(site: SiteEntry, configPath: string): Promise<void>;
	setSecrets(site: SiteEntry, secrets: Record<string, string>): Promise<void>;
	attachDomain(site: SiteEntry): Promise<void>;
	detachDomain(site: SiteEntry): Promise<void>;
	removeSchedule(site: SiteEntry): Promise<void>;
	inspect(site: SiteEntry): Promise<ResourceReport>;
	deleteResources(site: SiteEntry, which: ResourceKind[]): Promise<void>;
}

interface QuotaReport {
	ok: boolean;
	limits: { name: string; used: number; limit: number }[];
}

type ResourceKind = "worker" | "database" | "bucket" | "domain" | "schedule";

interface ResourceReport {
	found: Partial<Record<ResourceKind, { id: string; matchesRecord: boolean }>>;
	missing: ResourceKind[];
}
```

### Repository host

```ts
interface RepositoryHost {
	readonly name: string;
	ensureRepository(
		site: SiteEntry,
		template: string,
	): Promise<{ repository: string; created: boolean; empty: boolean }>;
	commitFiles(site: SiteEntry, files: Record<string, string>, message: string): Promise<{ commit: string }>;
	checkout(site: SiteEntry, dir: string): Promise<void>;
}
```

### Command results

```ts
interface SiteResult {
	key: string;
	status: "done" | "failed" | "skipped" | "waiting";
	steps: { name: string; status: "done" | "failed" | "skipped" | "waiting"; detail?: string }[];
	version?: string;
	error?: { code: string; message: string };
}

interface CommandResult {
	command: string;
	sites: SiteResult[];
	summary: { done: number; failed: number; skipped: number; waiting: number };
}
```

## Appendix B: The site list

```ts
interface FleetFile {
	version: 1;
	defaults?: Partial<SiteEntry>;
	sites: SiteEntry[];
}

interface SiteEntry {
	/** `^[a-z][a-z0-9-]{0,39}$`, unique, never changes. */
	key: string;
	url: string;
	layout: "shared" | "repo";
	groups?: string[];
	/** Name of the environment variable that holds this site's EmDash API token. */
	tokenEnv?: string;
	/** `shared` layout: path of the Astro project that builds the site. */
	project?: string;
	cloudflare?: {
		accountId: string;
		zone?: string;
		d1Location?: string;
		/** Written by the tool. */
		worker?: string;
		databaseId?: string;
		bucket?: string;
		targetFingerprint?: string;
	};
	/** `repo` layout. */
	github?: {
		repository: string;
		ref?: string;
		/** `repo` provisioning: `owner/name` of the template repository. */
		template?: string;
	};
	/** Written by the tool. */
	state?: {
		origin: "provisioned" | "adopted";
		status: "provisioning" | "active" | "failed" | "removed";
		steps?: Record<string, { status: "done" | "failed" | "waiting"; at: string; detail?: string }>;
		lastVersion?: string;
	};
}
```

`defaults` apply to every site that doesn't set the key itself; nested objects merge one level deep. Resource names derive from the key: Worker `emdash-<key>`, database `emdash-<key>`, bucket `emdash-<key>-media`, repository `<owner>/<key>-site` unless `github.repository` is set.

## Appendix C: Provision steps

Each step records `done`, `failed` or `waiting` under `state.steps.<name>` before the next one starts. A step that finds its resource under the derived name records it and moves on.

### Shared layout

1. **quota:** counts the account's Workers and Cron Triggers against their limits and stops with exit code 2 when the site wouldn't fit. The tool never creates a site Worker without a Cron Trigger, because it would never publish scheduled entries.
2. **database:** creates the D1 database with the configured location hint.
3. **bucket:** creates the R2 bucket.
4. **config:** writes `.emdash/fleet/<key>/wrangler.jsonc` with the Worker name, the `DB`, `MEDIA` and `LOADER` bindings, `triggers.crons`, `workers_dev: false` and `preview_urls: false`. The custom domain isn't in the config yet.
5. **migrate:** applies the core migrations and records the target fingerprint.
6. **deploy:** deploys the Worker. It has no public URL at this point.
7. **secrets:** generates and sets `EMDASH_ENCRYPTION_KEY` and `EMDASH_SETUP_TOKEN`.
8. **domain:** adds the custom domain to the config and attaches it.
9. **health:** waits until the URL reports EmDash and the build's version.
10. **seed** (with `--title`): runs the site step of setup through `POST /_emdash/api/setup` with the setup token, so the template's seed and the title are applied on the final hostname.
11. **setup-link:** prints the link, on an interactive terminal or with `--print-setup-link`.
12. **import** (with `--import <file.emdash>`): imports a site package through `emdash site import`. An import needs an Admin token, so this step stays `waiting` until setup is finished and the operator has run `emdash login`. `reconcile` completes it.

### Repo layout

1. **quota**, **database** and **bucket** as above.
2. **repository:** creates `github.repository` from `github.template` (by default the template the operator names with `--template`). An existing repository is used only if it's empty or holds the tool's own first commit.
3. **files:** commits `wrangler.jsonc` (as in step 4 above, plus the custom domain), the `updateCheck.trigger` for this repository in the EmDash configuration, and #4577's `.github/workflows/emdash-update.yml`.
4. **migrate:** as above, from a checkout of the new repository.
5. **deploy:** the first deploy from the checkout, with the custom domain left out until step 7.
6. **secrets:** as above.
7. **domain:** attaches the custom domain and commits the config change.
8. **health**, **seed** and **setup-link** as above.
9. **handover:** prints the secrets the operator must create, and where:
   - a Cloudflare token for the repository's deploy pipeline, scoped to this site's Worker (plus D1: Editor if the pipeline runs migrations), as a repository secret;
   - `EMDASH_UPDATE_TOKEN`, #4577's GitHub token with Actions: write on this repository, as a Worker secret.

   Until both exist, `fleet status` shows the site's update trigger as not ready.

## Appendix D: Limits and permissions

Read in the Cloudflare docs on 2026-11-10.

### Account limits

| Resource | Workers Free | Workers Paid |
| --- | --- | --- |
| Workers per account | 100 | 500 |
| Cron Triggers per account | 5 | 250 |
| D1 databases per account | 10 | 1,000,000 (first 100,000 included) |
| R2 buckets per account | unlimited, default limit 100,000 | unlimited, default limit 100,000 |
| Custom domains per zone | 100 | 100 |

Workers Cache purges always use the Free purge limits, whatever the plan: 5 requests per minute per account, with a bucket of 25. Every site on the account shares that budget when editors publish.

### Cloudflare token permissions

| Use | Permission |
| --- | --- |
| Create Workers, set secrets and Cron Triggers | Workers: Admin at product scope (creating a Worker needs it) |
| Deploy an existing site | Workers: Editor for that Worker |
| Create D1 databases | D1: Admin |
| Migrate a database | D1: Editor |
| Create R2 buckets | R2: Admin |
| Attach or remove a custom domain | Zone: Workers Routes: Write on the site's zone |

### GitHub token permissions

`repo` provisioning needs a token that can create repositories in the target owner, push to them and add workflow files. [Pending: the exact fine-grained permissions, from the GitHub docs.]
