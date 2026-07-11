---
"emdash": minor
---

Reference fields now store real relationships between entries instead of an inert string. Selections are saved as first-class content-reference edges, written atomically with the entry in a single transaction, and hydrated on read alongside SEO and bylines — each resolved reference carries a readable display title (from the referenced entry's `title`, then `name`) so pickers and backlinks show a label instead of a slug. Reference fields are storage-less: they no longer add a column to a collection's table, and "Referenced by" backlinks come for free from the edge data. Seed files using a reference field apply its `$ref:` value as an edge (seed shape unchanged). Upgrade note: existing reference columns keep their data but are no longer written to.
