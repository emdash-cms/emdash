---
"@emdash-cms/admin": patch
---

Makes the Revisions panel show what changed. Clicking a revision now shows the changes made in that save, compared with the revision before it; it used to compare with the revision after it, labelled "changes from next revision". A changed body shows only the blocks that changed, with removed and added words highlighted and each link's address shown (a block that was rewritten rather than edited shows as the old block, then the new one), and a changed text field shows its changed words; "Show full values" still gives the complete old and new value. Fields are named by their labels, each revision says who saved it, and a revision that is not live can be compared with the live version, fetched separately when it is older than the loaded list. A save that changed no field says so, since SEO, bylines and taxonomies are not part of a revision.
