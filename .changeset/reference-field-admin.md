---
"@emdash-cms/admin": minor
---

Adds a working reference field, and a screen for the relationships behind it. A reference field is an entry picker: search for, pick and reorder linked entries in the entry editor, saved with the entry in one request. To answer "what points at this entry", bind a field to the other end of the same relationship — it lists the entries pointing here and can edit that list.

Content Types links to a new Relations page listing every relationship on the site — the content types it joins, the fields bound to each end and which end they pick from, and how many links it holds — and each content type repeats the ones it is an end of in a panel under its fields. A new reference field starts from its relationship: pick one, and the label, slug and the rest of the field follow from the side the field views. Deletion dialogs name what goes with a deletion, including the field on the other content type. A reference field created before this release keeps rendering as the text box it has always been, and its dialog offers the collection picker that converts it. The [Relations guide](https://docs.emdashcms.com/guides/relations/) walks through the screens.
