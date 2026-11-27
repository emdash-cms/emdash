---
"@emdash-cms/admin": patch
---

Updates the admin **Dashboard** so it stays readable on sites with many collections, long titles, or a phone-sized screen:

- The counts sit in one **Overview** card, with digit grouping for your language (for example 20,969).
- **Recent Activity** is the main column. Its collection and time columns line up across rows, and the collection column is hidden when the site has only one collection.
- **Content** moves to a side column on wide screens, so a short collection list no longer leaves an empty card.
- Plugin dashboard widgets declared with `size: "third"` sit in the side column on wide screens. All other widgets, including those with no `size`, take the full width of the main column.
- With more than three collections, the first two **New** buttons stay and the rest move into a **More** menu.
- Collections with no entries say **No entries**.
- Long lists of collections and of failed scheduled publishes collapse behind a **Show more** button.
- On phones, failed scheduled publishes stack their reason and **Dismiss** button instead of pushing them off-screen.
- In the Arabic admin, English titles are cut off at their end rather than their start.
