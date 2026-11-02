---
"emdash": patch
---

Fixes WordPress menu links to custom post type entries disappearing from the site after an import through the EmDash Exporter plugin. Imported menu items now link to the collection the content was imported into.

#### What should I do?

Menus imported before this release are not repaired. Links to post types with a hyphen in their name, such as `team-member`, and to post types the import renames, such as `event`, `faq` and `testimonial`, can be missing from the site, together with their submenu items. If you imported through the exporter API (`/_emdash/api/import/wordpress-plugin/execute`) with your own `postTypeMappings`, links to any post type you mapped to a different collection can be missing too, `post` and `page` included.

In the menu editor, an affected link's badge names a collection your content isn't in, such as `team-member` instead of `team_member`. Add each affected link again with **Add Content**. Deleting a link also deletes its submenu items, so first make the new link the **Parent** of the old link's submenu items. Then delete the old link.
