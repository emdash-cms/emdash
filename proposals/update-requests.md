---
title: Start site updates from the admin, the CLI or an agent
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4540
created: 2026-11-01
---

# Start site updates from the admin, the CLI or an agent

## Summary

EmDash ships an update workflow for GitHub Actions and lets an admin start it from the update banner, the `emdash` CLI or an MCP tool. EmDash only sends the request. The site's own pipeline installs the release, opens a pull request, and decides whether to build and deploy it.

The RFC covers four pieces:

- Three new options in `upgrade-emdash`: install an exact version, wait out a release age, and write a machine-readable summary.
- A workflow file that runs `upgrade-emdash` and opens a labelled pull request. It needs no change to core.
- An update request in core: a `trigger` setting under `updateCheck`, an admin-only endpoint, and a Start update button on the banner.
- A CLI command and an MCP tool that send the same request. An MCP request without the right token scope waits for an admin to approve it on the banner.

## Problem and user case

Since [#1939](https://github.com/emdash-cms/emdash/pull/1939), the admin dashboard shows a banner when a newer EmDash release is out. The banner tells the admin to update the `emdash` package and redeploy. On Workers or in a container, the running site is a fixed build. It can't install packages, build itself or deploy. [Discussion #1889](https://github.com/emdash-cms/emdash/discussions/1889), which proposed the banner, left out an update button for that reason. For a site owner who isn't the developer, the banner is a dead end.

The update itself is documented in [Update EmDash](https://docs.emdashcms.com/deployment/updating/): run `upgrade-emdash`, complete the work order in `.emdash/UPGRADE.md`, build, back up when the update adds migrations, and deploy. A site that automates this wires it into its own pipeline by hand, for example with Renovate, Dependabot or a custom bot. Renovate and Dependabot don't run the work order or tell the reviewer whether the update changes the database.

[Discussion #4540](https://github.com/emdash-cms/emdash/discussions/4540) describes the demand. Someone who had just moved their first site from WordPress to EmDash on Workers asked on Discord how others keep their sites updated. Their plan was a bot that opens an update pull request a few days after each release, deploys small fixes on its own and leaves bigger ones for a person. An agency with many sites would want to start the same update from a script.

## Example

A site deploys from the `acme/marketing-site` repository on GitHub. Its developer copies the shipped workflow to `.github/workflows/emdash-update.yml` and adds the trigger to the EmDash configuration:

```js title="astro.config.mjs"
emdash({
	updateCheck: {
		minimumReleaseAge: "3d",
		trigger: {
			type: "github",
			repository: "acme/marketing-site",
			workflow: "emdash-update.yml",
			ref: "main",
		},
	},
});
```

They create a fine-grained personal access token for that one repository with the Actions: write permission and store it as a deployment secret:

```bash
pnpm wrangler secret put EMDASH_UPDATE_TOKEN
```

Three days after EmDash 1.5.0 is published, the banner on the dashboard reads "EmDash 1.5.0 is available (you're running 1.4.0)" and offers Start update. The admin confirms a dialog that names `acme/marketing-site`. EmDash asks GitHub to run the workflow with `version: 1.5.0`, and the banner changes to "Update to 1.5.0 requested on 2026-11-04 09:12 by Jane Doe" with a View run link.

The workflow installs 1.5.0 with `upgrade-emdash` and commits the result, including `.emdash/UPGRADE.md`. It opens the pull request "Update EmDash to 1.5.0" with the label `emdash: migrations` because the release adds a core migration. The site's own rules take over from there. Here, a person reviews pull requests with that label, and Workers Builds deploys `main` after the merge. Once 1.5.0 is running, the banner disappears.

The same request from a terminal:

```bash
npx emdash site request-update --url https://marketing.example.com
```

An agent connected over MCP calls `site_update_request`. Its token doesn't hold the `updates:request` scope, so the tool answers that an admin has to approve the request. The next admin who opens the dashboard sees "An agent asked to update to 1.5.0 for Jane Doe" with Start update and Dismiss.

## Goals

- An admin can start an update from the banner without access to the repository or a terminal.
- The CLI and an MCP client send the same request, with the same permission and the same rules for which version can be requested.
- An update requested from EmDash installs the version the update check reported, which has already waited out `updateCheck.minimumReleaseAge`.
- EmDash ships a workflow that turns a request into a pull request that tells the reviewer whether the update adds core migrations and whether a release entry asks for changes to the project.
- The same workflow can run on a schedule without EmDash, with the same release-age rule.
- Nothing changes for a site that doesn't configure a trigger, apart from a link to the update guide on the banner.

## Non-goals

- Building, deploying, checking or rolling back the site. The pipeline owns those steps.
- Showing the state of the pull request or the deploy in the admin. See [Open questions](#open-questions).
- Knowing before installation whether a release adds migrations. The workflow learns it after installation, which is where the pipeline decides what to do with the pull request. See [Open questions](#open-questions).
- Astro and other non-EmDash dependencies. [Discussion #1888](https://github.com/emdash-cms/emdash/discussions/1888) covers grouped dependency updates.
- Marketplace plugins, which already update from the admin.
- Sites without a pipeline, such as shared hosting without a build step ([Discussion #4509](https://github.com/emdash-cms/emdash/discussions/4509)).
- Provider-specific triggers other than GitHub. The webhook trigger covers GitLab, Coolify and hosts' own systems through a receiver.
- A coding agent that completes the work order. A site can add that step to its copy of the workflow.
- A view for managing many sites at once. The CLI command can be scripted across sites.

## Detailed design

### Terms

- **Update request**: an admin's instruction to update the site to one EmDash version, sent from the banner, the CLI or MCP.
- **Trigger**: the configured destination of an update request, either a GitHub workflow or a webhook.
- **Release group**: the packages that share `emdash`'s version number, the `fixed` group in `.changeset/config.json` (`emdash`, `@emdash-cms/admin`, `@emdash-cms/auth`, `@emdash-cms/blocks`, `@emdash-cms/cloudflare`, `@emdash-cms/gutenberg-to-portable-text`, `@emdash-cms/x402` and `create-emdash`).

### `upgrade-emdash` options

`upgrade-emdash` resolves an npm dist-tag for every direct `emdash` and `@emdash-cms/*` dependency today, and `--to` rejects an exact version. Three options are added. `--to` keeps its behavior, and so does `--version`, which prints the updater's own version.

`--release <x.y.z>` installs one stable release. Every direct dependency in the release group gets exactly that version. Every other direct `@emdash-cms/*` dependency, such as a plugin package, resolves the `latest` dist-tag as it does today. `upgrade-emdash` carries the release group as a list generated from `.changeset/config.json` at build time. `--release` and `--to` can't be combined. A version that isn't a stable `major.minor.patch` release fails before anything is installed. A version older than the installed one fails as it does for a dist-tag today. When every dependency already has its target version, the command reports that the project is up to date and exits with code 0 without changing files.

`--minimum-release-age <duration>` takes a duration string (`"72h"`, `"3d"`) or a number of seconds, the format of `updateCheck.minimumReleaseAge`. Without `--release`, the release group gets the newest stable `emdash` version, no newer than `latest`, that was published at least that long ago and isn't deprecated, the rule the update check uses. Other `@emdash-cms/*` dependencies get the newest stable version, no newer than `latest`, that is at least that old. With `--release`, the option rejects a version younger than the age. It can't be combined with `--to`.

`--summary <file>` writes a JSON summary after a successful run, including a run that changes nothing:

```json title="summary.json"
{
	"updated": true,
	"fromVersion": "1.4.0",
	"toVersion": "1.5.0",
	"dependencies": [{ "name": "emdash", "from": "1.4.0", "to": "1.5.0" }],
	"migrationsAdded": ["095_example_migration"],
	"actionRequired": true,
	"guidePath": ".emdash/UPGRADE.md"
}
```

`actionRequired` is true when a release entry crossed by the update contains a `#### What should I do?` heading, the heading `.changeset/README.md` uses for a required action. The summary can be combined with `--yes`. `--json` keeps its dry-run meaning.

### The shipped workflow

The workflow is a single file, `emdash-update.yml`. The update guide documents it, and the templates include it at `.github/workflows/emdash-update.yml`. It uses only GitHub's own actions and the package managers' official setup actions, pinned to commit SHAs. It runs on `workflow_dispatch` with three string inputs: `version`, `request_id` and `source`. A `schedule` trigger is included, commented out, so a new site never opens pull requests until someone enables it.

On each run, the workflow:

1. Checks out the ref the run was dispatched on, which is `trigger.ref` for a request and the default branch for a scheduled run, detects the package manager from the lockfile, and installs the current dependencies from the lockfile. `upgrade-emdash` reads the installed versions from `node_modules`.
2. Passes the inputs to the steps through environment variables, never through `${{ }}` expressions inside a script. It maps `source` to `admin`, `cli`, `mcp` or `schedule`, and anything else to `unknown`, and drops a `request_id` that isn't a ULID, so no input reaches the pull request as text.
3. Runs `npx upgrade-emdash@latest --yes --summary "$RUNNER_TEMP/emdash-update.json"`, adding `--release "$VERSION"` when the request carries a version, and on a scheduled run `--minimum-release-age` with an age set at the top of the workflow file.
4. Ends without a pull request when the summary reports `updated: false`.
5. Commits the changed manifests, lockfile, synced skills and `.emdash/UPGRADE.md` to the branch `emdash-update/<toVersion>` and pushes it. If that branch already exists with commits the workflow didn't make, the run stops without pushing, so work done on the pull request is never overwritten.
6. Opens or updates the pull request "Update EmDash to `<toVersion>`" against the checked-out ref with `gh`. The body lists the package changes, the added migrations and the release entries that ask for project changes, and links `.emdash/UPGRADE.md`. It says whether the run came from the admin, the CLI, MCP or the schedule. It never names a person.
7. Adds the label `emdash: migrations` when `migrationsAdded` isn't empty, and `emdash: project changes` when `actionRequired` is true. It creates either label first if the repository doesn't have it.

The job requests `contents: write` and `pull-requests: write`. A `concurrency` group keeps two runs from working at the same time. A later run waits instead of cancelling the running one. GitHub keeps one waiting run per group, so a newer run replaces a waiting one, which ends as cancelled. Open pull requests for older versions stay open. The new pull request links them.

A pull request opened with the default `GITHUB_TOKEN` doesn't start other workflows, so checks that run on GitHub Actions don't run on it. Integrations that are GitHub Apps, such as Workers Builds, still run. When the secret `EMDASH_UPDATE_PR_TOKEN` exists, the workflow pushes the branch and opens the pull request with it, so checks run when the pull request opens and on every later push to it. The update guide explains both choices, and that the repository setting "Allow GitHub Actions to create and approve pull requests" must be on for `GITHUB_TOKEN`.

### Trigger configuration

`updateCheck` gains an optional `trigger`. Nesting it under `updateCheck` means a trigger can't exist while the check is off, since the request needs the version the check reports.

```ts
type UpdateTrigger =
	| {
			type: "github";
			/** `owner/name` of the repository that holds the workflow. */
			repository: string;
			/** Workflow file name, such as `emdash-update.yml`, or its numeric ID. */
			workflow: string | number;
			/** Branch the workflow runs on and the pull request targets. */
			ref: string;
			/** API origin for GitHub Enterprise Server. @default "https://api.github.com" */
			apiUrl?: string;
	  }
	| {
			type: "webhook";
			/** HTTPS URL that receives the request. */
			url: string;
	  };

updateCheck?: boolean | { minimumReleaseAge?: string | number; trigger?: UpdateTrigger };
```

`emdash()` validates the trigger when Astro loads the configuration and fails the build with the option path on a wrong shape. `repository` must match `owner/name`. `workflow` must be a file name that ends in `.yml` or `.yaml` and holds no path separator, or a number; both are URL-encoded into the dispatch path. `url` and `apiUrl` must use `https:`, except on `localhost` in development. The trigger holds no secret, so it can sit in the configuration and the virtual config module.

The secret is read from `process.env` when a request is sent, never from `import.meta.env`, so it is never inlined into the build:

- `EMDASH_UPDATE_TOKEN` for a GitHub trigger: a fine-grained personal access token with Actions: write on the one repository. That permission can't push code.
- `EMDASH_UPDATE_WEBHOOK_SECRET` for a webhook trigger, sent as a bearer token.

A trigger without its secret is shown as not ready, and sending fails with `UPDATE_TRIGGER_NOT_READY`.

### Update request record

The current request is stored in the options table under `emdash:core_update_request`, next to the update check's `emdash:core_update_check`. A new request replaces it, so no migration is needed.

```ts
interface CoreUpdateRequest {
	/** ULID, sent to the trigger as the request ID. */
	id: string;
	version: string;
	fromVersion: string;
	source: "admin" | "cli" | "mcp";
	status: "awaiting_approval" | "sending" | "sent" | "failed";
	/** User ID of the admin who sent it, or of the MCP caller for a request made over MCP. */
	requestedBy: string;
	requestedAt: string;
	/** User ID of the admin who approved an MCP request. */
	approvedBy?: string;
	sentAt?: string;
	/** HTTPS link to the started run, when the trigger returned one. */
	runUrl?: string;
	/** Error code of a failed send. */
	error?: string;
}
```

The record only counts while its version is newer than the running version and is still the version the update check reports. Otherwise the API and the banner ignore it. A `sending` record older than one minute counts as `failed`. An `awaiting_approval` record older than 24 hours no longer counts, so an agent whose session has ended doesn't leave its question on the banner until the next release.

### Sending a request

A new handler, `handleCoreUpdateRequest(db, { version, source, user, approvedBy? })`, sends a request:

1. It fails with `UPDATE_TRIGGER_NOT_CONFIGURED` when no trigger is configured, and with `UPDATE_TRIGGER_NOT_READY` when the trigger's secret is missing. It reads the update status with `handleCoreUpdateStatus` and the same `minimumReleaseAge`. The requested version must equal the reported `latest`, and `updateAvailable` must be true. Otherwise it fails with `UPDATE_NOT_AVAILABLE`. A request can never name an arbitrary version.
2. A `sent` record for the same version that is less than 15 minutes old fails the request with `UPDATE_ALREADY_REQUESTED` and the time it can be retried. So does a `sending` record less than one minute old, and a `failed` record less than one minute old, so a wrong token or an unreachable receiver can't be hammered from a script.
3. It claims the send by writing a `sending` record with `OptionsRepository.compareAndSet`, against the revision it read in step 2. When the claim doesn't apply, another send got there first, and the request fails with `UPDATE_ALREADY_REQUESTED`.
4. It sends the request to the trigger with a 10-second timeout and replaces the `sending` record with the outcome.

For a GitHub trigger it calls `POST {apiUrl}/repos/{owner}/{name}/actions/workflows/{workflow}/dispatches`:

```json
{
	"ref": "main",
	"inputs": { "version": "1.5.0", "request_id": "01JB…", "source": "admin" },
	"return_run_details": true
}
```

A 200 response carries `html_url`, which becomes `runUrl`. A 204 response counts as sent without a link. When a GitHub Enterprise Server rejects `return_run_details` with 422, the handler retries once without it.

For a webhook trigger it sends `POST {url}` with `Authorization: Bearer <secret>`, `X-EmDash-Event: core-update.requested`, and this body:

```json
{
	"event": "core-update.requested",
	"requestId": "01JB…",
	"version": "1.5.0",
	"currentVersion": "1.4.0",
	"source": "admin",
	"requestedAt": "2026-11-04T08:12:00.000Z",
	"siteUrl": "https://marketing.example.com"
}
```

Any 2xx response counts as sent. The request doesn't follow redirects (`redirect: "error"`), so the secret reaches only the configured URL. When the response is JSON with a `url` string that uses `https:`, that link becomes `runUrl`. The handler reads at most 16 KB of the response and ignores everything else in it. The header names follow the webhook notifier plugin. The receiver treats the body as a notice, not a command: before it installs anything it checks that `version` is a stable release newer than the one it runs, as the shipped workflow does through `upgrade-emdash`, and it uses `siteUrl` for display only.

### REST API

`GET /_emdash/api/admin/core-update` keeps its response and adds two fields:

- `trigger`: `null`, or `{ type, target, ready }`, where `target` is `owner/name` for GitHub and the URL's host for a webhook.
- `request`: the current record while it counts, with the requester's and approver's display names, or `null`.

Both options keys are read in one `getMany` query, and the user lookup runs only when a record exists.

`POST /_emdash/api/admin/core-update/request` takes `{ version }` and sends a request with `source: "admin"`, or `"cli"` when the caller is authenticated with a token. From a signed-in session, while a request for that version awaits approval, it approves that request: it is sent with `source: "mcp"` and the admin as `approvedBy`. It answers with the stored record.

`DELETE /_emdash/api/admin/core-update/request` dismisses a request that awaits approval. It is accepted only from a signed-in session.

Both write routes require the new permission `updates:request`, added to `rbac.ts` with the minimum role Admin. A token caller also needs the new token scope `updates:request`. The `admin` scope includes it, as it includes the transfer scopes. The status route `GET /_emdash/api/admin/core-update` accepts the `updates:request` scope as well as `admin`, so a token that can request an update can read the version it would request, which `emdash site request-update` needs. The scope rules for both `core-update` paths come before the generic `/_emdash/api/admin` rule in the auth middleware, as the transfer rule does. The CSRF header rule applies as it does to every state-changing route.

The site write fence refuses both write routes and the `site_update_request` MCP tool while a site import is in progress or incomplete, as it refuses other admin writes. A request doesn't count as a site write, so it never restarts a running export. Like an entry edit lock, the record holds nothing a site package carries.

New error codes, mapped in `mapErrorStatus`:

| Code                            | Status | Meaning                                                                                                           |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `UPDATE_TRIGGER_NOT_CONFIGURED` | 409    | No trigger is configured                                                                                          |
| `UPDATE_TRIGGER_NOT_READY`      | 409    | The trigger's secret is missing                                                                                   |
| `UPDATE_NOT_AVAILABLE`          | 409    | The version isn't the newest reported release, or the site already runs it                                        |
| `UPDATE_ALREADY_REQUESTED`      | 409    | The same version was sent less than 15 minutes ago, failed less than a minute ago, or another send is in progress |
| `UPDATE_TRIGGER_REJECTED`       | 502    | The trigger answered with an error. `details.reason` is `unauthorized`, `not_found`, `invalid` or `failed`        |
| `UPDATE_TRIGGER_UNREACHABLE`    | 502    | The request timed out or couldn't connect                                                                         |

The response never includes the trigger's response body. The server log records the status code and, for GitHub, the response's `message` field, never the token.

### Admin banner

The banner stays on the dashboard for users with `updates:read`, which is Admin today, and stays dismissible per version.

- **No trigger:** the banner adds an Update guide link to the documentation page.
- **Trigger ready:** the banner offers Start update. A confirmation dialog names the target ("This runs the update workflow in acme/marketing-site. Your pipeline decides how the update is deployed.") and sends the request.
- **Trigger not ready:** Start update is disabled, with a note that the deployment's secret is missing.
- **Sent:** "Update to 1.5.0 requested on <date> by <name>", with View run when there is a link. Start update is offered again after 15 minutes. A `sending` record shows the same text without the link.
- **Failed:** the error in words, such as "GitHub rejected the token. It may have expired.", with Try again, which is enabled one minute after the failure.
- **Awaiting approval:** "An agent asked to update to 1.5.0 for <name>", with Start update and Dismiss. Start update sends the request with `source: "mcp"` and the admin as `approvedBy`. This state shows even when the admin dismissed the banner for that version, because the agent is waiting for an answer. It expires after 24 hours.

The dialog uses `ConfirmDialog`, and every string, including the error texts mapped from the codes above, goes through Lingui. Dates use the admin locale's formatting, and the layout uses logical classes. The dismiss state stays in `localStorage`, per version as today.

### CLI

Two subcommands join `emdash site`, which already holds the commands that act on a whole site. They use the same connection options as the other remote commands:

- `emdash site update-status` prints the running and newest versions, the trigger and the current request. `--json` prints the API response.
- `emdash site request-update` shows the same status, asks for confirmation, and sends a request for the reported version. `--yes` skips the confirmation and is required without a TTY. It exits with a non-zero code when nothing can be requested or the trigger rejects the request.

The names say "update" and sit under `emdash site`, so they can't be mistaken for `upgrade-emdash`, which runs in the project.

### MCP

Two tools join the core MCP server:

- `site_update_status` returns what `update-status` prints. It requires the `updates:read` permission and, like the REST status route, the `admin` or `updates:request` token scope. It is marked read-only (`readOnlyHint`), so the site write fence lets it run during an import.
- `site_update_request` takes an optional `version`, which must match the reported version when given. It requires the `updates:request` permission. With the `updates:request` scope (or `admin`), it sends the request with `source: "mcp"`. Without the scope, it runs the handler's first three steps with `awaiting_approval` in place of `sending`, with one stricter rule: a `sent` record that still counts refuses it however old, with `UPDATE_ALREADY_REQUESTED` and the run link, so an agent's question never replaces a request that is already in flight. It answers `{ status: "awaiting_approval" }` with a message that an admin has to approve the request in the admin dashboard.

An admin approves a request on the banner, from a signed-in session. Approving sends the request, so the agent doesn't call the tool again. A second call while a request awaits approval returns the same answer and doesn't create another record. The approval is single-use because sending replaces the record.

## Compatibility and migration

Every change is additive:

- `updateCheck` accepts a new optional key. Existing configurations behave as before.
- `GET /_emdash/api/admin/core-update` adds two fields.
- The new route, permission, token scope, error codes, CLI subcommands, MCP tools and `upgrade-emdash` options are new names. Existing tokens keep their scopes. A token with `admin` gains the new scope, as it gained the transfer scopes.
- No database migration. Older code ignores the `emdash:core_update_request` key, so a rollback leaves an unused option behind.
- Templates gain one workflow file. Existing sites copy it from the update guide, since template changes don't reach existing projects.

If [the configuration validation plan (#4328)](https://github.com/emdash-cms/emdash/pull/4328) lands first, the trigger gets an entry in its schema. If [custom roles (#4156)](https://github.com/emdash-cms/emdash/pull/4156) land, a custom role can hold `updates:request`, as it can hold `updates:read`. If [read-only mode (#4461)](https://github.com/emdash-cms/emdash/pull/4461) lands, it refuses update requests while the site is frozen, as it refuses other fenced writes.

## Security and privacy

- **Who can send:** only users with `updates:request` (Admin), through a session with the CSRF header, a token with the `updates:request` or `admin` scope, or an admin's approval of an MCP request. Approval and dismissal require a session, so an agent can't approve its own request. Any token of a user with `updates:request`, whatever its scopes, can store an approval request over MCP. Its worst case is a question on the banner that an admin dismisses; nothing is sent without the admin.
- **What can be requested:** only the version the update check reports. The request has no free-form fields that reach the trigger.
- **Where it goes:** the trigger comes from the build configuration. No admin input sets a URL or repository, so the endpoint can't be used to send requests to arbitrary hosts.
- **Secrets:** the GitHub token and the webhook secret live in the deployment's secrets, read from `process.env` at send time. They are never stored in the database, returned by the API or logged. The GitHub token needs only Actions: write on one repository. That permission can't read or write repository contents. It does control the repository's Actions: a leaked token can start any workflow that runs on `workflow_dispatch`, re-run, cancel or delete runs, approve runs from forks, turn workflows off and on, read and delete logs and artifacts, delete caches, and change the repository's OIDC subject claim format. A leaked webhook secret lets its holder send a forged request to the receiver, with any version and site URL, which is why the receiver validates them. `EMDASH_UPDATE_PR_TOKEN`, where a site adds it, is a fine-grained token with Contents: write and Pull requests: write on the one repository. It lives in the repository's Actions secrets, where every workflow in the repository can read it, and it can push to any branch that branch protection doesn't cover. The update guide says to give it an expiry.
- **The workflow:** inputs reach scripts only through environment variables, and `upgrade-emdash` rejects anything that isn't a stable version. The job can push branches and open pull requests. Branch protection on the default branch is the site's control over what reaches production. The workflow runs `upgrade-emdash@latest`, as the update guide already does. A site that wants a fixed updater version can pin it in its copy.
- **Abuse:** sending the same version is limited to once per 15 minutes, and a retry after a failure to once per minute. Repeated requests start at most one workflow run at a time per repository because of the `concurrency` group.
- **Privacy:** the request carries no personal data. The record stores user IDs, which the admin resolves to names, and the pull request never names a person.

## Performance

Logged-out routes are unchanged. There are no new queries, no cold-start work and no outbound requests outside an admin's action.

The admin status route reads one more options key in the query it already runs, and looks up names only while a request exists. Sending makes one outbound request, and at most two for GitHub Enterprise Server. The banner keeps its one-hour cache and refetches after a send.

## Failure handling

- **The trigger rejects the request or can't be reached:** the record stores `failed` with the code, the banner shows the reason, and the admin can retry after a minute. A 401 or 403 from GitHub points to an expired or wrong token. A 404 points to a wrong repository or workflow, or a token without access. A 422 points to a missing ref or inputs that the workflow doesn't define.
- **The response is lost after GitHub started the run:** the record says `failed` although a run started. A retry starts a second run. That run either finds the branch it would create, where it updates the pull request, or waits behind the first one in the `concurrency` group. The result is still one pull request.
- **A site import is in progress or incomplete:** the fence refuses the request with its import error, and the admin sends it again once the import finishes or is abandoned.
- **Two admins send at the same moment:** only one claim applies. The other admin gets `UPDATE_ALREADY_REQUESTED` and sees the first request on the banner.
- **The site stops in the middle of a send:** the `sending` record stays behind. After one minute it no longer blocks a new request, and the banner offers Start update again.
- **The workflow fails** (installation fails, the project isn't supported, or the branch has someone else's commits): the run fails visibly in GitHub, and the admin shows the request as sent with a link to the run. The admin doesn't learn about the failure. See [Open questions](#open-questions).
- **A newer release appears while a pull request is open:** the banner offers the newer version. Its run opens a second pull request that links the first.
- **Operator action:** fix the token, the trigger or the workflow, then send again. Disable the feature by removing `trigger`. The stored record is then ignored.

## Verification

- `upgrade-emdash` unit tests with packument fixtures: the release group gets the exact version and plugins resolve `latest`. They also cover the release-age selection with and without `--release`, rejecting prereleases and too-young versions, the up-to-date exit, the summary fields, and `actionRequired` from a `#### What should I do?` heading.
- Handler tests on a real SQLite database with an injected `fetch`: GitHub 200 with run details, 204, 422 followed by the retry, 401, 404, a timeout, and webhook 2xx with and without a `url`. Also a version mismatch, the 15-minute limit, the one-minute limit after a failure, a redirect answer, and a missing secret.
- Route tests: an Editor is refused, a token without the scope is refused, a token with `admin` passes, a token with only `updates:request` reads the status and sends, a DELETE from a token is refused, and the CSRF header is enforced.
- MCP tests: with the scope the tool sends, without it the tool stores one `awaiting_approval` record, a second call doesn't create another, a call while a request is sent answers with the run link, a record older than 24 hours no longer counts, approval from a session sends the request, and the status tool refuses a token without `admin` or `updates:request`. Route and MCP tests also cover a running import refusing a request and a running export that doesn't restart after one.
- Configuration tests: wrong trigger shapes fail the build with their path, and `http:` URLs are refused outside `localhost`.
- Admin component tests for each banner state, including a request awaiting approval for a dismissed version, plus a manual check of the banner and dialog in Arabic.
- The query-count snapshot shows no change on logged-out routes.
- A manual end-to-end run on a fork: a template site on Workers with Workers Builds starts the workflow from the banner, the pull request appears with the right labels, and after the merge and deploy the banner disappears. The same run is repeated with a scheduled trigger and a webhook receiver.

## Rollout and implementation

Each slice is usable without the next one:

1. **`upgrade-emdash` options:** `--release`, `--minimum-release-age` and `--summary`.
2. **The workflow:** the file, an "Update from GitHub Actions" section in the update guide, and the template copies. With slices 1 and 2, a site can run scheduled updates without any core change.
3. **Core request:** the `trigger` option, the record, the handler, the POST route, the permission and scope, and the banner states other than awaiting approval.
4. **CLI:** `emdash site update-status` and `emdash site request-update`.
5. **MCP:** both tools, the `awaiting_approval` status, approval through the POST route, the `DELETE` route, and the awaiting state on the banner.

No feature flag is needed. The feature is off until a site configures a trigger.

## Alternatives

### Update inside the running site

The admin could install packages and rebuild in place. On Workers and in containers the running code is a fixed build, and on Node.js a site that rewrites its own dependencies can't be reviewed or rolled back. Discussion #1889 ruled this out, and this RFC keeps that decision.

### A plugin only

A sandboxed plugin can render a dashboard widget with a button, call a URL, keep an encrypted setting and register its own MCP tool. It can't add the button to the core banner, add a CLI command, use an approval that only a session can give, or keep its token out of the database. A plugin remains a good home for other pipelines' status views, as [Discussion #4216](https://github.com/emdash-cms/emdash/discussions/4216) suggests for deploys.

### Reuse the transfer approval grants

Site transfers already let an admin approve an MCP request. Their grants live in `_emdash_transfer_approvals`, whose `action` column has no constraint. Old code throws on an unknown action when it lists grants, though, so a rollback would break the transfer approvals list. The transfer flow also makes the agent call again with the grant, because the agent then drives the transfer. An update has nothing to drive, so the admin's approval can send the request directly.

### A published composite action

The workflow could call an action published from this repository, as plugins do with `emdash-cms/emdash/apps/release-action@main`. That action would run with write access to every site's repository and would become a privileged supply-chain system. Keeping the logic in `upgrade-emdash` and the workflow in a plain file keeps the trust where sites already place it: the npm package they install.

### Renovate or Dependabot configuration in the templates

Grouped dependency updates are useful and stay compatible with this design. They don't run the work order, don't report added migrations, and can't be started from the admin.

### The token in site settings

An encrypted setting would let an admin configure the trigger without a deploy. It would also let anyone who takes over an admin session read or replace the token, and it depends on `EMDASH_ENCRYPTION_KEY`. A deployment secret keeps the token with the people who deploy the site.

### A signed webhook

An HMAC signature over a timestamp and the body would let a receiver detect replays. Many deploy hooks only accept a token. The bearer header matches the webhook notifier plugin. If a shared signing scheme for EmDash webhooks is accepted ([Discussion #2619](https://github.com/emdash-cms/emdash/discussions/2619), [Discussion #4546](https://github.com/emdash-cms/emdash/discussions/4546)), the update webhook can add it.

## Drawbacks

- One more secret per site, and fine-grained tokens expire. An expired token shows up as a failed request on the banner, not in advance.
- Pull requests opened with `GITHUB_TOKEN` don't run GitHub Actions checks. Sites that need them have to add a second token.
- `actionRequired` depends on release entries using the `#### What should I do?` heading. An entry that asks for a change without the heading isn't flagged.
- Existing sites copy the workflow by hand, and later changes to the shipped file don't reach them.
- The admin can't tell whether the update reached production until the new version is running.

## Open questions

- **Status after sending:** should the admin show the pull request and deploy state? Options are a callback route the pipeline calls with a scoped token, or EmDash reading the run with an Actions: read token. Either overlaps with deploy status in Discussion #4216, and one shared piece could serve both.
- **Migrations before installation:** the update check already downloads the full npm packument, which includes each version's `package.json`. A field written at publish time, such as the core migrations a release adds, would let the banner say "this update changes the database" before anything is installed. Is that worth a release-process change?
- **Templates:** should all templates include the workflow, or only the ones that deploy from Git? A dispatch-only workflow does nothing until triggered, but it is one more file for sites that never use GitHub.
