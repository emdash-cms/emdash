---
"@emdash-cms/admin": patch
"emdash": patch
---

Adds drag-and-drop rescheduling to the admin calendar and fits the month view to the screen.

- The month grid fills the window with one-line entries and shows as many per day as fit, folding the rest into "+N more".
- People who can publish a scheduled entry can drag it to another day, keeping its time. The confirmation offers Undo. On touch screens, press and hold an entry to drag it.
- On wide screens the entry panel sits beside the calendar instead of covering it, and clicking empty space closes it. On phones it is a bottom sheet that swipes down to close.
- The page title and description give their space to the month. The view switcher and Filter sit above the month's name, which has Today and the month arrows beside it.
- Keyboard shortcuts: T goes to today, J and K to the next and previous month, and M and A switch between month and agenda.

Agenda rows show times in the site's time zone; the side panel and entry tooltips also show the viewer's own time. Month cells no longer draw the red line marking the present; the agenda and the lists of a day's entries still do.

The calendar data the admin loads from `emdash` includes each entry's `authorId`, which the admin uses to offer dragging only on entries the user can publish.
