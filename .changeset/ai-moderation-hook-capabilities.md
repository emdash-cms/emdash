---
"@emdash-cms/plugin-ai-moderation": patch
---

Fixes the AI moderation plugin never moderating comments. The plugin now declares `users:read`, so EmDash no longer skips its `comment:beforeCreate` and `comment:moderate` hooks at startup with a `without users:read capability — skipping` warning. Upgrade `emdash` in the same step: with the matching release, AI moderation replaces the built-in moderator on a site that has no stored moderator choice, while an earlier `emdash` selects neither and holds every new comment for review.

When AI moderation decides, **Auto-approve clean comments** is on by default, so comments that Llama Guard rates clean are approved even on collections that hold comments for review. Comments from logged-in CMS users are approved even when the collection's **Auto-approve authenticated users** setting is off. To fall back to each collection's moderation setting for clean comments, turn **Auto-approve clean comments** off on the plugin's AI Moderation settings page.

A site that stored the built-in moderator as its choice under an earlier release keeps it. Until the plugin is disabled or AI moderation is selected, the plugin still sends each new comment to Workers AI and records the result in the comment's moderation metadata, while the built-in moderator decides the comment's status.
