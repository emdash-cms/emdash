# Multi-site hosting with a central admin

## Problem Statement

An EmDash deployment currently serves one site. Hosting several low-traffic sites as separate deployments wastes memory and requires staff to sign in and manage access separately. The operator needs two independent public sites, one central admin, and site-specific permissions without a separate Node process for each site.

## Solution

One Node process, behind Caddy, serves two sites from separate trusted Astro builds. Both sites use one PostgreSQL database and the same collection definitions. Every site-owned record belongs to an immutable site ID. Public domains serve their site's published content; the admin area at `admin.example.com` hosts Clerk sign-in, the site switcher, system management, and restricted staging previews. A super admin creates sites and controls deployments. Site admins manage content and memberships for their own site.

## User Stories

1. As a visitor, I want to read Foo at its public hostname without an account, so that its content remains open.
2. As a visitor, I want to read Bar at its public hostname, so that Bar's content does not appear on Foo.
3. As a visitor, I want a site's public media and required public API routes to work on its hostname, so that its pages render correctly.
4. As a visitor, I want my site's subdomain to work before it has a custom domain, so that the site can launch without one.
5. As a visitor, I want a verified custom domain to become canonical, so that links resolve to the site's chosen address.
6. As a visitor, I want the site's subdomain to redirect after the custom domain becomes canonical, so that old links keep working.
7. As a staff member, I want to sign in through Clerk in the admin area at `admin.example.com`, so that EmDash does not manage my credentials.
8. As an invited staff member, I want my verified Clerk identity to accept a role on one site, so that the invitation cannot grant access to another person.
9. As a staff member with one membership, I want to open that site's admin directly, so that I do not choose from a redundant list.
10. As a staff member with several memberships, I want to return to my last accessible site, so that I can resume work.
11. As a staff member with several memberships but no accessible last site, I want a site list, so that I can select where to work.
12. As a staff member with no memberships, I want a clear no-access page, so that I do not see a site's data.
13. As a Foo editor who also edits Bar, I want to switch sites in the admin menu without signing in again, so that each admin view has one clear site context.
14. As a Foo editor, I want `foo.com/admin` to send me to Foo's admin area at `admin.example.com`, so that the public domain remains easy to use.
15. As a Foo editor, I want my role on Foo to differ from my role on Bar, so that permissions reflect each site's needs.
16. As a Foo editor, I want requests for Bar to fail if I have no Bar membership, even if I change the site in the URL or an API request, so that I cannot access Bar's private data.
17. As a Foo editor whose membership is removed, I want the next protected request to deny access, so that revoked permissions take effect without another login.
18. As a Foo site admin, I want to invite staff to Foo with an existing EmDash role, so that I can manage Foo's team without granting system-wide access.
19. As a Foo site admin, I want to manage Foo's settings and content without changing Bar, so that routine work stays within my site.
20. As a site member, I want to view my site's restricted staging presentation in the admin area at `admin.example.com`, so that I can review a new theme against live published content.
21. As an editor, I want to use an explicit authenticated draft-preview flow, so that staging does not expose drafts by default.
22. As a super admin, I want to create a site from the starter presentation and seed, so that the new site starts with its own content and settings.
23. As a super admin, I want collection types and fields to remain shared, so that all sites use the same content structure.
24. As a super admin, I want to assign an installed Astro build to one site and replace it after staging, so that I can change its presentation without moving content.
25. As a super admin, I want to verify a custom domain before activating it, so that unverified hostnames cannot claim a site.
26. As a super admin, I want to disable a site and later purge it explicitly, so that removal is recoverable and does not delete another site's data.
27. As an operator, I want two sites served by one Node process, so that hosting does not require a CMS process per site.
28. As an operator, I want public blogs to keep working when Clerk verification is unavailable, while admin and staging deny access, so that an identity outage does not expose protected pages.
29. As an operator, I want to measure Caddy and the warmed Node process after public, admin, and staging visits, so that I can evaluate the later ten-site, approximately 1 GB RAM goal.

## Implementation Decisions

