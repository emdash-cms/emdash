---
"@emdash-cms/admin": patch
---

Wraps all user-visible strings in the admin shell and core content screens with Lingui macros so they are translatable. Covers: Sidebar (nav labels, group headings), Header (View Site, Log out, Settings), ThemeToggle, Dashboard (headings, empty states, status indicators), ContentList (table headers, actions, dialogs, status badges), SaveButton, and ContentEditor (publish panel, schedule controls, byline editor, author selector, all dialogs). Runs `locale:extract` to add 116 new message IDs to all catalog files.
