---
"@emdash-cms/auth": minor
"emdash": patch
---

Adds `PasskeyConfig.userVerification` so sites can require, prefer, or discourage passkey user verification. Existing callers keep the `preferred` behavior.

Adds typed, versioned challenge contexts for registration and authentication. Declare a codec with `defineChallengeContext()`, bind data with `bindChallengeContext()` when generating options, and pass the codec with an `AtomicChallengeStore` to `verifyAuthenticationResponse()` or `verifyRegistrationResponse()` to recover the typed value after verification.

Atomic challenge stores declare `readonly atomic: true`, so an unrelated `consume()` method on an existing challenge store cannot silently change its behavior. EmDash retains optional challenge context data in its database-backed challenge store.

Authentication rejects assertions whose signature counter drops from a nonzero value to zero because the counter change can indicate a cloned authenticator.
