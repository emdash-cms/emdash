---
"@emdash-cms/admin": minor
---

The registry plugin detail page now surfaces a plugin's long-form profile sections. Publishers' `description`, `installation`, `faq`, `changelog`, and `security` sections render as sanitized Markdown (the shared audited `renderMarkdown` — raw HTML, scripts, and images stripped, https-only links) in a tabbed view below the install action, with one tab per non-empty section. The page also shows an SBOM badge with the document format and a guarded direct download link (rendered only for safe http(s) URLs), the publisher-asserted `lastUpdated` time labelled distinctly from the aggregator's `indexedAt`, and an accessible tooltip on the verified-publisher shield naming the labeller DID that issued the verification.
