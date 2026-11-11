---
title: Create and edit block types in the admin
type: feature-plan
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
discussion: null
created: 2026-11-11
---

# Create and edit block types in the admin

## Problem and user case

Since 0.40, block types live in the database, with numbered versions. The admin lists them under Content types, but it can't create or change one. When an admin adds a `blocks` field and no block type exists yet, the field settings say "Create a block type before adding a blocks field." Nothing in the admin lets them do that.

`emdash seed` writes to a local SQLite file, so on a D1 site, block types can only be created or changed through the REST API or the MCP server. People moving their sites to EmDash have asked for this on Discord. One of them wrote a build script that pushes block types through the API.

## Proposed behavior

### Block types on the Content types screen

The Block types section on Content types gets a **New block type** button. Each row links to its block type. A block type that came from a seed shows a "From seed" tag.

### Creating a block type

**New block type** opens a page with:

- **Label**, and a **Slug** generated from it. The slug can be edited until the first save.
- **Description**, **Icon** and **Category**. The icon is a Phosphor icon name, as on the content type form, and the page previews it. The picker in the editor already shows all three.
- **Fields**. **Add field** opens the field editor that content types use. It offers only the 13 types a block field supports, and only the settings a block field accepts: required, length limits, pattern, number range, options, list sub-fields and item limits, allowed file types, and the dark variant for images. Unique, searchable, indexed and relation settings don't appear.

Nothing is stored until **Save**. Saving creates version 1, which is active. The page then says that editors can use the block type once it's added to a blocks field, and that the site needs a component for it first.

### Editing a block type

A block type's page shows the same form, filled with the active version's fields. The block type's slug and the slugs of saved fields are read-only, as they are for content types. Fields can be added, edited, removed and reordered.

The page has one **Save** for the whole block type, because its fields belong to one version. What happens next depends on the change:

- **Compatible changes** are saved into the active version. These are the label, description, icon and category, field labels, field order, a new optional field, a field that becomes optional, looser validation, and turning on an image's dark variant.
- **Breaking changes** need a new version. These are a removed field, a changed field type, a field that becomes required, a new required field, tighter validation, a new or changed pattern, and turning off an image's dark variant. The admin shows a dialog that lists each change by the field's label, explains what happens, and asks for confirmation. Confirming creates the new version, inactive.

For example, the Hero block type is on version 2. An admin removes its Subheading field, makes Button link required, and saves. The dialog says:

> Saving creates version 3, which stays inactive. New blocks keep using version 2 until you activate version 3. Versions can't be deleted.
>
> - Subheading: removed
> - Button link: now required

**Create version 3** saves it. **Cancel** goes back to the form with the changes kept. After saving, the page names the version that now holds the changes, which can differ from the dialog's number, and points to its **Activate** button.

### Versions

A **Versions** section lists every version with its number, an "Active" tag, its number of fields and its creation date. Opening a version shows its fields, read-only.

An inactive version has an **Activate** button. Activating, whether to a newer or an older version, asks first:

> Activate version 3 of Hero?
>
> Deploy your site's code for version 3 first. Once it's active, new Hero blocks use version 3. Existing blocks keep the version they were saved with, and the editor marks them "Inactive version".

## Goals

- An admin can create a block type with its fields, without the API.
- An admin can edit a block type. Compatible changes save into the active version. Breaking changes create an inactive version after a confirmation that lists them.
- An admin can see every version and activate one, after a warning that the site's code must support it first.
- The screens use today's permissions. Viewing needs `schema:read` and changes need `schema:manage`, as the block type routes already check. The Content types screen stays in the admin-only part of the sidebar.
- All new text goes through Lingui. The layout is right-to-left safe, works with the keyboard, and works on phone-width touch screens.

## Non-goals

- Syncing block types from a site's seed file, and deciding whether a live site's schema belongs to the seed or to the admin. That needs its own Ideas Discussion.
- Rendering components. They stay in the site's code.
- Moving stored blocks to a new version (`migrateBlocks`). The content editor handles blocks on older versions as it does today.
- Deleting block types or versions. The API has no delete operation for either.
- Editing an inactive version. The API changes only the active version, so a confirmed breaking save never edits an inactive one.
- Editing default values. The field editor has no input for them, and saving keeps any default a field already has.
- Changes to the blocks field settings or the content editor, which the [blocks field redesign](./blocks-field-redesign.md) covers.
- New settings for block fields, such as help text.

