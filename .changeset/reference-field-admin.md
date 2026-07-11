---
"@emdash-cms/admin": minor
---

Reference fields are now a real, working field type. Previously "reference" was just a plain text box with nowhere to point; now you get a proper relationship picker. Configure it in the schema editor (choose the target collection and single vs. multiple), then search for, pick, and reorder linked entries right in the entry editor — all saved together with the entry in one request. Referenced entries show a read-only "Referenced by" panel so you can see what points at them, and you can jump straight to any linked entry from the picker or the backlinks.
