---
title: Set reference fields through the MCP content tools
type: feature-plan
status: proposed
authors:
  - Itai Ben Zeev (@itaides)
discussion: https://github.com/emdash-cms/emdash/discussions/3598
created: 2026-10-26
---

# Set reference fields through the MCP content tools

## Problem and user case

Since 1.0 a `reference` field bound to a relation has no column; its links are rows in `_emdash_content_references`. `handleContentCreate` and `handleContentUpdate` therefore take them under a separate `references: Record<string, string[]>` key, and refuse them inside `data` ("Reference fields bound to a relation are set through 'references', not 'data'").

The MCP tools `content_create` and `content_update` call those handlers but have no `references` argument and never forward one. An agent writing through MCP can fill every field except a relation, and a person has to finish each entry in the admin.

On our site the owner writes posts from Claude and ChatGPT through MCP. Every one of them needs its region set afterwards in the admin, because region is a relation.

## Proposed behavior

`content_create` and `content_update` accept an optional `references` argument, with the same shape and meaning as the REST API's:

```json
{
	"collection": "routes",
	"data": { "title": "עין חניה" },
	"references": { "region": ["01J…"] }
}
```

- On create, each listed field gets exactly those targets, in that order.
- On update, a listed field is replaced with exactly those targets, `[]` clears it, and an omitted field is left unchanged. That's the same contract as `taxonomies` ("Missing keys leave that taxonomy unchanged").
- The tool descriptions say that a relation-bound reference field goes in `references`, not `data`.
- `schema_get_collection` already returns each field with its `validation`, which names the bound relation. It should also state, in a form an agent can act on, the target collection and the relation's limits (`maxChildrenPerParent`, `maxParentsPerChild`), so the agent knows what to look up and how many it may set.

## Goals

- An agent can create or edit an entry with its relations in one MCP call.
- MCP writes go through exactly the validation REST writes get (`validate-references`): the target exists, it is in the relation's collection, and the relation's limits hold.
- An error names the field and the reason, in the same words the REST API uses.

## Non-goals

- References in listings (`getEmDashCollection`): design PR #4100.
- Filtering `content_list` by a reference.
- Creating or changing relations themselves through MCP.
- Reference fields that are not bound to a relation keep their column and stay in `data`.

## Interfaces and compatibility

- MCP: a new optional `references` argument on `content_create` and `content_update`, plus extra keys on relation-bound fields in `schema_get_collection` output.
- No change to REST, stored data or the handlers' signatures, which already take `references`.
- Additive: a client that never sends `references` sees no difference.

## Errors and edge cases

- A key that isn't a relation-bound reference field of the collection: validation error naming it.
- An id that doesn't exist or belongs to another collection: the same error the REST path returns, and nothing is written.
- More targets than `maxChildrenPerParent`: refused, not truncated.
- The same field in both `data` and `references`: the existing `data` refusal applies, unchanged.
- Locale: targets are entry ids, resolved as the REST path resolves them. Which translation of a target is linked follows the existing translation-group rule.
- Drafts: on an entry with a pending draft, the update stages the references with the draft, as the REST update does (`staged-references`).

## Verification

- MCP integration tests: create with references, update with replace / clear / omit, and each refusal above, asserting the same rows in `_emdash_content_references` as the equivalent REST request.
- `schema_get_collection` output for a collection with a relation-bound field.
- A test that an MCP client sending `references` to a field that is not relation-bound gets the error, not a silent drop.

## Open questions

- Should `content_get` return `references` by default, so an agent can read back what it set, or only on request?
- Should MCP check that the token may read each target entry? The REST write path is the reference here, and the MCP path should match it, whatever it does.
