---
"emdash": patch
---

Fixes WordPress imports placing every category and hierarchical term at the top level. Categories and terms imported from a WXR file or through the EmDash Exporter now keep their WordPress parent when the EmDash taxonomy is hierarchical. Terms that already exist in EmDash keep their current parent, so importing again does not rearrange the categories of an earlier import. To nest those, edit each term in the admin and choose its parent.
