# Security Policy

EmDash is a beta CMS with authentication, content management, plugin execution, and Cloudflare/Node deployment surfaces. Please report suspected vulnerabilities privately so maintainers can triage and coordinate a fix before public disclosure.

## Supported Versions

EmDash is currently in beta preview. Security reports should target the current `main` branch and the latest published `emdash` / `@emdash-cms/*` packages unless maintainers document additional supported release lines.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting flow for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include enough detail for maintainers to reproduce and assess the issue.

If you already submitted a private GitHub security advisory, keep follow-up discussion in that advisory thread. Avoid opening public issues for exploitable details; a public issue may be used only to ask for routing or status without sharing sensitive technical information.

## What to Include

Please include:

- affected package, template, demo, or deployment mode;
- affected version, commit, or configuration;
- clear reproduction steps or a minimal proof of concept;
- expected impact and any privilege or authentication requirements;
- whether the issue affects Cloudflare Workers/D1/R2, Node/SQLite, the admin UI, authentication, media storage, API routes, or plugin sandboxing;
- any relevant logs, screenshots, request/response snippets, or stack traces with secrets redacted.

## Scope Guidance

High-signal reports may include issues such as:

- authentication or authorization bypasses;
- privilege escalation in the admin UI or API;
- access to unpublished or private content;
- unsafe plugin sandbox escapes or excessive plugin capabilities;
- SQL injection, stored cross-site scripting, or server-side request forgery;
- insecure media upload, storage, or signed URL handling;
- migration, import, or setup flows that expose sensitive data;
- supply-chain or template defaults that create a realistic unsafe deployment.

Lower-signal or usually out-of-scope reports include:

- scanner output without a working reproduction;
- issues requiring access to a maintainer account, compromised machine, or intentionally unsafe local configuration;
- denial-of-service reports without a realistic impact path;
- missing security headers on local demos unless they affect production defaults;
- version disclosure, dependency age, or best-practice suggestions without exploitability;
- social engineering, spam, phishing, or physical attacks.

## Coordinated Disclosure

Maintainers should acknowledge valid-looking reports as soon as practical, triage severity, and keep the reporter updated while a fix is prepared. Please do not publicly disclose details until maintainers have had a reasonable opportunity to investigate, patch, and publish upgrade guidance.

## Safe Harbor

Good-faith research is welcome when it stays within the bounds of the repository, your own deployments, or explicitly authorized test environments. Do not access, modify, delete, or exfiltrate other users' data; do not disrupt live services; and stop testing if you encounter sensitive information.
