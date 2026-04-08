---
"emdash": patch
---

Sanitize WordPress post type slugs during import. Fixes crashes when importing sites using plugins (Elementor, WooCommerce, ACF, etc.) that register post types with hyphens, uppercase letters, or other characters invalid in EmDash collection slugs. Reserved collection slugs are prefixed with `wp_` to avoid conflicts.
