# Taxonomies and redirects

## Taxonomies

`taxonomies:read` exposes taxonomy definitions, terms, and entry assignments. `taxonomies:write` implies read and adds `createTerm()`, `addEntryTerms()`, and `removeEntryTerms()`.

Term assignment methods accept term row IDs or translation-group IDs, not slugs. Add and remove operations apply idempotent deltas rather than replacing the full set, so concurrent additions do not overwrite one another.

The host validates taxonomy attachment, entry and term ownership, configured locales, translation identity, and hierarchy. `createTerm()` rejects a parent for a flat taxonomy. Definition management, attachment changes, assignment replacement, term updates, and term deletion remain unavailable.

## Redirects

`redirects:read` exposes cursor-paged listing and versioned reads. `redirects:write` implies read and adds create, update, and delete.

Pass the opaque redirect `_rev` unchanged to update and delete. A stale revision returns `CONFLICT`; re-read before retrying. Redirect writes use the host's source-pattern, destination-parameter, duplicate-source, status, and loop validation. Plugin input cannot set host-owned fields such as the automatic-rule marker.

Changing redirect rules changes where visitors are sent, so request this capability only when the plugin owns that behavior.

For runtime tests, establish redirect state with fixtures, invoke the plugin through the real route/action boundary, and inspect persisted rules. Cover stale revisions and loop or destination validation when relevant.
