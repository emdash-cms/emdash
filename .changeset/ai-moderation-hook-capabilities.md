---
"@emdash-cms/plugin-ai-moderation": patch
---

Fixes the AI moderation plugin's `comment:beforeCreate` and `comment:moderate` hooks being skipped at startup with a `without users:read capability — skipping` warning, so no comment reached Workers AI. The plugin now declares `users:read`. Upgrade `emdash` in the same step.

A site that ran the plugin under an earlier release has the built-in moderator stored as its moderator choice, because the skipped hooks left the built-in moderator as the only one, and it keeps that choice. On such a site the plugin now sends each new comment to Workers AI and records the result in the comment's moderation metadata, while the built-in moderator still decides the comment's status. This continues until the plugin is disabled or AI moderation is selected as the moderator.

On a site with no stored moderator choice, AI moderation replaces the built-in moderator. An earlier `emdash` selects neither there and holds every new comment for review.

When AI moderation decides, **Auto-approve clean comments** is on by default, so comments that Llama Guard rates clean are approved even on collections that hold comments for review. Comments from logged-in CMS users are approved even when the collection's **Auto-approve authenticated users** setting is off. To fall back to each collection's moderation setting for clean comments, turn **Auto-approve clean comments** off on the plugin's AI Moderation settings page.
