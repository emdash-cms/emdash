# Moderation model

This is the reference for the labeler's label vocabulary and how active labels evaluate into an eligibility decision. It is what a `queryLabels` consumer needs to act on the labels correctly, and what an operator needs to understand which action produces which effect. For the console workflows that issue these labels, see [operating.md](operating.md); for the ATProto label and subject concepts, see [atproto.md](atproto.md).

## Structure

Labels are grouped into categories. Each label carries:

- an **effect** — `pass`, `block`, `warn`, `pending`, `error`, or `redact`;
- a **subject scope** — release, package, or publisher;
- a **`cidRule`** — `required` (targets one exact release CID), `forbidden` (URI-wide, whole record or publisher), or `optional` (either); and
- **issuance modes** — who may issue it: `automated`, `reviewer`, or `admin`.

The policy document is served publicly at `/.well-known/emdash-labeler-policy.json`. The current `policyVersion` is `2026-07-15.experimental.1`.

## Vocabulary

| Label                        | Category        | Effect  | Subject → cidRule                         | Who issues          |
| ---------------------------- | --------------- | ------- | ----------------------------------------- | ------------------- |
| `assessment-passed`          | eligibility     | pass    | release → required                        | automated, reviewer |
| `assessment-overridden`      | eligibility     | pass    | release → required                        | reviewer            |
| `assessment-pending`         | eligibility     | pending | release → required                        | automated           |
| `assessment-error`           | eligibility     | error   | release → required                        | automated           |
| `malware`                    | automated-block | block   | release → required                        | automated, reviewer |
| `data-exfiltration`          | automated-block | block   | release → required                        | automated, reviewer |
| `credential-harvesting`      | automated-block | block   | release → required                        | automated, reviewer |
| `supply-chain-compromise`    | automated-block | block   | release → required                        | automated, reviewer |
| `critical-vulnerability`     | automated-block | block   | release → required                        | automated, reviewer |
| `artifact-integrity-failure` | automated-block | block   | release → required                        | automated, reviewer |
| `invalid-bundle`             | automated-block | block   | release → required                        | automated, reviewer |
| `undeclared-access`          | automated-block | block   | release → required                        | automated, reviewer |
| `impersonation`              | automated-block | block   | release → required                        | automated, reviewer |
| `hateful-imagery`            | automated-block | block   | release → required                        | automated, reviewer |
| `explicit-imagery`           | automated-block | block   | release → required                        | automated, reviewer |
| `graphic-violence`           | automated-block | block   | release → required                        | automated, reviewer |
| `suspicious-code`            | warning         | warn    | release → required                        | automated, reviewer |
| `obfuscated-code`            | warning         | warn    | release → required                        | automated, reviewer |
| `privacy-risk`               | warning         | warn    | release → required                        | automated, reviewer |
| `misleading-metadata`        | warning         | warn    | release → required                        | automated, reviewer |
| `low-quality`                | warning         | warn    | release → required                        | automated, reviewer |
| `broken-release`             | warning         | warn    | release → required                        | automated, reviewer |
| `content-warning`            | warning         | warn    | release → required                        | automated, reviewer |
| `!takedown`                  | manual-system   | redact  | release / package / publisher → forbidden | admin               |
| `security-yanked`            | manual-system   | block   | release → forbidden                       | reviewer            |
| `publisher-compromised`      | manual-system   | block   | publisher → forbidden                     | admin               |
| `package-disputed`           | manual-system   | warn    | package → optional                        | reviewer            |

Notes:

- The **eligibility** labels are automation-issued, except the override pair (`assessment-overridden`, and the reviewer half of `assessment-passed`), which is reviewer-only. `assessment-pending` gates a release until it resolves; `assessment-error` marks a pipeline failure after bounded retries.
- The **automated-block** and **warning** labels each carry _both_ `automated` and `reviewer` issuance modes, so a reviewer may also apply any of them by hand — always CID-bound to one release.
- **`!takedown`** is the strongest action: it redacts the subject, and applies to a release, package, or publisher.

## Eligibility evaluation

A consumer overlays a release's active labels into one overall state: **eligible**, **pending**, **error**, or **blocked** (plus redaction). This is what `queryLabels` consumers act on. The rules:

- Any active **block** (automated or manual) makes the release **blocked**.
- An active **pending** makes it **pending**.
- An active **error** surfaces as **error**.
- The **pass + override** pair suppresses the current automated blocks _and_ future ones for that release — override permanence — so a re-assessment cannot silently re-block an overridden release.
- **Warnings never block.** A release can be eligible and still carry warning labels; they are advisory.
- A **`!takedown`** redacts the subject regardless of its other labels.

The policy's precedence order (highest first) is: manual block, label-state collision, assessment error, assessment pending, automated block, missing assessment pass, then eligible.

### How automated findings become block or warning labels

Not every finding on a block category blocks. The resolver applies a severity gate by finding source:

- A **deterministic** or **capability** finding (a tool result, not a model judgment) on a block category blocks at **any** severity.
- A **model or image** finding on a block category blocks only at **`high`** or **`critical`** severity — the resolver distrusts sub-threshold model severity calibration.
- A model or image block-category finding **below `high` is never dropped**: it degrades to a warning label so the concern stays visible. Code-lane concerns degrade to `suspicious-code`; the image-content categories (`hateful-imagery`, `explicit-imagery`, `graphic-violence`) degrade to `content-warning`. The degraded warning keeps the original block category as its finding association.

The three image-content categories are `automated`-issuable block labels; `content-warning` is their sub-threshold warning counterpart.

## The §10 rule

Automation can never negate a human decision. Any manually issued label — a takedown, an override, a reviewer label — is **human-retract-only**. Re-assessment and the automated pipeline cannot pull a human's label; only an operator can. This is why an override is permanent in effect: once a reviewer has passed a release, automation is not allowed to re-block it.

## No cascade

A takedown (or block) on a publisher or package is a single URI-wide or DID-wide label that the evaluator honors for everything beneath it. It is **not** fanned out into per-release labels. One subject, one label; the evaluation walks up to the covering subject rather than expecting a copy on every release underneath.
