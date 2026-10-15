---
"@emdash-cms/admin": patch
---

Updates `/video`, and **Video** in the add-block menu, to open the video picker first, as `/image` does. The video block is added once you choose a video, and closing the picker adds nothing. A video block saved without a video, such as one left empty by an earlier version, shows as unplayable, with **Replace video** to choose one and **Delete video** to remove it. Blocks chosen from a picker opened by the add-block menu also stay where the menu was if an upload finishes while the picker is open.
