---
"@emdash-cms/admin": patch
---

Fixes the term edit dialog so choosing "None (top level)" as the parent moves a nested term back to the top level. Previously the term stayed under its old parent. Saving a top-level term now also moves any translations of it that sit under a different parent back to the top level, as saving a nested term already did for its parent.