- The first multi-site deployment is greenfield: no existing Astro site or user needs to be moved into its Node.js and PostgreSQL host. Existing EmDash database rows still need forward-only migrations. Backfill site-owned rows to the default site's ID before making site ownership required. Site-owned columns have no database default: new writes must supply a site ID, and unscoped writes fail. Existing `site-default` column defaults must be removed through new forward-only migrations; published migrations remain unchanged. Bun, SQLite, and Cloudflare multi-site deployments are not targets.
- One Node process serves separate trusted Astro builds. Site admins cannot upload server-side code. A super admin deploys and selects installed site presentations; controlled Node restarts activate new builds. The design must verify that serving two builds in one process is feasible before relying on a ten-site memory projection.
- Create an immutable site identity and a registry of site slugs, hostnames, presentation assignments, state, and memberships. A slug or domain change does not reassign content, roles, or audit history.
- PostgreSQL holds one shared set of collection and field definitions. Existing content tables and all other site-owned records, including settings, media, menus, taxonomies, drafts, revisions, and operational records, are isolated by site ID. Identity and membership records are system-wide. Revisit unique constraints, references, caches, jobs, search, seed and transfer workflows, and media paths so they cannot cross site boundaries. Existing installation-wide site identity assumptions cannot serve as per-site identity.
- Provision collection definitions once. On site creation, apply only that site's starter entries, settings, and other site-owned seed data. Only a super admin changes shared collection definitions.
- The Node host resolves public hostnames against active site registrations before selecting an Astro build. It passes the resolved site ID to EmDash through server-side request context. Core accepts that ID without repeating the hostname lookup; it never selects a site from a client-supplied ID or forwarded header. Reject unknown or conflicting hostnames, and deny site-owned operations when the request has no resolved site, even if only one site exists. Public endpoints use the same site as the page request. Keep authentication, admin, system, and membership routes on the admin area's hostname.
- A new site gets a site subdomain, such as `foo.example.com`, distinct from the admin area's hostname. A super admin alone may register a custom domain. Verify ownership and routing before enabling Caddy routing or certificate issuance. The custom domain becomes canonical; the site subdomain redirects to it. Public-domain `/admin` redirects to the matching site view in the admin area. Preserve `/_emdash/admin` while exposing `/admin` as a compatible redirect on the admin area's hostname.
- Put the selected site in the central admin URL. A public hostname cannot select a site for the central admin. After login, show a no-access page for zero memberships, enter the site directly for one membership, or show a site list on the first visit for several memberships. On later visits with several memberships, enter the last still-accessible site; if that site is no longer accessible, show the site list. The switcher lists only accessible sites; a super admin may select any site. The server resolves and authorizes site context for every protected request, regardless of the URL or client state. Until site selection and membership enforcement are available, unscoped central-admin settings requests fail closed.
- Keep existing site role levels and permissions as site memberships. Site admins can manage memberships within their own site. Invitations target one site, one role, and a verified email address; unused invitations expire. Restrict staff enrollment to invitations. Super-admin status is system-wide, not a site membership; the backend checks the backend-controlled Clerk metadata flag `is_super_admin` for privileged requests. A super admin acts under their own identity and site context, with attributable actions. A missing or unverifiable Clerk authorization denies admin and staging access, not public reading.
- Staging has no separate domain or content database. Restrict `admin.example.com/preview/{site}/...` to site members and super admins. Render the site's staging presentation against its published content; use the existing explicit draft-preview flow for drafts. Prevent staging pages and assets from becoming public through alternate paths or caches.
- Disabling a site removes public routing and admin access while retaining its records. Permanent purge is a separate privileged action that removes only that site's data. Hostname reuse, purge confirmation, and failure recovery must preserve other sites.
- Site settings, including public title, URL, branding, display preferences, and SEO defaults, use `options` with `name` as the primary key. Store site-owned keys as `site:{site_id}:{key}` (for example, `site:foo:title` and `site:bar:title`) with a non-null `site_id`. Do not add a `(site_id, name)` unique index; the primary key on `name` already prevents duplicate keys. Migrate existing `site:{key}` names to `site:site-default:{key}` and backfill their site IDs explicitly, never with a column default. Installation-wide options, including plugin settings, have a null `site_id` and remain shared with one value per key. Site-facing identity reads use `site:*` as their source of truth rather than the older `emdash:site_*` setup values. CLI commands, seeds, and jobs must specify a site ID when handling site-owned settings.
- Plugins, comments, and reader authentication are not part of this deployment. The shared host must not expose plugin routes or comment endpoints as a side effect of public routing.

