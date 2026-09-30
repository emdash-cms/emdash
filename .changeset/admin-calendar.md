---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a publishing calendar to the admin. It shows published entries on their publication date, and scheduled entries and scheduled updates on their scheduled date, across every visible collection and locale. Contributors and higher roles open it from **Calendar** in the sidebar, the command palette, or the dashboard's **Scheduled** count.

**Month** shows a grid of days and **Agenda** lists entries by day; phones and other narrow screens open the agenda and show the month as a date picker. Both views place entries in the site's time zone, show browser-zone times when the viewer's zone differs, mark schedules that missed their time as **Overdue**, filter by collection, locale, and state, and keep the view, month, filters, and open entry in the URL. When a month's grid holds more than 1,000 entries, the calendar shows the first 1,000 and marks the days it didn't load.

Selecting an entry opens a side panel with its details, a link to the editor, and a preview or live link. Users who can publish the entry can also reschedule it, remove its schedule, or publish an overdue entry immediately. Ctrl-click or Cmd-click opens the entry in the editor instead.
