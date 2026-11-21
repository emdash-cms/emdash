---
title: Run many sites from one place with emdash fleet
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: Daniel Mueller (@danielmlr)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/139
created: 2026-11-10
---

# Run many sites from one place with emdash fleet

## Summary

An agency or a public body that runs many EmDash sites gets one tool to create, update and watch them: `emdash-fleet`. Each site stays an ordinary EmDash site with its own deployment, database, media storage, users and schema. The tool works through the commands and routes EmDash already has, plus two small core changes.

- **A separate CLI in the monorepo.** `@emdash-cms/fleet` ships the `emdash-fleet` command and the same operations as a library, so a web console can call them later; `provision`, `deploy` and `update` run builds or installs, so a console runs those as CI jobs. The `emdash` CLI doesn't change.
- **A typed site list, and no state file.** `fleet.config.ts` names every site and how it's built. The tool never writes to it. Resource names derive from each site's key, a marker in each site's own database ties the site to its fleet and key, and the tool reads everything else from the platform and the sites.
- **Two layouts.** Sites that share one codebase (`shared`) are migrated and deployed by the tool in waves. Sites with their own repository (`repo`) get an update pull request: the tool runs `upgrade-emdash` in a checkout and opens the pull request, and the site's own pipeline deploys the merge. The tool can create both.
- **A provider contract in EmDash's terms.** A provider supplies a database, media storage, a session store, scheduled work, secrets, a domain and a deployment. The Cloudflare provider ships with this RFC, a Docker host is sketched against the same contract, and a conformance test suite decides what counts as a provider.
- **Setup runs from the CLI.** `provision --admin <email>` applies the seed, creates the first Admin and completes setup through the site's database before the site is reachable, then prints a one-time sign-in link. A new site has no window in which a visitor can claim it.

