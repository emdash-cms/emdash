---
"emdash": patch
---

Fixes cached pages continuing to show stale widget areas after an editor changes their widgets. `<WidgetArea>` now registers its cache dependency automatically, so templates do not need a separate widget-area query to receive invalidation.
