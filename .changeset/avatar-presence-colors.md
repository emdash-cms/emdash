---
"@emdash-cms/admin": minor
---

Updates co-editing and **Revisions** to color each person from their generated avatar, so someone without a profile picture looks the same in the editor bar, in rich text and in revision history.

- The avatars in the editor bar show the person's profile picture or generated avatar instead of their initials on a flat color.
- A person's caret, selection and the name flag over their caret take one color from their generated avatar, and their name on a field label uses the same flag. People with a profile picture get the color of their generated avatar too. Flags are a soft gradient of darker shades of that color, so white names stay readable in light and dark mode.
- **Revisions** marks a version's dot and changes in the color of the person who made it.
- People whose generated avatars share a palette share a color, and their names tell them apart. Before, co-editing gave the people in an entry different colors from a set of four.

#### Generated avatars change once

Generated avatars now come from 18 palettes instead of 12, in two lightnesses, so people in the same entry look alike less often. A user's palette is chosen from their user ID and the number of palettes, so almost every user without a profile picture gets a different generated avatar after this upgrade. It then stays the same. Profile pictures are unaffected.
