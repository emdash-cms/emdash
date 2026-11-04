# Sandbox boundaries

Registry plugins run against a capability-gated host API, not the complete trusted EmDash runtime. Design within exported authoring types and do not infer an API from internal repositories or admin routes.

## Transport limits

- `ctx.http.fetch()` preserves binary requests and responses across both runners, but complete bodies are buffered and limited to 8 MiB of decoded bytes.
- Declared plugin route bodies are buffered with a 1 MiB default and 8 MiB author maximum. Raw route responses are buffered to 8 MiB.
- Media byte reads default to 10 MiB and cannot request more than 16 MiB.
- Neither test host reproduces deployed CPU, memory, or subrequest limits.

## Trusted-only surfaces

- `page:fragments` is accepted by shared authoring types but excluded from sandbox registration. Use validated `page:metadata`; raw HTML, scripts, and styles require a trusted native plugin.
- React admin code, Astro render components, build-time integrations, host bindings, Node built-ins, TCP sockets, and direct database access require trusted site code.
- Custom Portable Text definitions and Astro renderers remain native-only. Registry packages can use the declarative admin surfaces that the CLI serializes.

## Content and schema limits

- Schema access is read-only. Plugins cannot create, alter, attach, or delete collection definitions through `ctx.schema`.
- Content writes do not expose permanent deletion.
- Publication policy hooks can reject publish, schedule, and unpublish, but cannot transform the action or restore content.
- Publication and restore actions require separate capabilities and opaque revisions.
- Public URL resolution never returns previews.

## Taxonomy, redirect, comment, and media limits

- Taxonomy writes cannot manage definitions, attachments, term updates or deletion, or replace all assignments.
- Redirect writes cannot set host-owned fields and remain subject to host validation.
- Comment administration excludes trashed comments and linked user-account IDs. It cannot hard-delete or bulk-replace statuses.
- Media metadata writes cannot upload, replace, move, or delete files. Byte reads and content hashes require separate authority.

## Routes and admin UI

- `public: true` removes host authentication. It does not create a restricted public view; validate requests and return the minimum data.
- Raw routes use `pluginResponse()`, an allowlisted set of representation/download/redirect headers, host-owned caching and security headers, and no active same-origin browser content. They cannot back MCP tools.
- Credential, cookie, Cloudflare Access, proxy authorization, and EmDash CSRF headers never cross declared route-header boundaries.
- Saved-entry panels and actions receive canonical saved identity and version. Ordinary panel load and typing never send unsaved state. An explicit interaction can receive only extension-selected draft fields with `admin.editor-draft:read`, and can propose an atomic whole-field patch with the independent `admin.editor-draft:patch` capability. The host validates and previews a patch but never saves it automatically. Use capability-gated APIs to read saved content.
- `routeCtx.ui` carries host-attested admin locale, direction, and surface. Manifest labels remain static strings; the host does not consume plugin translation catalogs.

## Runner-only methods are not portable

Methods absent from public authoring types are not part of the registry contract even if one wrapper contains them. Write against `SandboxedPlugin` and exported context types, then test the feature through both bridges when behavior is runner-sensitive.
