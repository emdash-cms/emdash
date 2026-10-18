---
"emdash": patch
---

Fixes WordPress menu links to custom post type entries disappearing from the site after an import through the EmDash Exporter plugin. This affected post types with a hyphen in their name, such as `team-member`, and post types the import renames, such as `event`, `faq` and `testimonial`. Imported menu items now link to the collection the content was imported into. Menus imported before this release are not repaired; in the menu editor, delete each affected link and add it again.
