---
"emdash": patch
---

Fixes external authentication, such as Cloudflare Access, saving a role level that EmDash doesn't define (anything other than 10, 20, 30, 40 or 50) to the user record. Such a record made every later sign-in by that user fail. EmDash now refuses a sign-in with an undefined role level and leaves the user record unchanged.

A user record that already holds an undefined role level is not repaired automatically: that user still can't sign in after upgrading. Correct the provider's role mapping, then set the user's `role` column in the `users` table to one of the defined levels.
