---
"@emdash-cms/admin": patch
---

Fixes the Schedule button in the scheduling dialog appearing to do nothing when the date or time was missing or invalid. The dialog now explains what to change, and when nothing is scheduled yet it opens with the next whole hour (at least five minutes away) selected. Clearing the hour or minute and moving on puts back the last value. In both the scheduling and publication date dialogs, clicking the selected day no longer clears it, and the publication date dialog now shows its validation errors too. In right-to-left languages, the time fields now read hour then minute instead of appearing reversed.
