---
"@emdash-cms/plugin-types": minor
---

Adds `describeCapability()` and `CAPABILITY_DESCRIPTIONS`, which give an English label and description for every plugin capability so tools that list a plugin's permissions can show the same wording.

```ts
import { describeCapability } from "@emdash-cms/plugin-types";

describeCapability("content:read");
// { label: "Read content", description: "Read entries from your site’s content collections." }
```

Deprecated capability names return the description of their replacement. A string that is not a known capability returns `undefined`.
