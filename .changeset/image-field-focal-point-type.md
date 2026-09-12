---
"emdash": patch
---

Fixes the image field type so a stored focal point is readable. `focalX` and `focalY` reach content entries but were missing from the generated collection types, so reading them from an image field was a type error. The dark-variant slot shares the media shape, so its focal point is readable on the same terms.
