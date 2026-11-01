---
title: Unpublish a plugin from the registry
type: feature-plan
status: accepted
authors:
  - Daniel Mueller (@danielmlr)
discussion: null
created: 2026-10-17
---

# Unpublish a plugin from the registry

## Problem and user case

A plugin author who published by mistake, published under the wrong slug, or wants to retire a plugin has no way to take it out of the registry with `emdash-plugin`. Today the only route is to delete the package profile record from their atproto repository by hand, with a general-purpose tool such as [PDSls](https://pds.ls/), and to know which collection and record key to pick.

The registry already supports removal. When the aggregator receives the deletion of a `com.emdashcms.experimental.package.profile` record, it marks the package deleted, hides every release of that package, and removes it from the public listings. The CLI only lacks a command that makes that deletion.

## Proposed behavior

`emdash-plugin unpublish` deletes the package profile of one package from the logged-in publisher's repository. Like `update-package`, it is a dry run unless `--yes` is passed:

```sh
emdash-plugin unpublish
emdash-plugin unpublish --yes
```

Without an argument, the command reads the slug from `emdash-plugin.jsonc` (or the file passed with `--manifest`) and applies the same publisher check as `update-package`. With a slug argument, `emdash-plugin unpublish my-old-plugin --yes`, it needs no manifest, so a package published under a slug the manifest no longer uses can still be removed.

The dry run fetches the package profile and prints its AT URI, what unpublishing does, and what it leaves in place. With `--yes`, the command deletes that one record through the existing `PublishingClient.applyWrites` delete operation and prints the URI it deleted. `--json` prints one line, `{"profile": "<uri>", "deleted": true}` (`false` for a dry run), or `{"error": {"code", "message"}}`.

After the aggregator processes the deletion:

- The package no longer appears in registry search, `emdash-plugin info`, the plugins site, or the admin's plugin browser. The plugins site can keep serving a cached page for a few minutes.
- New installs fail, because the install looks the package up in the registry.
- Sites that already installed the plugin keep running their copy, which they load from their own storage. The admin's update check skips the plugin, so no update is offered.
- Release records stay in the publisher's repository and remain publicly readable, and so do the bundles uploaded with them.
- Version numbers already published stay used. Publishing one of them again with a newly built bundle, even with `publish --allow-overwrite`, does not bring it back, so a re-publish needs a new version.

The dry run and `--yes` both say each of these, so the author knows that unpublishing hides the package and does not erase it.

## Re-publishing after an unpublish

Running `emdash-plugin publish` for the same slug later creates a new package profile from the manifest and publishes the release in the same write. The aggregator clears the deleted mark, and the new release goes through the same listing checks as any other release.

The version numbers already used stay used. Their release records are still in the repository, so `publish` refuses an existing version with `RELEASE_ALREADY_PUBLISHED`, as it does today. `publish --allow-overwrite` can rewrite such a record, but the aggregator rejects changed content for a version it has already indexed, and that version stays hidden. Re-publishing therefore needs a new version.

Versions published before the unpublish stay hidden after a re-publish. The aggregator shows such a release again only when it reads the release record anew, which an operator backfill of the publisher does. Restoring them automatically when a package profile is re-created changes the aggregator and is outside this plan.

The package profile also holds the release settings that `emdash-plugin profile setup` stores, such as the approvers for automated releases and whether every release must carry provenance. While the package profile is missing, the release service refuses the package's automated releases with `PACKAGE_PROFILE_REQUIRED`. A profile that `publish` creates again does not carry those settings, so `profile setup` has to run again. It defaults to `--provenance required`, so when the fetched profile has release settings, the dry run and `--yes` both say so and name the flag with the package's earlier value: `required` when every release had to carry provenance, `optional` otherwise.

## Goals

- Remove a package from the registry with one CLI command, without knowing atproto collections or record keys.
- Show what will be removed before anything is deleted.
- Keep version numbers immutable across an unpublish and a later re-publish.
- Tell the author what stays in place: installed copies, release records, bundles, and used version numbers.

## Non-goals

- Hiding a single version. The aggregator already handles a deleted release record, but deleting release records takes away the check that keeps `publish` from reusing a version number. A per-version command needs its own plan.
- Deleting release records or bundles from the publisher's repository.
- Showing versions published before an unpublish again after a re-publish.
- Removing the plugin from sites that installed it. Removing an installed plugin from a site through a CLI is the idea in [#3999](https://github.com/emdash-cms/emdash/discussions/3999).
- Any change to the aggregator, the lexicons, or `@emdash-cms/registry-client`.

## Interfaces and compatibility

The plan adds one command to `@emdash-cms/plugin-cli`: `emdash-plugin unpublish [slug] [--manifest <path>] [--yes] [--json]`. Existing commands, the programmatic API, the lexicons, and the aggregator stay unchanged, and nothing is migrated.

The login scope already covers the deletion. The CLI requests `repo:<nsid>` for every registry record type without an `action` limit, and the [atproto permission spec](https://atproto.com/specs/permission) allows create, update, and delete when `action` is not set. Existing logins therefore work without a new consent screen.

## Errors and edge cases

- No package profile with that slug in the logged-in account: `PACKAGE_NOT_FOUND`, and nothing is written. Running `unpublish --yes` twice reports this on the second run.
- A slug argument that is not a valid plugin slug: `INVALID_INPUT` before any network request.
- A manifest that names a different publisher than the logged-in account: the error `update-package` reports today.
- Not logged in, or an expired session: the existing login errors.
- The delete takes no record precondition, unlike the `update-package` write. A profile changed between the read and the delete is still deleted, which is the requested outcome.

## Verification

Tests in `packages/plugin-cli/tests/`, using the existing mock PDS:

- The dry run writes nothing and prints the package profile URI.
- The dry run and `--yes` both say that used version numbers stay used, even with `--allow-overwrite`.
- `--yes` deletes the package profile and leaves every release record in place.
- A missing package profile returns `PACKAGE_NOT_FOUND` and writes nothing.
- A slug argument works without a manifest, and an invalid slug fails before any request.
- `--json` returns the documented success and error shapes.
- After an unpublish, `publish` of a new version recreates the package profile, and `publish` of an existing version still fails with `RELEASE_ALREADY_PUBLISHED`.

Manual check against a real PDS and the production registry, with a throwaway package: publish it, run `unpublish --yes` with an existing login, confirm that `emdash-plugin info` and `search` no longer find it, publish a new version, and confirm that the listing shows only the new version once it reappears.

The implementation PR also adds the command to the `emdash-plugin` README, documents it on the CLI reference page next to `update-package`, and adds a minor changeset for `@emdash-cms/plugin-cli`.
