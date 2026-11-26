---
"emdash": patch
---

Fixes Cloudflare Access sign-in for people whose Access email contains capital letters. New accounts are now stored with a lowercase email, so these sign-ins no longer fail with "Failed to provision user", and simultaneous first sign-ins no longer create a second account for the same person.
