---
"emdash": minor
---

Updates the visual-editing rich text editor's selection toolbar and slash menu to match the admin editor's.

Selecting text now shows the admin's toolbar: a Turn into menu, link, bold, italic, underline, strikethrough, inline code, and a More menu with subscript, superscript, alignment, and Clear formatting. With the caret in a link, a bar shows where it goes, with buttons to edit or remove it, and clicking a link no longer opens it in a new tab. A typed bare domain such as `example.com` links to `https://example.com`, and a link the editor can't use is refused with a message.

The slash menu now groups its commands, shows each one's Markdown shortcut and description, ranks matches as you type (`/bl` finds Bullet List), and finds Heading 4 to 6 by name. Headings 4 to 6 now show at their own size while editing instead of as Heading 1. Both menus follow the system's light or dark theme and stay readable in dark mode.