## Interfaces and compatibility

None. The screens call the existing routes:

- `GET` and `POST /_emdash/api/schema/block-types`
- `GET` and `PUT /_emdash/api/schema/block-types/{slug}`
- `POST /_emdash/api/schema/block-types/{slug}/versions/{version}/activate`

The admin's API client already has a function for each of them. The server, stored data, configuration and permissions don't change, and no logged-out route gains a query.

The admin finds out whether a change is breaking from the server. A `PUT` without `breaking` saves a compatible change, or refuses a breaking one with `BLOCK_TYPE_BREAKING_CHANGE` and the list of differences. The admin turns that list into the dialog, then repeats the request with `breaking: true` when the admin confirms. The compatibility rules stay in one place, on the server.

The implementation updates the "Change a block schema" steps in the blocks guide to name the admin next to the API and MCP. It ships an `@emdash-cms/admin` changeset.

## Errors and edge cases

- **Changed by someone else.** Every update and activation sends the fingerprint of the active version the page loaded. If someone else changed the active version's fields or activated another version in the meantime, the server refuses with `CONFLICT`. The page keeps the unsaved form and offers to reload the block type. The fingerprint leaves out field labels (but not the labels of list sub-fields), the block type's label, description, icon and category, and inactive versions, so a change to only those doesn't make a later save fail.
- **Slug already taken.** `BLOCK_TYPE_EXISTS` on create shows an error under the slug. Invalid and reserved slugs show their error there too.
- **Unknown field types.** A version saved by a newer EmDash release can contain field types this release doesn't know. If the active version has one, the server refuses to update the block type with `UNSUPPORTED_FIELD_TYPE`, so its page opens read-only with a notice, and **Activate** is disabled for versions that contain an unknown type, which the server refuses as well.
- **Block types from a seed** can be edited like any other. Their page notes that applying the seed again with `--on-conflict update` replaces the label, description, icon and category, rewrites the versions the seed declares, and sets the active version back to the seed's. If an edit here made one of those versions accept more, such as a new field or looser validation, that seed run stops with `BLOCK_TYPE_VERSION_CONFLICT` instead.
- **Renaming a field** means removing it and adding a new one, because stored values are matched by slug. The confirmation dialog lists that as a breaking change.
- **A second breaking save before activation** creates another version. The confirmation dialog names the version number it will create. If the new fields exactly match an existing inactive version, the server keeps that version instead of creating one.
- **Unsaved changes.** Leaving the page or closing the tab with unsaved changes asks first.

## Verification

Admin component tests:

- Creating a block type sends its fields and opens the new block type's page.
- A compatible change sends one `PUT` without `breaking` and stays on version 1.
- A `BLOCK_TYPE_BREAKING_CHANGE` response opens the dialog with one line per difference, named by field label. Confirming repeats the `PUT` with `breaking: true`, and cancelling sends nothing.
- **Activate** sends the active version's fingerprint, after the warning.
- A `CONFLICT` response keeps the form's changes.
- A block type whose active version has an unknown field type opens read-only.
- Saving keeps a field's existing default value.

Browser test: create a block type with a required string field and a list, add it to a blocks field and add a block to an entry. Then remove a field, confirm the new version, activate it and add a second block. The new block uses version 2, and the first block shows "Inactive version".

Manual: the screens on desktop and on a phone-width touch screen, in English and in Arabic.

## Open questions

- **The new block type page's address.** The proposal uses `/content-types/block-types/new`, next to `/content-types/relations`. A block type whose slug is `new` would then have no page of its own. Content types already have the same gap at `/content-types/new`. The form could refuse `new` as a slug without a server change, or core could reserve it, as it reserves `relations` for collections. The recommendation is the form-only check: it changes no API, and a block type named `new` can still be managed through the API.
