---
"@emdash-cms/admin": patch
---

Lets translators give three ambiguous admin labels their own translations. The **Select** field type, the **Admin** user role, and the **Authors** record kind in site transfer each shared one catalog entry with a differently used label: the **Select** button, the **Admin** navigation group and API token scope, and plugin **Authors**. A language that needs different words for them had to pick one, so German and French admins saw the field-type name on the media picker's **Select** button, and Catalan and Norwegian admins saw the role called "Administration". These labels now have their own catalog entries. Until a language translates them, they appear in English.
