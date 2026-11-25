---
"emdash": patch
---

Fixes comment reactions and per-client rate limits treating each address in an IPv6 /64 network as a separate visitor. IPv6 clients are now counted by their /64 network for comment reactions and for the comment, sign-in, signup, and OAuth rate limits; IPv4 clients are still counted by address. Reactions already stored by IPv6 visitors keep counting, but each of those visitors can react to the same comment once more.
