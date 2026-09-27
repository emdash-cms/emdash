---
"emdash": patch
---

List endpoints now treat a zero or negative `limit` as 1, matching the documented range of 1 to 100. Previously some lists, including public comment lists, could return more items than the maximum page size.
