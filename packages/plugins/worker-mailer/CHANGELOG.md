# @emdash-cms/plugin-worker-mailer

## 0.1.0

### Minor Changes

- Initial release of the Worker Mailer email provider plugin for EmDash.
- Document and enforce the Cloudflare Workers requirement for SMTP connections that start already secure
  (implicit TLS / SMTPS). STARTTLS is not exposed by the plugin.
