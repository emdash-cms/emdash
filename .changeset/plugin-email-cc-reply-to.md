---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds optional `cc` and `replyTo` fields to plugin email messages, including from sandboxed plugins:

```ts
await ctx.email.send({ to, cc: ["team@example.com"], replyTo: visitorEmail, subject, text });
```

`ctx.email.send()` throws when `cc` is not an array of strings or `replyTo` is not a string. `email:beforeSend`, `email:deliver`, and `email:afterSend` hooks receive both fields on `event.message`, and the development console provider prints them. The Cloudflare email provider delivers both, and a message's `replyTo` overrides the provider's configured `replyTo`. Custom `email:deliver` providers should pass `cc` and `replyTo` to their email service.
