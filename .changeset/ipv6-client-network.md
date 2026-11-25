---
"emdash": patch
---

Fixes comment reactions and per-client rate limits treating each address in an IPv6 /64 network as a separate visitor. IPv6 clients are now counted by their /64 network for comment reactions and for the comment, sign-in, signup, and OAuth rate limits; IPv4 clients are still counted by address. Reactions already stored by IPv6 visitors keep counting, but each of those visitors can react to the same comment once more. For IPv6 commenters, the comment `ipHash` passed to comment hooks and returned by the admin comments API now identifies the /64 network, and differs from hashes stored before the upgrade, so plugins that match comments on `ipHash` should expect older and newer hashes of the same visitor not to match.
