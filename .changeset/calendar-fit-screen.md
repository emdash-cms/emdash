---
"@emdash-cms/admin": patch
---

Fits the admin calendar's month view to the screen.

- The month grid fills the window with one-line entries and shows as many per day as fit, folding the rest into "+N more".
- On wide screens the entry panel sits beside the calendar instead of covering it, and clicking empty space closes it. On phones it is a bottom sheet that swipes down to close.
- The page title and description give their space to the month. The view switcher and Filter sit above the month's name, which has Today and the month arrows beside it.

Agenda rows show times in the site's time zone; the side panel and entry tooltips also show the viewer's own time. Month cells no longer draw the red line marking the present; the agenda and the lists of a day's entries still do.