This is the "multisite" answer for EmDash: many isolated sites run from one place, not many sites inside one runtime. One Worker serving many databases is a non-goal, for the reasons under [Alternatives](#alternatives).

## Problem and user case

[Discussion #139](https://github.com/emdash-cms/emdash/discussions/139) asks for multi-tenancy, so that a developer "managing dozens of client sites" doesn't carry the overhead of a separate deployment per site. It has 14 upvotes. The replies describe what the people asking actually do and where it hurts:

- An agency moving dozens of client sites from WordPress Multisite says the part they use is operational: "one upgrade, one place to provision a new site in minutes, one dashboard to see them all". Every site keeps its own domain, content, users and schema.
- An operator who already runs separate sites, each with its own D1 database and R2 bucket, names what's left: "schema migrations across N sites. I don't have an elegant answer to that yet."
- A French agency sees "multisite on an open-source CMS" as a hard requirement in local-government tenders: one tender asks for 14 mini-sites and a generator that creates new ones from a template, another for up to 28 municipality sites.
- An operator building managed hosting on Cloudflare for Platforms wants a database per site and a separate admin plane for managing the sites.

Every automated deployment also has a setup window. Until someone finishes setup, the first visitor who opens the setup wizard becomes the site's Admin. [Discussion #2929](https://github.com/emdash-cms/emdash/discussions/2929) describes a studio that deploys sites from a script and now writes the first admin straight into the database to close it. For sites this tool creates, the window never opens; the general case of #2929 stays open for its own proposal.

Today each operator builds this by hand: one deployment per site, a CI matrix, `emdash migrate` per database, a Cron Trigger per Worker, and a script that remembers which site has which database. This RFC is that script, written once.

The narrower asks stay open: [Discussion #3636](https://github.com/emdash-cms/emdash/discussions/3636) asks the Durable Object backend to accept an already-addressed database stub, and [Discussion #3079](https://github.com/emdash-cms/emdash/discussions/3079) asks for a Kysely plugin pass-through for row-level scoping. Neither is needed for the design below, and neither is ruled out by it.

## Example

An agency keeps its client sites in one repository. One Astro project builds most of them, and `fleet.config.ts` lists them:

```ts title="fleet.config.ts"
import { cloudflare } from "@emdash-cms/cloudflare/fleet";
import { defineFleet, github } from "@emdash-cms/fleet";

export default defineFleet({
	name: "example-agency",
	provider: cloudflare({
		accountId: "0123456789abcdef0123456789abcdef",
		d1Location: "weur",
	}),
	repositoryHosts: [github()],
	defaults: { layout: "shared", project: "./site", groups: ["clients"] },
	sites: {
		bakery: {
			url: "https://bakery.example.com",
			tokenEnv: "EMDASH_TOKEN_BAKERY",
		},
		harbour: {
			layout: "repo",
			url: "https://harbour.example.com",
			repository: "https://github.com/example-agency/harbour-site",
			tokenEnv: "EMDASH_TOKEN_HARBOUR",
		},
	},
});
```

`bakery` doesn't exist yet. The Cloudflare token is in a `.env` file beside the config, which Git ignores. The operator builds the shared project with its own build script and creates the site from that build:

```bash
(cd site && npm run build)
npx emdash-fleet provision bakery --admin owner@bakery.example.com --title "Corner Bakery"
```

```txt
bakery  limits        ok (Workers 41/500, Cron Triggers 41/250, custom domains on example.com 41/100)
bakery  database      created emdash-bakery (weur)
bakery  media         created emdash-bakery-media
bakery  sessions      created emdash-bakery-session
bakery  config        wrote .emdash/fleet/bakery/wrangler.json
bakery  migrate       applied 96 migrations
bakery  setup         marked for example-agency, seeded the template, title "Corner Bakery", Admin owner@bakery.example.com, setup complete
bakery  deploy        deployed emdash-bakery with EMDASH_ENCRYPTION_KEY, deployment 3f2a9c1e (no public URL yet)
bakery  schedule      Cron Trigger "* * * * *" set
bakery  domain        attached bakery.example.com
bakery  health        https://bakery.example.com reports emdash 1.5.0, deployment 3f2a9c1e
bakery  sign-in-link  open it within 1 hour to sign in and add a passkey:
                      https://bakery.example.com/_emdash/api/auth/magic-link/verify?token=...
```

The tool keeps no file of its own. The next command finds `emdash-bakery` and its resources by name, and the marker that **setup** wrote into the site's database ties them to this fleet. The owner opens the link, signs in and registers a passkey. Nobody else could become Admin at any point, because setup was complete before the site had a public URL.

When EmDash 1.6.0 is out, the operator updates the shared project, builds it once with its own build script and deploys it to every shared site, two at a time:

```bash
(cd site && npm run build)
npx emdash-fleet deploy --group clients --wave-size 2
```

```txt
wave 1  bakery   migrate 2 pending -> applied   deploy ok   health 1.6.0
wave 1  corner   migrate 2 pending -> applied   deploy ok   health 1.6.0
wave 2  lantern  migrate 2 pending -> FAILED (migration lock held)
wave 2  mill     migrate 2 pending -> applied   deploy ok   health 1.6.0
stopped after wave 2: 1 failed (lantern, still on 1.5.0), 2 skipped (orchard, not reached; harbour, repo layout)
```

`lantern` keeps its old Worker. `mill` was already running in the same wave, so it finishes, and `orchard` in the next wave isn't touched. `harbour` has its own repository, so `deploy` skips it. `npx emdash-fleet update --site harbour` opens the update pull request in its repository instead, and its own pipeline deploys the merge.

## Goals

- An operator can create a complete, working site with one command, including the Cron Trigger that scheduled publishing needs on Cloudflare, either from the shared codebase or as a new repository, ready for its own deploy pipeline.
- A site the tool creates has completed setup, with its Admin, before it has a public URL, so no visitor can claim it.
- An operator can update all sites that share one codebase in waves, migrating each database before its new code runs, and the update stops at the first site that fails.
- An operator can open update pull requests for sites that have their own repository, in the same waves, without an update workflow or a secret in each site.
- An operator can see every site's running version, deployment, newest available version and reachability in one table or as JSON.
- A provisioning run that stops halfway can be finished or cleaned up by running the tool again, without a state file.
- The provider contract can be implemented outside Cloudflare, and the RFC shows how for one other platform.
- The operations are a library under a thin CLI, so a later web console can use them unchanged, running `provision`, `deploy` and `update` where builds and installs can run, such as a CI job.
- Nothing changes for a single site that doesn't use the tool, and the logged-out path stays as it is.

## Non-goals

- One runtime that serves many sites, whether through one Worker with many databases, a request-resolved database name, or a tenant column. See [Alternatives](#alternatives).
- Building the web console, a registry service or a dashboard. The design keeps them possible; a later proposal builds them.
- Shipping a provider other than Cloudflare. The Docker host sketch shows the contract holds; building it is a later proposal.
- Repository hosts for Git hosts other than GitHub, GitLab, Gitea and Forgejo. The plain Git [repository host](#repository-host) covers any other Git server, without creating repositories or opening pull requests, and the host interface is public for packages that add one.
- A **Start update** button in a site's admin. The review of [#4577](https://github.com/emdash-cms/emdash/pull/4577) points to a hook into the update banner that a plugin fills; a fleet plugin on such a hook is a later proposal.
- A setup secret for sites deployed without this tool, such as through a deploy button. #2929 stays open for that.
- One sign-in across sites. The guide page for running many sites describes Cloudflare Access for that, and its seat limit, without tooling.
- Fleet commands over MCP. An agent that acts across sites is a separate security decision.
- Sharing content between sites, a network role above Admin, or a site switcher in the admin.

## Detailed design

### Terms

- **Fleet:** the sites listed in one `fleet.config.ts`, under the fleet's `name`.
- **Site key:** a site's name in the list. It never changes, even when the URL does, and it never names another site. Resource names derive from it.
- **Layout:** how a site is built and deployed. `shared`: one project builds many sites, and the tool migrates and deploys them. `repo`: the site has its own repository and pipeline, and the tool opens update pull requests.
- **Provisioned or adopted:** a site the tool created, or an existing site the operator added. Both layouts can be either. The site's [marker](#the-fleet-marker) records which.
- **Provider:** the code that creates and deploys a site on one platform. This RFC ships the Cloudflare provider.
- **Wave:** a group of sites that one command changes at the same time.

### The package

`@emdash-cms/fleet` is a new package in the monorepo, with the `emdash-fleet` command, like `@emdash-cms/plugin-cli` ships `emdash-plugin`. It exports every command as a function that returns the [command result](#command-results), and the CLI only parses arguments and prints those results. A web console can call the same functions later. `list` needs only the config, and `status` only the network, except for its pending-migrations column, which reads the build as `deploy` does. `provision` and `deploy` need the project's build and its Wrangler, and `update` needs Git, each repository's package manager and the npm registry, so a console would run those three in CI or a container, not in its own Worker.

The package uses core and the Cloudflare package from the same release instead of copying them: core's CLI credential store, `emdash migrate`, and the setup function described under [Setup from the CLI](#setup-from-the-cli). Core exports the credential store and the setup function from an internal entry point for this. Each provider lives with its platform's package; the Cloudflare provider is `@emdash-cms/cloudflare/fleet`.

### The site list

`fleet.config.ts` sits in the operator's repository. The commands find it in the working directory or take `--config <path>`. Its default export comes from `defineFleet()`, which types every field. The file is a TypeScript module, so it can compute sites, import a list from elsewhere or read environment variables. It's loaded with Node.js's type stripping, so the tool needs Node.js 22.18 or later, as the Cloudflare CLI does for `cloudflare.config.ts`. The full shape is under [Configuration](#configuration).

The tool never writes to the file. It holds what the operator decides: each site's key, URL, layout, groups, the name of its token variable and, for a `repo` site, its repository. It holds no secret and no resource ID.

Every command that changes something takes an explicit selection: `--site <key>` (repeatable), `--group <name>` (repeatable) or `--all`. Without one it stops.

A config has one provider, so one fleet lives in one Cloudflare account. An operator with several accounts keeps one config per account, each with its own `name`, and picks one with `--config`.

### State on the platform

The tool keeps no state file. Each provisioned resource has a name derived from the site key (for Cloudflare: Worker `emdash-<key>`, database `emdash-<key>`, bucket `emdash-<key>-media`, KV namespace `emdash-<key>-session`, and `emdash-<key>-<binding>` for any other storage the project binds), and every command looks resources up by that name. An adopted site whose resources have other names lists them under `resources` in its entry; that's a decision the operator writes, not state the tool records. `namePrefix` replaces `emdash` when two fleets share one account.

Everything a command needs to know is read from the platform or from the site:

| Question                                                          | Answered by                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Does the database, bucket, session store exist?                   | The provider's lookup by name                                          |
| Which database does the running site use?                         | The deployed Worker's own binding, from the provider                   |
| Is the encryption key set?                                        | The provider's list of secret names (secret values can't be read back) |
| Is the domain attached, the Cron Trigger set?                     | The provider                                                           |
| Does the site have an Admin, and has setup ended?                 | The site's database, read through the provider                         |
| Which version and deployment is running?                          | `/_emdash/api/health`                                                  |
| Which fleet and key a site belongs to, and whether it was removed | The [marker](#the-fleet-marker) in the site's database                 |

This is how Cloudflare's own tools work. Wrangler's automatic provisioning keeps resources linked across deploys without IDs in the config, and the Cloudflare CLI's `cf deploy` provisions missing resources but "does not write provisioned identifiers back to `cloudflare.config.ts`". It also means two runs can't overwrite each other's records, because there's no file to write: creating a resource by name is idempotent, and a second run that tries to create the same database gets "already exists" and uses it. Migrations are serialized by EmDash's migration lock, as they are today.

Each provider must be able to look resources up by the names this section derives. A platform that can't would need a state file, and a provider for it would add one; the Cloudflare provider and the Docker host sketch don't.

### The fleet marker

A name alone can't say whose a database is: a database called `emdash-bakery` could belong to another fleet in the same account, or to a site someone created by hand. So the **setup** step first writes one option into the site's own database, `emdash:fleet`, holding the fleet's `name`, the site key and `origin: "provisioned"`. `remove` adds `removedAt`, and writes a marker with `origin: "adopted"` into an adopted site that has none. Core doesn't read the option. It's the only record the tool writes, and it sits with the site's data, so it can't drift from the site.

- **A key names one site for good.** When `provision` finds an existing database under the derived name, it stops before changing anything if the marker names another fleet or key, or if setup is complete and there's no marker. A removed site keeps its resources and its key, so a new site always gets a new key.
- **Provisioned or adopted** comes from the marker: a site whose marker says `provisioned` is one the tool created, and every other site counts as adopted. `reconcile` completes provisioning only for provisioned sites, and `adopt` stops at a database that carries another fleet's marker.
- **Removed sites stay removed.** `deploy` and `reconcile` skip a site whose marker has `removedAt`, so neither can set its Cron Trigger or attach its domain again by accident. Only `reconcile --site <key> --restore` clears it.

### Credentials

Every credential is an environment variable. The tool reads each one from the process environment, or from `.env` and then `.env.local` beside `fleet.config.ts`, which is how Wrangler and the Cloudflare CLI read `CLOUDFLARE_API_TOKEN`. A variable that's set in the environment wins over a file, so a secret a CI job injects always takes precedence. `--env-file <path>` names other files instead. The tool parses the files as dotenv text and never runs them, says on stderr which files it loaded, and stops when one of them is tracked by Git. It never writes a credential anywhere, and it hands credentials to Wrangler and `emdash migrate` through their environment.

- **EmDash tokens:** per site, from core's CLI credential store, which `emdash login` fills and keys by the site's origin. The variable named in the site's `tokenEnv` overrides the store, so CI can hold one token per site. `EMDASH_TOKEN` alone isn't enough for a fleet and isn't used by fleet commands.
- **Cloudflare token:** `CLOUDFLARE_API_TOKEN`, the variable Wrangler and `emdash migrate` already read. The tool never logs it.
- **Repository host token:** from the variable the host names, `GITHUB_TOKEN` for GitHub, for provisioning and updating `repo` sites. The same rules apply. Git gets it through a credential helper, never in a URL, so it isn't written into a checkout's config.
- **Generated site secrets:** `provision` generates `EMDASH_ENCRYPTION_KEY` per site and uploads it with the site's first deploy. On Cloudflare it reaches disk only as the file Wrangler's `--secrets-file` reads, created readable by the owner only and deleted after the deploy.

The permissions each token needs are listed under [Limits and permissions](#limits-and-permissions). `list`, `status` and `update` don't need a Cloudflare token, and neither does `adopt` for a `repo` site.

### Commands

All commands accept `--json`, which prints one result object per site and a summary. Exit code 0 means every selected site reached the target state, 1 means at least one site failed, 2 means the command stopped before changing anything (bad config, missing selection, a limit reached), and 3 means no site failed but at least one waits for a person, such as an Admin whose sign-in link wasn't printed, an import that waits for `emdash login`, or an update pull request that waits for review.

#### `list`

Prints the sites from the config with key, URL, layout and groups. It makes no network call.

#### `adopt <key>`

Checks an entry the operator added for an existing site. The tool reads `/_emdash/api/health` and stops unless the URL answers as EmDash. For a `shared` site, it then finds the resources under the derived names or the names in `resources`, and checks that the database it found is the one the running Worker is bound to and carries no other fleet's marker. For a `repo` site, it checks that the repository exists. It prints what it found and changes nothing.

#### `status`

For each selected site, or every site when nothing is selected:

- The running version and deployment from `/_emdash/api/health`, which needs no token.
- The newest available version from `GET /_emdash/api/admin/core-update`, when the site has a token. That route needs a token with the `admin` scope.
- For a `repo` site, an open update pull request with its state and checks, when the repository host's token is set.
- Reachable or not, and the HTTP status.
- Pending migrations for `shared` sites, and whether a site was removed, only when `CLOUDFLARE_API_TOKEN` is set, read with `emdash migrate --status` as `deploy` does and from the marker. Without that token, those columns are left out, and a removed site shows as unreachable.

`status` changes nothing.

#### `deploy` (shared layout)

Deploys the shared project's existing build to the selected `shared` sites in waves. `repo` sites in the selection are skipped and reported. The tool doesn't build: the operator runs the project's own build script first, because only the project knows its package manager and build steps. The build's EmDash version comes from the migration manifest that `emdash migrate` reads from the build.

For each site, the documented "build, migrate, deploy, check" steps run against the site's own target:

1. The provider writes the site's deployment config from the build's config and the resources it looks up by name (step **config** under [Provision steps](#provision-steps)), with the site's custom domain, so the deploy keeps it. The generated config isn't committed.
2. The tool skips a site whose marker says it was removed. It checks that the database found by name is the one the running Worker is bound to. When they differ, this site stops; `--accept-database <id>` lets one run continue after the operator has checked the new database.
3. `emdash migrate --status`, then `emdash migrate` with `--expected-target-fingerprint` when migrations are pending, against that database.
4. The provider deploys, which returns the new deployment's ID.
5. `emdash migrate --check`, then `/_emdash/api/health` until it reports the build's version and the new deployment ID, for at most `--timeout` (default 2 minutes).

`--dry-run` prints the steps and the pending migrations without changing anything.

#### `update` (repo layout)

Opens an update pull request in each selected `repo` site's repository, then waits until `/_emdash/api/health` reports the new version, for at most `--timeout` (default 60 minutes). `shared` sites in the selection are skipped and reported. The site's own pipeline builds, migrates and deploys the merged pull request, as it does for any other change. The site needs no trigger and no secret for this, and its repository needs no update workflow.

Each site has one update branch, `emdash-update`, and at most one open update pull request. For each site:

1. The tool reads `/_emdash/api/health`. A site that doesn't answer fails here, before anything is cloned.
2. It finds the repository through the [repository host](#repository-host) and clones it into a temporary directory, at the entry's `ref` or the default branch. A repository without a lockfile fails the site: without one, every install picks the newest release in range by itself, and a pull request has nothing to pin.
3. It installs the dependencies from the lockfile with the repository's package manager, because `upgrade-emdash` reads the installed packages. This is where the repository's install scripts and dependencies first run, without the tool's tokens in their environment.
4. It reads the plan with `upgrade-emdash --dry-run --json`, with `--cwd` set to the entry's `project` when the Astro project isn't at the repository's root. The run's version is the `emdash` version the plan installs. A plan that changes nothing means the repository is already on the release, and the site skips to step 8.
5. It runs `upgrade-emdash --yes`, which updates the EmDash packages, installs them, refreshes the project's EmDash agent skills and writes the work order to `.emdash/UPGRADE.md`. The tool turns off the package manager's frozen-lockfile default for CI in that process, because the lockfile is what the update changes. Afterwards it checks that the installed `emdash` version is the one from the plan, and fails the site when it isn't.
6. It commits the result to `emdash-update` with the tool's `Emdash-Fleet: <key>` trailer and pushes it. Git runs with the repository's hooks turned off and with the author from `commitAuthor`.
7. It opens the pull request through the repository host, or updates the open one. The title names the version. The body lists the package changes, links the work order, and says which of the changed files are generated: the refreshed skills and the work order itself, which make up most of the diff.
8. It waits for the health route. Meanwhile it reads the pull request's state and checks through the repository host, so the output says whether a site waits for review, has failing checks, or is merged and not deployed yet.

What counts as done, and what a later run does:

- **Done** means the running site reports the run's version, as for `deploy`. When the plan changes other EmDash packages but not `emdash` itself, health can't show the result. The site then counts as done once its pull request is merged, and the output says so.
- **One version per run.** `upgrade-emdash` installs an npm dist-tag (`latest`, or the one named with `--to <tag>`), not an exact version. The tool takes the version from the first site's plan and fails every later site whose plan or install resolves another one, so a release published in the middle of a run can't mix versions. `--release <x.y.z>` refuses every site whose plan names another version.
- **The branch holds only the tool's commits:** the tool replaces them with the new result and updates the pull request, so a newer release takes over the open pull request instead of opening a second one. An unchanged result pushes nothing.
- **The branch holds someone else's commits,** as it does when a person finishes the work order there: the tool pushes nothing and goes to the wait. When that pull request is for an older version than the run's, the output says so.
- **The pull request was closed without merging:** the tool doesn't open it again for the same version. The site is skipped with that reason until a newer release, or until `--reopen`.
- **At the timeout,** failing checks, or a merged pull request that never deployed, count as failed. A pull request that's still open otherwise leaves its site `waiting`. Either way no further wave starts, and a run with waiting sites and no failed one exits with code 3.
- **Other update tooling.** A site can keep its own, such as Renovate. `status` works either way, and the tool never touches another tool's branches.
- **A host without pull requests.** With the plain Git host, the tool pushes the branch and prints where to open the pull request. The wait then reads only the health route.

#### Waves

`--wave-size <k>` (default 1) sets how many sites run at the same time. Waves run one after another in the order of the config, or the order given by `--order <file>`. When any site in a wave fails or is left waiting, the sites already running finish and no further wave starts. Sites that weren't reached stay on their old version and are listed as skipped. A site counts as done only when its health route reports the target version and, after a `deploy`, the new deployment ID, because only the running site proves that the change arrived.

#### `provision <key>`

Creates a new site from its entry. `--admin <email>` is required for the first run. A `shared` site is created from the shared project's existing build, as `deploy` uses it, so the operator builds first. Each step first looks for its result on the platform or in the site's database and skips what exists, so a run that stopped can be started again. The steps for both layouts are listed under [Provision steps](#provision-steps). In short:

- **Shared layout:** limits check, database, media storage, session store, a per-site copy of any other storage the project binds, a generated deployment config, core migrations, setup with the marker, the template's seed, the title and the first Admin, a first deploy with the encryption key and without a public URL, the Cron Trigger, the custom domain, a health check and a one-time sign-in link. Optionally, a site package import.
- **Repo layout:** the same resources, plus a new repository on the site's Git host, filled from a template, with the deployment config committed to it. The tool builds a checkout of it with the package manager and `build` script the template declares, and makes the first deploy from there. Then it hands deploys to the repository's pipeline and prints which token the operator must create for it.

The Worker has no public URL until setup is complete: the generated config sets `workers_dev` and `preview_urls` to `false`, and the custom domain is attached only after the **setup** step.

`--dry-run` creates nothing, runs no migration and writes no database row. It prints every provider call with secret values redacted, and the config it would write with a placeholder database ID, because the real IDs only exist after the steps that create them.

#### `reconcile`

Compares each selected entry with the platform. It completes provisioning steps that are missing for a provisioned site, reports a site whose Cron Trigger or custom domain is missing, and, through the provider's list of site keys under the fleet's name prefix, reports resources that no entry names, marking those whose marker says they were removed. It never creates resources for an adopted site, and skips a removed one.

`reconcile --site <key> --restore` brings a removed site back. It needs the site's entry in the config, clears `removedAt` in the marker, and sets the Cron Trigger and attaches the custom domain again.

`reconcile --abandon <key>` deletes the resources of a provisioning nobody has used yet, after a confirmation. It reads the site's database first, applies the ownership check of `provision`, and refuses once the Admin has signed in (the users table records the last sign-in) or registered a passkey, or the site has any other user. It never deletes a repository.

#### `remove <key>`

Takes a site out of service without deleting its data. Before it changes anything, it checks that it holds a token with the `transfer:export` scope for the site, so a missing token can't leave a site detached without an export. Then:

1. Exports the site with `emdash site export` into `--out <dir>`.
2. Writes `removedAt` into the site's marker, so `deploy` and `reconcile` skip it from then on.
3. Removes the custom domain, so the site stops serving.
4. Removes the Cron Trigger, so it stops counting against the account limit.
5. Tells the operator to delete the entry from the config. Until then, `update`, and `status` without a Cloudflare token, find the site unreachable.

The database, the bucket, the Worker script and, for a `repo` site, the repository stay. Deleting them is left to the operator. For a `repo` site, the repository's pipeline would deploy the site again with its Cron Trigger on its next run, so `remove` tells the operator to disable that pipeline.

### Setup from the CLI

EmDash's setup has two steps. The site step (`POST /_emdash/api/setup`) applies the seed, stores the site URL, title and tagline, and puts the site in staging, so search engines are asked not to index it until an Admin selects **Go live**. The admin step creates the first Admin with `createFirstAdmin()`, which inserts a row only while the users table is empty, and marks setup complete. Until setup is complete, the first sign-in through OAuth or AT Protocol makes its user Admin, and so does the first user through external authentication while the users table is empty. Setup therefore has to be complete before anyone can reach the site.

`provision` runs both steps through the provider's connections, after **migrate** and before the first deploy:

1. It writes the [fleet marker](#the-fleet-marker).
2. It activates media usage tracking for the fresh database, as the runtime does before it seeds a fresh site, and applies the project's seed through the provider's database connection. The seed is resolved as the build resolves it: `.emdash/seed.json`, then `emdash.seed` in `package.json`, then `seed/seed.json`, then the built-in default seed. The seed's media go through the provider's storage connection.
3. It stores the site's final URL as `emdash:site_url`, the `--title` and `--tagline`, and the staging flag, as the site step does.
4. It creates the first Admin with the `--admin` email and completes setup.

Core moves this work into one exported function, which the setup routes then call too, so the CLI and the wizard can't drift apart. The seed resolution moves out of the Vite plugin into its own function, which the plugin and the CLI both call. The CLI calls it on the same project or checkout after its build, so it finds the seed the build embedded. A fleet site starts in staging, like one set up through the wizard, and goes live when its Admin selects **Go live**.

After **health**, `provision` creates a one-time sign-in link for the Admin with `createMagicLinkUrl()` from `@emdash-cms/auth`, the function the sign-in handover already uses. The link opens Security settings ready to add a passkey. It's valid for 1 hour by default (`--link-ttl`, up to 24 hours) and works once. `provision` prints it only on an interactive terminal unless `--print-sign-in-link` is passed. Running `provision` again on a site whose Admin hasn't registered a passkey yet issues a new link; after that, the step is done and prints nothing.

On a site with external authentication, such as Cloudflare Access, there's no sign-in link. The Admin signs in through the identity provider with the `--admin` email, and EmDash finds the user by that email. With `syncRoles` on, the identity provider's role replaces Admin at that sign-in, so the provider has to grant it.

Because setup is complete before the first request, the runtime's own first-request seed doesn't run (step 2 already did its media usage activation), the setup wizard answers `ALREADY_CONFIGURED`, and no OAuth, AT Protocol or external-authentication sign-in becomes Admin.

### Deployment ID in health

`/_emdash/api/health` reports the EmDash version only, so a deploy that keeps the version (an operator's own code change) can't be confirmed from the running site. Health gains a `deploymentId` field. On Cloudflare it comes from the Worker's version metadata binding, which the generated config adds as `CF_VERSION_METADATA` and whose `id` is the version ID a deploy returns. Elsewhere it comes from the `EMDASH_DEPLOYMENT_ID` environment variable when set, and is left out otherwise. Reading it costs no query.

### Provider contract

The contract describes what an EmDash site needs, not what one platform offers. Where a platform covers a need another way, the operation says so instead of creating something: a Node.js site runs scheduled work in its own process, so it has no schedule to create. The full interface is under [Interfaces](#interfaces).

| EmDash needs   | The provider                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Limits         | Says whether one more site fits, and which limit stops it                                                                     |
| Database       | Finds or creates the site's database, and opens a connection the tool can query                                               |
| Media storage  | Finds or creates the site's storage, and opens it for writing the seed's media                                                |
| Session store  | Finds or creates the store Astro sessions use, or says none is needed                                                         |
| Other storage  | Gives every other storage resource the build binds a per-site copy, unless the operator shares it                             |
| Scheduled work | Sets up what calls the site's scheduled tasks, or says the site runs them itself                                              |
| Secrets        | Lists which secrets a site has; new ones go out with a deploy                                                                 |
| Deployment     | Writes the site's deployment config, deploys a build with any new secrets and returns the deployment ID                       |
| Migrations     | Names the target `emdash migrate` runs against                                                                                |
| Domain         | Attaches and detaches the site's hostname, with its certificate                                                               |
| Inspection     | Reports what exists for a site, by name, and which site keys exist under a prefix                                             |
| Credentials    | Names the environment variables that hold its credentials, so the tool redacts them and keeps them out of installs and builds |

A conformance test suite, shipped with `@emdash-cms/fleet`, runs every command against a provider: provisioning from nothing, provisioning again after a failure at each step, a wave with a failing site, `reconcile` and `remove`. A provider is supported when it passes. The same suite runs against the local test provider and against the Cloudflare provider at the HTTP boundary.

#### The Cloudflare provider

`@emdash-cms/cloudflare/fleet` maps the contract to D1, R2, a KV namespace for sessions, Worker secrets, a Cron Trigger and a Workers custom domain, through the Cloudflare API. It finds each site's zone from the hostname among the account's zones, so the config names no zone. It deploys by running the project's Wrangler with the generated config, and uploads new secrets with that deploy through `--secrets-file`; secrets the file doesn't name stay as they are. Its credential is `CLOUDFLARE_API_TOKEN`. Its database connection is a Kysely connection over the D1 HTTP API, which the Cloudflare package already has for migrations. That connection has no transactions, and setup needed none in the test run. Its storage connection writes through the R2 API's upload-object endpoint. When a project moves to `cloudflare.config.ts` and the Cloudflare CLI, the provider generates that file instead and deploys with `cf deploy`; neither generated file is committed for a `shared` site.

The config imports the provider from the same `@emdash-cms/cloudflare` version the shared project depends on, and `deploy` stops when the two differ, so the provider always matches the project's EmDash version.

#### A Docker host, sketched

To show that the contract isn't Cloudflare's shape under another name, here is how a provider for one Linux server running Docker would answer each row. It follows EmDash's Node.js deployment guide, and nobody builds it as part of this RFC.

| EmDash needs   | Docker host                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Limits         | Disk and memory on the host, read over SSH                                                                             |
| Database       | A PostgreSQL database `emdash_<key>` on the host's server, or a SQLite file on a volume `emdash-<key>-data`            |
| Media storage  | An S3 bucket `emdash-<key>-media`, or a directory on the same volume                                                   |
| Session store  | None: the Node.js adapter's own session driver                                                                         |
| Other storage  | Each named volume the project's compose file declares, one per site                                                    |
| Scheduled work | None: EmDash's built-in scheduler runs in the site's process                                                           |
| Secrets        | An environment file per site, written by the deploy and readable only by the container                                 |
| Deployment     | One image built from the shared project, one container `emdash-<key>` per site, started with `docker compose` over SSH |
| Migrations     | `emdash migrate` with the site's database settings, before the new container starts                                    |
| Domain         | A Caddy site block per hostname, which also gets the certificate                                                       |
| Inspection     | `docker` and the database server's catalog, by name                                                                    |
| Credentials    | The variables that hold the SSH key and the database password                                                          |

Its database connection is PostgreSQL over an SSH tunnel; for SQLite, it's a Kysely connection that sends each statement over SSH to the file on the volume, as the Cloudflare provider sends them over the D1 HTTP API. Its storage connection writes to the bucket or, over SSH, to the volume. The deployment ID is the image digest, set as `EMDASH_DEPLOYMENT_ID`. The hard part is deployment: Node.js has no common deployment API, so this sketch picks Docker over SSH, and a PaaS would answer that row with its own API.

#### Workers for Platforms

A Workers for Platforms provider is a planned path, not part of this RFC. A dispatch namespace removes the per-account Worker limit, but a user Worker in it can't have its own Cron Trigger: Cloudflare confirmed this in [cloudflare/workers-sdk#13840](https://github.com/cloudflare/workers-sdk/issues/13840), and since Wrangler 4.159.0 a deploy with `--dispatch-namespace` warns that it ignores cron triggers. Row by row:

| EmDash needs                                          | Workers for Platforms                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Limits                                                | No per-account Worker limit inside a dispatch namespace                                        |
| Database, media storage, session store, other storage | The same D1, R2 and KV resources, bound to each user Worker                                    |
| Scheduled work                                        | No Cron Trigger on a user Worker; one of the two options below                                 |
| Secrets                                               | The namespace's secrets API, or secrets uploaded with the user Worker                          |
| Deployment                                            | An upload of the user Worker into the namespace (`wrangler deploy --dispatch-namespace`)       |
| Migrations                                            | As on Workers, against the site's D1 database                                                  |
| Domain                                                | A Cloudflare for SaaS custom hostname, routed to the site's user Worker by the dispatch Worker |
| Inspection                                            | The user Workers in the namespace, by name                                                     |
| Credentials                                           | `CLOUDFLARE_API_TOKEN`, as for the Cloudflare provider                                         |

The provider would answer the scheduled-work row in one of two ways:

- The dispatch Worker's own Cron Trigger calls each site's scheduled handler through the dispatch binding. `Fetcher.scheduled()` exists in the experimental Workers types; whether it works through a dispatch namespace in production is untested.
- Each site keeps its database in a Durable Object, whose alarms run its scheduled work. EmDash already has a Durable Object SQL backend, and [#4790](https://github.com/emdash-cms/emdash/pull/4790) proposes a Durable Object site mode.

The docs also say that `caches.default` is disabled for namespaced scripts and that user Workers can't use gradual deployments, and they don't say whether the Workers Cache works for a user Worker. Both scheduled-work options need a test on a real account before a provider is proposed.

#### Repository host

`repo` sites need four things from a Git host: finding a repository, creating an empty one, opening or updating a pull request, and reading a pull request's state and checks. Everything else is plain Git, which is the same on every host: cloning, committing and pushing. A template is downloaded with giget, as `create-emdash` does.

Each Git host, such as GitHub or GitLab, gets a small adapter of its own, a repository host, that calls the Git host's API directly, behind one interface. Renovate's platforms, Backstage's integrations and Flux's bootstrap providers connect to Git hosts the same way, and it keeps one mechanism and one token per host.

- **Connecting a Git host takes one line and one token.** The config lists the repository hosts in `repositoryHosts`, such as `github()`, or `gitlab({ baseUrl: "https://git.example.com" })` for a self-hosted instance. A site's `repository` is its URL, and the repository host whose origin matches handles it, so one fleet can hold sites on several Git hosts. Each one reads its token from its own variable, such as `GITHUB_TOKEN` or `GITLAB_TOKEN`, like every other credential.
- **`provision` creates the repository** on every Git host the fleet has a repository host for, so nobody creates repositories by hand. GitHub ships with slice 6. GitLab, and Gitea and Forgejo, follow in slice 7, each once the repository-host part of the conformance suite has run against a real instance, self-hosted ones included.
- **Any other Git server** works through the plain Git host, `git()`, which ships with `update` in slice 5. It has no API to call, so the operator creates the repository, and `update` pushes the branch and prints where to open the pull request. Until slice 7, sites on GitLab, Gitea and Forgejo use it too.
- **Others can add a host.** The interface is exported, so a package can provide one for Bitbucket or Azure DevOps.

The [forges](https://forges.link/) library, a TypeScript client with one interface for twelve Git hosts, could later replace the per-host code. In version 0.3.2 it opens and reads pull requests on GitHub, GitLab, Gitea and Forgejo, but it can't create repositories, so a repository host built on it today would still need each Git host's own API for that. Once the library can create repositories, one repository host on top of it covers every Git host it supports.

Tests replace the provider and the repository host with local implementations that create SQLite files, run `wrangler dev` and write to a local Git repository.

### Configuration

```ts
interface FleetConfig {
	/** Stored in each site's marker; never changes. */
	name: string;
	provider: FleetProvider;
	/** The Git hosts of `repo` sites. A site's repository URL picks its host. */
	repositoryHosts?: RepositoryHost[];
	/** Author of the tool's commits (default: Git's configured identity). */
	commitAuthor?: { name: string; email: string };
	/** Replaces `emdash` in derived resource names. */
	namePrefix?: string;
	defaults?: Partial<SiteEntry>;
	/** Keyed by site key: `^[a-z][a-z0-9-]{0,39}$`, never changes and never names another site. */
	sites: Record<string, SiteEntry>;
}

interface SiteEntry {
	url: string;
	/** From the entry or `defaults`; every site needs one. */
	layout?: "shared" | "repo";
	groups?: string[];
	/** Name of the environment variable that holds this site's EmDash API token. */
	tokenEnv?: string;
	/** Path of the Astro project: in the operator's repository for `shared`, inside the site's repository for `repo` (default: its root). */
	project?: string;
	/** `repo` layout: URL of the site's repository. */
	repository?: string;
	/** `repo` layout: the branch update pull requests target (default: the repository's default branch). */
	ref?: string;
	/** `repo` provisioning: the template giget downloads, such as `github:emdash-cms/templates/starter-cloudflare`, from `main` unless `#<ref>` names another ref. */
	template?: string;
	/** Storage bindings every site shares; every other binding gets a per-site resource. */
	sharedBindings?: string[];
	/** An adopted site whose resources don't have derived names. */
	resources?: {
		worker?: string;
		database?: string;
		mediaStorage?: string;
		sessionStore?: string;
		/** Binding name to resource name. */
		otherStorage?: Record<string, string>;
	};
}
```

`defaults` apply to every site that doesn't set the key itself. `defineFleet()` validates the config before every command and stops with the path of the first wrong value.

### Provision steps

Each step looks for its result first and skips what exists.

#### Shared layout

1. **limits:** asks the provider whether one more site fits. On Cloudflare it counts the account's Workers, its Cron Triggers, reading each Worker's schedules with one request per Worker, and the custom domains on the site's zone. The tool never creates a site Worker without a Cron Trigger, because it would never publish scheduled entries.
2. **database:** creates the D1 database with the configured location hint. When the database exists, it applies the ownership check under [The fleet marker](#the-fleet-marker).
3. **media:** creates the R2 bucket.
4. **sessions:** creates the KV namespace the build's `SESSION` binding uses for Astro sessions.
5. **storage:** creates a per-site copy of every other D1 database, R2 bucket and KV namespace the build's config binds, such as the KV namespace that `kvCache()` adds. Each is named `emdash-<key>-<binding>`, with the binding name in lower case and `_` as `-`. A binding listed in `sharedBindings` keeps the project's resource instead. Skipped when there are none.
6. **config:** writes `.emdash/fleet/<key>/wrangler.json` from the build's own config (`dist/server/wrangler.json`). It sets the Worker name, points every storage binding at the site's resource, adds `CF_VERSION_METADATA`, drops the project's `routes`, and keeps the project's other bindings as they are. It keeps the project's `triggers.crons`, or uses `* * * * *` when there is none, because a handler created with `createScheduledHandler({ generalCron })` ignores any other expression. It sets `workers_dev: false` and `preview_urls: false`. The custom domain isn't in the config yet. It writes no binding without an ID, because Wrangler's automatic provisioning would create a new, empty resource on deploy instead of failing.
7. **migrate:** applies the core migrations.
8. **setup:** writes the marker, applies the seed, stores the site URL and title, creates the first Admin and completes setup, as described under [Setup from the CLI](#setup-from-the-cli). Skipped when setup is complete. With `--import`, it leaves out the seed's sample content, because an import needs a site without content.
9. **deploy:** deploys the Worker with `EMDASH_ENCRYPTION_KEY`, which it generates when the Worker has no secret by that name. The key goes out with the deploy, so the site never runs without it and the deployment ID the deploy returns already includes it. A later run never generates it again, because the secret can't be read back and a new key would make the site's stored plugin secrets unreadable. The Worker has no public URL at this point.
10. **schedule:** the Cron Trigger. On Cloudflare it's in the deployment config, so the deploy sets it, and this step checks that it's there and sets it through the API when it isn't.
11. **domain:** attaches the custom domain through the provider. From then on, every deployment config the tool writes for the site carries the domain, so later deploys keep it.
12. **health:** waits until the URL reports EmDash, the build's version and the deployment ID from **deploy**.
13. **sign-in-link:** prints the link, on an interactive terminal or with `--print-sign-in-link`. Skipped once the Admin has a passkey, and on a site with external authentication.
14. **import** (with `--import <file.emdash>`): imports a site package through `emdash site import`. An import needs an Admin token, so the step reports `waiting` until the Admin has signed in and the operator has run `emdash login`. Running `provision <key> --import <file>` again then completes it.

#### Repo layout

1. **limits**, **database**, **media**, **sessions** and **storage** as above.
2. **repository:** finds the entry's `repository`, or creates it empty. With the plain Git host, it has to exist. Until the site's setup is complete, an existing repository is used only if it's empty or every commit in it carries the tool's `Emdash-Fleet: <key>` trailer, so a run that stopped can continue in it and any other repository stops the run. Once setup is complete, the repository has its own history and the check no longer applies.
3. **checkout:** for an empty repository, downloads the entry's `template` (or the one named with `--template`) with giget, as `create-emdash` downloads its templates, and starts a Git repository from it. Otherwise it clones the repository. `provision` stops when a `repo` entry names no template.
4. **files:** writes the deployment config into the checkout (the bindings, Cron Trigger, version metadata and public-URL settings of step **config** above, without the custom domain) and sets the package name to the site key. A `wrangler.jsonc` carries the resource IDs the tool looked up. A `cloudflare.config.ts` binds D1 and R2 by name, but its KV binding takes only an ID, so the tool writes the session namespace's ID there too. Either way, the site's own config and the fleet resolve the same resources from the same names.
5. **build:** installs the checkout's dependencies with the package manager its `package.json` names in `packageManager` (or, without that field, the one its lockfile belongs to) and runs its `build` script. The step fails when it finds neither. The install writes a lockfile when the template has none. Both commands run without the Cloudflare and repository host tokens in their environment. **migrate** and **deploy** then run the checkout's own `emdash` and Wrangler with the Cloudflare token, as the repository's pipeline will later, so the template and its dependencies are code the operator has to trust, like the shared project. This is the one place the tool builds: a fresh checkout has no build, and the template declares how to make one.
6. **push:** commits the template, the deployment config and the lockfile with the trailer and pushes. `update` later relies on that lockfile.
7. **migrate** and **setup:** as above, from the checkout's build and its seed.
8. **deploy:** the first deploy of that build, with the encryption key as above. It has no public URL at this point.
9. **schedule:** as above.
10. **domain:** attaches the custom domain, then commits it to the deployment config with the trailer and pushes, so the pipeline's deploys keep it unchanged.
11. **health** and **sign-in-link** as above.
12. **handover:** prints what the operator still has to do for later deploys:
    - connect a deploy pipeline to the repository, such as Workers Builds or a workflow, unless the template brings one. The tool doesn't create it, and until one exists a merged pull request doesn't deploy;
    - create that pipeline's Cloudflare token, as a repository secret, with Workers: Editor for this site's Worker, plus D1: Editor if the pipeline runs migrations. Cloudflare lets a token with only Editor deploy a Worker that has a custom domain "as long as the deployment does not add, update, or remove that connection", and the committed config keeps the domain as the tool attached it.

### Interfaces

#### Provider

```ts
interface FleetProvider {
	readonly name: string;
	/** Variables that hold the provider's credentials: redacted in output, kept out of installs and builds. */
	readonly credentialEnv: string[];
	checkLimits(site: SiteSpec): Promise<LimitReport>;
	ensureDatabase(site: SiteSpec): Promise<ResourceRef>;
	connectDatabase(site: SiteSpec): Promise<Kysely<Database>>;
	ensureMediaStorage(site: SiteSpec): Promise<ResourceRef>;
	/** Core's `Storage` interface, used to write the seed's media. */
	connectMediaStorage(site: SiteSpec): Promise<Storage>;
	/** `null`: the platform needs no separate session store. */
	ensureSessionStore(site: SiteSpec): Promise<ResourceRef | null>;
	/** Per-site copies of any other storage the build binds, except `sharedBindings`. */
	ensureOtherStorage(site: SiteSpec, build: BuildInfo): Promise<ResourceRef[]>;
	/** `null`: the site runs its scheduled work in its own process. */
	ensureSchedule(site: SiteSpec): Promise<ResourceRef | null>;
	removeSchedule(site: SiteSpec): Promise<void>;
	listSecretNames(site: SiteSpec): Promise<string[]>;
	/** Carries the custom domain once it's attached, so a deploy keeps it. */
	writeDeployConfig(site: SiteSpec, build: BuildInfo): Promise<{ path: string }>;
	migrationTarget(site: SiteSpec, configPath: string): Promise<string[]>;
	/** `secrets`: set with this deployment; secrets it doesn't name stay as they are. */
	deploy(
		site: SiteSpec,
		configPath: string,
		secrets?: Record<string, string>,
	): Promise<{ deploymentId: string }>;
	/** The database the running site is bound to, or `null` before the first deploy. */
	boundDatabase(site: SiteSpec): Promise<ResourceRef | null>;
	attachDomain(site: SiteSpec): Promise<void>;
	detachDomain(site: SiteSpec): Promise<void>;
	inspect(site: SiteSpec): Promise<ResourceReport>;
	/** Site keys that have resources under the prefix, for `reconcile`. */
	listSiteKeys(namePrefix: string): Promise<string[]>;
	deleteResources(site: SiteSpec, which: ResourceKind[]): Promise<void>;
}

/** A site entry with its key, its fleet's name and its resolved resource names. */
interface SiteSpec extends SiteEntry {
	key: string;
	fleet: string;
	names: Record<Exclude<ResourceKind, "otherStorage">, string>;
}

interface ResourceRef {
	kind: ResourceKind;
	/** For `otherStorage`: the binding it backs. */
	binding?: string;
	name: string;
	id: string;
	created: boolean;
}

interface LimitReport {
	ok: boolean;
	limits: { name: string; used: number; limit: number }[];
}

type ResourceKind =
	| "deployment"
	| "database"
	| "mediaStorage"
	| "sessionStore"
	| "otherStorage"
	| "schedule"
	| "domain";

interface ResourceReport {
	found: Partial<Record<ResourceKind, { name: string; id: string }>>;
	missing: ResourceKind[];
}
```

`migrationTarget` returns the arguments `emdash migrate` needs for the site, such as `--wrangler-config` and `--d1` on Cloudflare.

#### Repository host

```ts
interface RepositoryHost {
	readonly name: string;
	/** The Git host's origin, such as `https://github.com`. `null`: the plain Git host, for any URL no other host claims. */
	readonly origin: string | null;
	/** Variables that hold the host's token: redacted in output, kept out of installs and builds. */
	readonly credentialEnv: string[];
	/** `null`: no such repository. */
	findRepository(site: SiteSpec): Promise<RepositoryRef | null>;
	/** Creates the repository empty. Without it, the operator creates the repository. */
	createRepository?(site: SiteSpec): Promise<RepositoryRef>;
	/** Opens the pull request for `branch`, or updates the open one. Without it, the operator opens it. */
	ensurePullRequest?(
		site: SiteSpec,
		input: { branch: string; base: string; title: string; body: string },
	): Promise<PullRequestState>;
	/** The newest pull request for `branch`, or `null`. */
	pullRequest?(site: SiteSpec, branch: string): Promise<PullRequestState | null>;
}

interface RepositoryRef {
	repository: string;
	cloneUrl: string;
	defaultBranch: string;
	empty: boolean;
}

interface PullRequestState {
	url: string;
	title: string;
	state: "open" | "merged" | "closed";
	/** `unknown`: the token can't read them. */
	checks: "none" | "pending" | "passing" | "failing" | "unknown";
}
```

#### Command results

```ts
interface SiteResult {
	key: string;
	status: "done" | "failed" | "skipped" | "waiting";
	steps: { name: string; status: "done" | "failed" | "skipped" | "waiting"; detail?: string }[];
	version?: string;
	deploymentId?: string;
	error?: { code: string; message: string };
}

interface CommandResult {
	command: string;
	sites: SiteResult[];
	summary: { done: number; failed: number; skipped: number; waiting: number };
}
```

### Limits and permissions

Read in the Cloudflare docs on 2026-11-10 and 2026-11-11.

#### Account limits

| Resource                  | Workers Free                     | Workers Paid                       |
| ------------------------- | -------------------------------- | ---------------------------------- |
| Workers per account       | 100                              | 500                                |
| Cron Triggers per account | 5                                | 250                                |
| D1 databases per account  | 10                               | 1,000,000 (first 100,000 included) |
| R2 buckets per account    | unlimited, default limit 100,000 | unlimited, default limit 100,000   |
| KV namespaces per account | 1,000                            | default limit 1,000                |
| Custom domains per zone   | 100                              | 100                                |

Workers Cache purges always use the Free purge limits, whatever the plan: 5 requests per minute per account, with a bucket of 25. Every site on the account shares that budget when editors publish.

The Cloudflare API allows 1,200 requests per five minutes per user, counted across the dashboard, API keys and API tokens. The D1 queries that `emdash migrate` and the **setup** step send, and the seed's media uploads, count toward it. A user who goes over gets every API call refused for the next five minutes.

#### Cloudflare token permissions

| Use                                           | Permission                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Create Workers, set secrets and Cron Triggers | Workers: Admin at product scope (creating a Worker needs it)                                                                 |
| Deploy an existing site                       | Workers: Editor for that Worker, also with a custom domain, as long as the deploy doesn't change it                          |
| Create D1 databases                           | D1: Admin                                                                                                                    |
| Migrate a database, run setup                 | D1: Editor                                                                                                                   |
| Create R2 buckets, upload the seed's media    | R2: Admin Read & Write (the API's object upload has no narrower permission)                                                  |
| Create KV namespaces                          | Admin at a scope that includes KV                                                                                            |
| Attach or remove a custom domain              | Workers: Editor at product scope (custom domains have no per-Worker role) and Zone: Workers Routes: Write on the site's zone |

#### GitHub token permissions

Read in the GitHub docs on 2026-11-18. A fine-grained token needs:

| Use                                                          | Permission                                           |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Create the repository in the target owner (`provision`)      | Administration: write, or Repository creation: write |
| Download a private template (`provision`)                    | Contents: read on the template                       |
| Push the template, the deployment config and update branches | Contents: write on the repository                    |
| Push a template that contains workflow files (`provision`)   | Workflows: write on the repository                   |
| Open and read update pull requests (`update`, `status`)      | Pull requests: write on the repository               |
| Read a pull request's commit statuses                        | Commit statuses: read on the repository              |

GitHub's check runs, which carry the results of GitHub Actions, can't be read with a fine-grained personal access token. A GitHub App installation token with Checks: read can read them. Such a token can also be limited to one repository and expires within the hour, so a GitHub App is the better credential for `update` in CI.

The permissions for the GitLab and the Gitea and Forgejo hosts are read from their docs and listed here when slice 7 is built.

An organization can require approval for fine-grained tokens. Until an owner approves it, such a token can only read public resources.

## Compatibility and migration

Every change is additive:

- `@emdash-cms/fleet` is a new package. No existing command changes.
- Core moves the work of its two setup steps into one function, which the setup routes call as before, and exports it with the CLI credential store from an internal entry point. Setup through the wizard behaves as today.
- `/_emdash/api/health` gains an optional `deploymentId` field. Clients that read only the version see no change.
- The Cloudflare provider is a new export of `@emdash-cms/cloudflare`. The package's Kysely dialect for the D1 HTTP API, which only the migration runner can reach today, gets an internal entry point of its own.
- There's no database migration. A site the tool creates or removes gets one option row, `emdash:fleet`, which core doesn't read.
- `fleet.config.ts` is typed by `defineFleet()`. A later format change is a major version of `@emdash-cms/fleet`.

A site can leave the fleet at any time: deleting its entry changes nothing on the site, and `reconcile` then reports its resources as unnamed.

### Relation to #4577 and other proposals

This RFC doesn't depend on #4577. `update` uses `upgrade-emdash` as it ships today. Three things can build on #4577 or what follows from it, and none blocks this RFC:

- **An exact version.** `upgrade-emdash` installs a dist-tag today. An option to install an exact release, which #4577 raised, would let `--release` pin a run before any plan is read.
- **A result a tool can read.** `upgrade-emdash --yes` prints nothing machine-readable, so the tool checks the installed version itself. The summary option that #4577 raised would replace that check.
- **Start update in a site's admin.** The review of #4577 points to a hook into the update banner that a plugin fills. A plugin that asks the fleet for an update pull request can build on such a hook later.

[The env file plan (#4683)](https://github.com/emdash-cms/emdash/pull/4683) proposes `--env-file` for `emdash migrate`, with the same precedence and the same notice on stderr. The fleet commands don't depend on it, because they read the files themselves and pass the token to `emdash migrate` through its environment. #4683 never reads a file unasked; the fleet commands read `.env` beside the config by default, as the Cloudflare tools they run already do. If [custom roles (#4156)](https://github.com/emdash-cms/emdash/pull/4156) land, a fleet token can come from a user whose role holds only what the tool needs. If [the Durable Object site mode (#4790)](https://github.com/emdash-cms/emdash/pull/4790) lands, a site in that mode can be adopted for `status` and `update`. It has no D1 database and runs its migrations inside the object, so provisioning and deploying it needs an amendment to this RFC, or a Workers for Platforms provider built on it.

## Security and privacy

- **The Cloudflare token** is the most valuable secret in the system. Creating a Worker needs product-level Workers Admin, so a token that can provision can also delete every Worker on the account. Through the D1 HTTP API it can also read and write every site's database, as it already can for `emdash migrate`. It stays in the operator's environment, their `.env` file or their CI secrets, and is never stored by the tool. The guide page for running many sites recommends a token per environment, and a separate account where customers must be separated.
- **Repo layout:** the tool never copies a Cloudflare token into a repository's secrets. It prints which secrets the repository's pipeline needs, and the operator creates them. The pipeline's token can be limited to Workers: Editor for that one Worker, because its deploys keep the custom domain the tool attached unchanged. The tool never multiplies a deploy token across repositories itself.
- **Code the tool runs with the token:** `deploy` and `provision` run the project's own Wrangler and `emdash` with the Cloudflare token. For a `repo` site that's the checkout of the template, with its dependencies, so the template is trusted like the shared project. Installing and building a new checkout runs without the tokens, which keeps install scripts away from them, but not the code that later migrates and deploys.
- **Code `update` runs:** the install before the plan, and `upgrade-emdash` itself, run each repository's install scripts and dependencies on the machine that runs the tool. `upgrade-emdash` also fetches the EmDash agent skills with `npx skills add emdash-cms/skills`, and their files become part of the pull request. The tool keeps its provider, repository host and EmDash tokens out of those processes' environment, and it runs Git with the repository's hooks turned off, so a hook that a dependency installed can't run while the token is in use. That isn't isolation: the code runs as the same user and can read what that user can. So `update` is for repositories whose code the operator would run in their own CI. Where someone else can push to a site's repository, the operator runs `update` for one site per CI job, with a token for that one repository, or leaves that site to its own update tooling and uses only `status` for it.
- **The repository host's token** can create repositories in the target owner and push to them. Creating repositories is needed only during `repo` provisioning; `update` needs Contents: write and Pull requests: write on the site's repository.
- **EmDash tokens** are per site and scoped. `status` needs `admin` for the newest available version; `update`, `deploy` and `provision` need no EmDash token, except for the optional **import** step; `remove` needs `transfer:export`. A token for one site can't act on another, because each site has its own users and token table.
- **The first Admin:** setup is complete, with the Admin in place, before the site has a public URL, so the wizard, OAuth, AT Protocol and external authentication all find a configured site. Certificate Transparency logs publish a new hostname as soon as its certificate is issued; in 2017, attackers found fresh WordPress sites that way within 30 minutes and ran their setup before the owner did. A fleet site has no setup left to run by then.
- **The sign-in link** signs in as the Admin. It works once, expires after 1 hour by default, and is printed only on an interactive terminal unless `--print-sign-in-link` is passed, because anyone who reads the terminal output or CI log can use it until then.
- **The site list** holds hostnames, repository names and an account ID, and no secret or resource ID. Those identifiers aren't credentials, but they tell a reader which customers an agency has, so operators keep the file in a private repository. Because it's a TypeScript module, loading it runs its code with the operator's environment, including the Cloudflare token; it's the operator's own code, like `astro.config.mjs`.
- **Dry runs:** `--dry-run` output and every error message redact the provider's credentials (the variables in its `credentialEnv`), the repository host's token, the sign-in link and every generated secret value.
- **Untrusted input:** responses from sites are parsed as data. A site that reports an unexpected version or JSON shape fails its step, and nothing from a response is used as a URL or a command.
- **Privacy:** each site's users and content stay in that site's database. The tool reads only version, deployment and update state, the site's marker and, during provisioning, whether the users table has a row and whether the Admin has a passkey. `remove` writes an export file that holds personal data, and the guide page for running many sites says to treat it like a backup.

## Performance

Page requests don't change. The logged-out routes run the same queries, and the query-count snapshot stays the same. Health reads the deployment ID from a binding or an environment variable, without a query.

The tool's own cost is outbound requests from the operator's machine or CI: one health request per site for `status`, plus one admin request when a token is present. With `CLOUDFLARE_API_TOKEN` set, `status` also sends two D1 API requests per `shared` site to read its pending migrations. Looking resources up by name adds a few reads per site to each command. In the prototype, `status` over three local sites took 385–411 ms, of which about 200 ms is loading the CLI.

`update` costs one clone and two installs for each `repo` site it updates, on the machine that runs it, and one Git host API request per poll while it waits.

Account limits matter more than speed. The Cloudflare API has no account-wide count of Cron Triggers, so the **limits** step reads each Worker's schedules, one request per Worker. The **migrate** step costs more: `emdash migrate` sends each SQL statement to D1 as its own API request, and the core migrations on an empty database run about 600 statements. The **setup** step adds one request per statement of the seed and one per media file it uploads, so a template with sample content costs more than an empty one. One `provision` on an account with N Workers costs about 620 + N API requests before the seed, plus one `wrangler deploy`. At 250 Workers that's about 870 requests, against the API's limit of 1,200 requests per five minutes per user, so a second `provision` within five minutes can reach the limit. [Failure handling](#failure-handling) says how the tool stays under it. With one Worker, one Cron Trigger and one custom domain per site, an account holds at most 250 sites on Workers Paid, its Cron Trigger limit, and a zone at most 100, its custom domain limit, so a fleet beyond 100 sites spreads its hostnames over several zones. The limits are under [Limits and permissions](#limits-and-permissions).

## Failure handling

- **Provisioning stops halfway** (for example the deploy fails after the database exists): running `provision` or `reconcile` again finds what exists by name and continues from the first missing step. `reconcile --abandon` removes the half-created resources until someone has signed in.
- **The encryption key:** Worker secrets can't be read back, so the **deploy** step only checks that a secret by that name exists, and never sends a new key once one is there.
- **A database under the derived name belongs to someone else:** a marker that names another fleet or key, or completed setup without a marker, stops `provision` before anything changes. The operator picks another key, or adopts the site.
- **No interactive terminal for the sign-in link:** the **sign-in-link** step reports `waiting`. A later run on a terminal, or with `--print-sign-in-link`, issues a new link, as long as the Admin has no passkey.
- **The sign-in link expires unused:** the same; the next run issues a new one.
- **A limit is reached:** `provision` stops before creating anything and names the limit. Options are a second account or a higher limit from Cloudflare.
- **Two runs at once:** both look resources up by name. The second create of the same resource gets "already exists" and uses it, the migration lock serializes migrations, applying the seed is idempotent, and the second run's `createFirstAdmin()` inserts nothing.
- **Setup stops halfway** (for example on a rate limit during the seed): setup isn't complete, and the site has no public URL yet. The next run applies the seed again, which skips what exists, and continues.
- **A migration fails or the lock is held:** the wave stops, the site keeps its old Worker, and the output names the error from `emdash migrate`. The documented migration lock rules and the `--release-lock` and `--take-over-lock` options apply.
- **The database found by name isn't the one the site runs on:** the site stops before anything runs. The operator checks the database and runs the command again with `--accept-database <id>`.
- **A site doesn't report the new version or deployment in time:** no further wave starts. After a `deploy`, the site counts as failed. After an `update`, failing checks or a merged pull request that never deployed count as failed, and a pull request that's still open leaves the site `waiting`.
- **A site is unreachable:** `status` reports it and moves on. `deploy` and `update` count it as failed.
- **`upgrade-emdash` fails for a site** (a dependency it can't update, such as an alias or a local path, or a failed install): the site fails with its message, nothing is pushed, and no further wave starts.
- **The update branch holds someone else's commits:** the tool pushes nothing and waits on that pull request, as described under `update`.
- **A repository has no lockfile:** `update` fails the site before it installs anything.
- **The repository already exists** during `repo` provisioning: until setup is complete, the tool uses it only if it's empty or every commit in it carries the tool's trailer, and stops otherwise. A run that stopped after **repository** or **push** therefore continues in the same repository.
- **The Cloudflare API rate limit:** the tool counts the requests it sends and paces itself against the documented limit of 1,200 per five minutes. It can't rely on the `Ratelimit` header alone: in the test run, D1 query responses carried none, and another endpoint reported a quota of its own. Where a response has the header, the tool honours it. `emdash migrate` runs as its own process, so the tool budgets about 600 requests for it on a new database, the statements of the core migrations, and waits before it starts when its own count leaves less. If a request still gets a 429, the run stops cleanly: no further step or wave starts, and the output names the limit and the `retry-after` time. Running the command again continues from there. A 429 during **migrate** can leave the migration lock held, because the request that releases it is refused too. That site then needs the lock options above before it continues.
- **Observability:** every command prints one line per site and step, and `--json` gives the same as structured output for CI logs.

## Verification

- Unit tests for the config: validation errors with their path, `defaults`, derived names, `namePrefix` and `sharedBindings`.
- The provider conformance suite against the local test provider, and against the Cloudflare provider at the HTTP boundary: request shapes, the limits check, creation by name when the resource exists, pacing against the request budget, a clean stop on a 429, and token redaction in errors. `--dry-run` prints every API call.
- Command tests against a local fleet of three sites: `status` with and without tokens, `deploy` in waves with one injected failing migration, a database that differs from the bound one, a deploy on an unchanged version confirmed by the deployment ID, and exit code 3 for a site that waits.
- `update` tests against local Git repositories, the local repository host and a stand-in for `upgrade-emdash`, which otherwise always asks the npm registry: a wave that opens pull requests, a repository that's already on the release, a newer release taking over the open pull request, an update branch with someone else's commits, a declined pull request, a repository without a lockfile, a later site whose plan resolves another version, a pull request still open at the timeout, and a site that never reports the new version. One test runs the real `upgrade-emdash` on a fixture project.
- The repository-host part of the conformance suite, against the local host, against GitHub at the HTTP boundary, and against a real instance of each further Git host before its repository host ships: an empty repository filled from a template, a rerun in a repository that holds only the tool's commits, a repository with someone else's commits, and opening, updating and reading a pull request.
- Provisioning tests for both layouts that fail at each step and then run `provision` again, a `repo` run that stops after **push** and continues in the same repository, a later `provision` run on a `repo` site whose repository has other commits by then, two `provision` runs of one site at once, `reconcile` finishing a half-done site and bringing back a removed site only with `--site <key> --restore`, and `--abandon` refusing a site whose Admin has signed in.
- Marker tests: `provision` stops at a database whose marker names another fleet or key, or whose setup is complete without a marker; `deploy` and `reconcile` skip a removed site; a project with an extra KV binding gets a per-site namespace, and one listed in `sharedBindings` doesn't.
- Setup tests on a real SQLite database: the shared setup function gives the same database through the wizard's routes and through the CLI; after the **setup** step, the wizard's routes, an OAuth first sign-in, an AT Protocol first sign-in and an external-auth first user all create no Admin, and the runtime's first-request seed doesn't run; the sign-in link signs in once and expires; a second run issues a new link only while the Admin has no passkey; with external authentication, the `--admin` user signs in as Admin and no link is issued; the Vite plugin and the CLI resolve the same seed from one project.
- Health tests: `deploymentId` from the version metadata binding and from `EMDASH_DEPLOYMENT_ID`, and left out when neither is set.
- The query-count snapshot shows no change.
- A manual run of `provision` (both layouts), `deploy`, `update` and `remove` on a throwaway Cloudflare account and GitHub organization.

### Prototype findings

A local prototype (branch `daniel/fleet-prototype`, not a pull request) ran against `main` at `4269455b21` on 2026-11-10 and 2026-11-11, before this revision:

- `status` over three local `wrangler dev` sites, with and without tokens, and with one site stopped (exit code 1).
- `deploy` waves that stop at an injected migration failure and leave the other sites on their old version, and a fingerprint mismatch that stops one site before anything runs.
- `provision` for the `shared` layout with the local provider, run again after a failure at each step, creating each resource once, and `reconcile` finishing a half-done site. The Cloudflare provider was checked at the HTTP boundary and with `--dry-run` only.
- `update` waves against a stub of #4577's request route, including a site that never reports the new version.
- A list of every place the earlier design needed a decision it didn't state: 23 points, resolved in the text.
- The query-count snapshot didn't change.

The prototype recorded state in a `fleet.yaml`, closed the setup window with a setup secret, and sent update requests through the request route that #4577 proposed at the time. This revision replaces all three: resources are found by name, setup is complete before the domain is attached, and `update` opens the pull request itself. The setup-secret tests move to the separate proposal for #2929.

A run on 2026-11-18 followed this revision's steps for one `repo` site on a real Cloudflare account and GitHub organization, with scripts standing in for the tool:

- Provisioning from the starter template on EmDash 1.4.0: resources by derived name, 90 migrations in 55 seconds, and setup over the D1 HTTP API (marker, seed with sample content, site URL, first Admin, setup complete) in 20 seconds and 227 API requests, using core's existing seed and setup functions.
- The first deploy uploaded the encryption key with `--secrets-file`, and a later deploy kept it. Before the site got a public URL, its health route answered 404. Afterwards the setup route answered `ALREADY_CONFIGURED`, the admin redirected to the login page, and the sign-in link opened its confirmation page.
- `update` to 1.5.0: clone, install, plan, `upgrade-emdash`, commit and pull request took 24 seconds. After the merge, the pull request read as merged while health still reported 1.4.0. After six migrations and a deploy, health reported 1.5.0.
- With `CI=true`, `upgrade-emdash --yes` failed on pnpm's frozen lockfile until that default was turned off, which the `update` steps now do.
- Not covered: a custom domain (the account has no zone, so the `workers.dev` URL stood in for it), `deploymentId` in health, the `shared` layout, waves, and any Git host other than GitHub.

A second local check loaded each site as a Dynamic Worker behind one parent Worker; its results are under [Alternatives](#an-isolate-per-site-behind-one-worker). The limits and token permissions were read in the Cloudflare docs on the dates given.

## Rollout and implementation

Each slice is usable without the next:

1. `@emdash-cms/fleet` with `fleet.config.ts`, `list`, and core's internal export of the credential store.
2. `status`, and `deploymentId` in health.
3. The provider contract with its conformance suite, the Cloudflare provider, `adopt`, `provision` for the `shared` layout with setup from the CLI and the fleet marker, and `reconcile`. Core's shared setup function, the shared seed resolution and their internal export ship here.
4. `deploy`, `remove` and `reconcile --restore`.
5. `update`, with the GitHub repository host's find and pull-request operations, and the plain Git host. `status` gains its pull-request column and `adopt` its repository check here.
6. `provision` for the `repo` layout, with repository creation on GitHub.
7. Repository hosts for GitLab and for Gitea and Forgejo.

A deployment guide page for running many sites ships with slice 3. It gains `update` with slice 5, the `repo` layout with slice 6 and the further Git hosts with slice 7.

## Alternatives

### Many sites in one runtime

One Worker could pick the database from the hostname, as Discussion #139 asks, either through a request-resolved Durable Object name or a binding map. EmDash keeps state per runtime, not per database: site settings are cached per isolate, the locale configuration is a single global, and the runtime holds one plugin manager. Each piece would have to be keyed by site, and a missed one leaks one site's data into another. Locales and native plugins are fixed per build, so every site in the Worker would share them. Fleet tooling gives operators "one core, one upgrade" without that risk, and it doesn't block a later RFC for request-resolved databases.

### An isolate per site behind one Worker

A parent Worker could load each site as a Worker Loader child (a Dynamic Worker) and hand it its own database. A local check ran an unmodified starter build this way, one child per hostname, with no change to EmDash. Its verdict is that it works with named gaps. Each site rendered, set up its own Admin by passkey, kept content, media and sessions to itself, and published a scheduled entry when the parent's Cron Trigger called it. Measured locally:

- A child's first request on a migrated database took 271–300 ms, and a warm page 9.9 ms median, against 6.1 ms for the same build deployed as its own Worker.
- Each loaded child added 92–100 MB to the local process. That's process memory, not the isolate heap, so it doesn't show whether a child fits the 128 MB isolate limit.
- A site's first request on an empty database took 1.27–1.43 s, because it runs the core migrations.

It isn't the design here:

- The parent embeds the whole build (19.4 MiB), so every site behind one parent runs the same EmDash version. Upgrading in waves, where a failing site stays on its old version, would need per-site code loaded from storage, which wasn't tested.
- Every query crosses an extra RPC hop through a D1 shim in the parent, and each child needs a wrapper module so the parent's cron can wait for its scheduled work. That's host code the project would own.
- A Worker request can have at most 4 distinct Dynamic Workers in flight, so one Cron Trigger reaches sites in batches of 4.
- Production memory per child, startup against the 1 s limit, image transforms, sandboxed plugins and the Workers Cache inside a child are unmeasured.

It would remove the Worker and the Cron Trigger per site that cap a fleet at 250 sites per account, so a later RFC can build a provider on it against the same contract.

### A shared database with a tenant column

This is what Payload's multi-tenant plugin does. Every query has to carry the filter. Content writes and search use raw SQL, which a Kysely plugin receives only as text it can't add a filter to. Each EmDash site also keeps its own schema, which a shared table can't hold. Discussion #3079's pass-through remains useful for scoping inside one site.

### Commands in the `emdash` CLI

`emdash fleet` would share the CLI's release and its credential store directly. It would also put the Cloudflare and GitHub provisioning code, and its dependencies, into every EmDash project that never runs more than one site. A package in the monorepo shares the same code through imports and the same release cadence, without that weight.

### A tool outside the project

A tool outside the monorepo would track the CLI, the migration protocol and the setup functions from the outside, and every core release could break it. Inside the monorepo, the conformance suite and the core changes it depends on are tested together.

### A state file

The tool could record resource IDs and step state in a file it owns, as Terraform does with its state file. Two runs would then need a lock or would overwrite each other's records, and the file could drift from the account, which Terraform answers with `import`. Looking resources up by derived name has neither problem, and it's how Cloudflare's own tools treat provisioned resources.

A JSON file the tool writes back to could also serve the sites' own configs, so that both read one source of truth. Here the derived names do that: a `repo` site's committed config and the fleet find the same resources by the same names, and the marker in each database says which fleet and key own it, without a file that both sides write.

### A setup secret

The previous revision closed the setup window with a site secret, `EMDASH_SETUP_TOKEN`, that setup required. Running setup from the CLI makes it unnecessary for fleet sites and needs no new route, secret or admin message. A setup secret still helps deployments without a CLI, such as a deploy button, which can ask for secrets during deployment; that's the separate proposal for #2929.

### A hosted console

A registry Worker with a web dashboard matches what agencies know from WordPress fleet managers. It needs a long-lived Cloudflare token stored in a Worker. The CLI keeps that token in CI. Because the operations are a library and the state lives on the platform, a console can be built later on the same functions, running `provision`, `deploy` and `update` as CI jobs.

### A repository per site only

`create-emdash` already creates a project per site, and this RFC's `repo` layout adds provisioning and update pull requests for such sites. On its own, a repository per site doesn't give the operators in Discussion #139 "one core, one upgrade", so the `shared` layout stays the default.

### A workflow in each repository, or Renovate

The previous revision sent each `repo` site an update request, and a workflow in the site's repository opened the pull request. That keeps every install inside the site's own CI, which separates sites from each other for free. It also needs a pipeline file per Git host, a trigger and a token in every site, and a request route in core, which the review of #4577 moved away from. Opening the pull request from the tool needs none of that and works the same on every Git host that has a repository host. An operator who needs the separation runs `update` for one site per CI job.

Renovate opens version pull requests on many Git hosts, and a site can keep using it. It doesn't run `upgrade-emdash`, so it doesn't refresh the agent skills or write the work order, and it has no waves that stop when a site fails. `status` covers such sites either way. Like Renovate, `update` doesn't carry out the work order or apply migrations for a `repo` site: a person or an agent finishes the work order on the pull request, and the site's pipeline migrates when it deploys. What `update` adds is that the work order arrives with the pull request, for every site in the wave.

## Drawbacks

- Creating sites works only on Cloudflare in this RFC, and creating repositories on GitHub first, with GitLab, Gitea and Forgejo in the last slice. The Docker host is a sketch.
- The Cloudflare token in the operator's CI can delete every Worker on the account and read every site's database.
- It isn't what Discussion #139 literally asked for: each site is still its own deployment, and an operator with many sites pays for one Worker, one database and one Cron Trigger each, within the account limits.
- `update` waits on pipelines it doesn't control, so a wave of `repo` sites can stall on one pull request.
- Resource names and the marker are fixed by the site key, and a key never names another site. Renaming a key means moving the site's resources and its marker by hand.
- `update` runs each repository's install where the tool runs, so it suits repositories the operator trusts, or one site per CI job.

## Open questions

- **The encryption key:** `provision` sets `EMDASH_ENCRYPTION_KEY` once and never generates it again, because the Worker secret can't be read back. Losing it still loses every plugin secret on the site. Should the tool also write it to an operator-chosen file, print it once, or leave the backup to the operator's own secret manager?
- **Waiting in `update`:** should there be a mode that opens pull requests in waves without waiting for the new version, for fleets where every update pull request is reviewed by hand?
