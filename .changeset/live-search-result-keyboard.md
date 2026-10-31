---
"emdash": patch
---

Fixes `<LiveSearch>` keyboard navigation after a result has focus: Down and Up keep moving through the results (wrapping at either end), and Escape closes the results and returns focus to the search input. Previously both keys stopped working once the first result was focused.
