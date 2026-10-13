---
"@emdash-cms/admin": patch
---

Fixes blocks fields overflowing the content editor on phone-width screens. A long block summary made every block card wider than the screen, which pushed the Add block, Duplicate and Delete buttons out of reach and clipped the block's inputs. Cards now fit the screen. A long summary ends with an ellipsis, and a long one-word block type name wraps. A cut-off summary also shows its first words when its text and the admin language read in different directions, such as English content in the Arabic admin.
