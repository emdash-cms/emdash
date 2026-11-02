---
"emdash": patch
---

Fixes WordPress menu links to custom post type entries disappearing from the site after an import through the EmDash Exporter plugin. Imported menu items now link to the collection the content was imported into.

#### What should I do?

Menus imported before this release are not repaired. Links to post types with a hyphen in their name, such as `team-member`, and to post types the import renames, such as `event`, `faq` and `testimonial`, can be missing from the site. In the menu editor, delete each missing link and add it again.