## Testing Decisions

- Prefer one high-level test seam: real HTTP through Caddy to the one-process Node host and a real PostgreSQL database with two distinct site builds. Exercise public host routing, redirects, central Clerk login with controlled verification, site selection, staging, creation, membership changes, and denial on tampered site IDs. Check visible content and HTTP results rather than internal query calls or implementation structure.
- Supplement that seam with real-PostgreSQL integration tests where the HTTP matrix would be too slow or incomplete. Cover site-scoped reads and writes across content, schema metadata, settings, media, menus, drafts, background jobs, and deletion; confirm unique slugs and references are scoped to the correct site. For site settings, test migration retries, Foo and Bar using the same key, cache isolation on cold and warm public requests, and denial without site context. Central admin editing waits for site selection and membership enforcement. Follow existing PostgreSQL integration-test patterns and the current API authorization tests.
- Use deterministic Clerk verification fixtures at the server boundary, not a mocked authorization decision. Test verified and unverified invitation email, site-role differences, removed memberships, changed or removed super-admin metadata, expired invitations, and Clerk outages. Run a manual Clerk deployment check before release.
- Keep CI independent of live Clerk and Google. At the server verification boundary, use locally signed session fixtures and exercise valid, invalid, expired, and unverifiable credentials without mocking an authorization decision. In the development Clerk instance at `https://alive-ant-9058.accounts.dev/`, use the password-based test accounts `editor+clerk_test@test.com` and `admin+clerk_test@test.com` for live browser sign-in and logout checks. The latter has super-admin metadata. Both development test accounts currently use the password `1234`; never reuse it outside this disposable development instance. Do not commit Clerk keys. These accounts alone grant no site membership. The `+clerk_test` suffix marks test email addresses; Clerk's `424242` code applies to email or phone verification, not password sign-in.
- Extend existing Playwright auth, invite, admin, and content journeys for two public hostnames and the central admin. Test redirect context, switcher state, no-membership state, draft versus published staging content, denied cross-site media/API access, and browser back/forward behavior. Test the admin in Arabic for right-to-left layout.
- Add regressions for host spoofing, unverified custom-domain takeover, cache mixing, media paths, and unknown site IDs. Anonymous public route query count must not rise without explicit justification.
- Measure process-resident memory for Node and Caddy after visiting both sites' public pages, admin, and staging presentations. Repeat the same warm-visit method at ten sites later. The later target is approximately 1 GB for Node plus Caddy, excluding PostgreSQL; the two-site milestone does not establish that target by itself.

## Out of Scope

- Moving an existing Astro site or its users into the new multi-site Node host. Forward-only database backfills for existing site-owned records remain in scope.
- Bun, SQLite, Cloudflare Workers, a production-ready ten-site deployment, and a ten-site RAM guarantee in the two-site milestone.
- Independent site collection schemas, isolated staging content, staging subdomains, user-uploaded Astro code, and runtime deployment of server code from the admin.
- Plugins, comments, reader accounts, and private public content.

## Further Notes

The core risk is not the site switcher. Current EmDash assumes one installation-wide site identity and one database-wide collection registry, with dynamically created content tables and runtime caches. Shared PostgreSQL rows require site-aware constraints and query boundaries throughout those surfaces. Separate Astro builds in one process also require a measured host prototype before predicting ten-site memory use. In particular, untrusted site code cannot be isolated safely inside that same Node process; only super-admin-controlled builds are allowed.

The new multi-site host has no existing Astro sites or users to migrate. Database schema changes still preserve existing EmDash rows through forward-only backfills. Changes to the published EmDash API or upgrade path need a separate compatibility decision before release.
