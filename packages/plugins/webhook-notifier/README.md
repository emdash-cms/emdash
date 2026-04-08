# Webhook Notifier

Send webhook notifications when content changes in your EmDash site.

## Features

- Fires HTTP POST to configured URLs on content create, update, and delete
- Supports custom headers for authentication
- Configurable per-collection or global triggers
- Retries failed deliveries with exponential backoff
- Admin UI for managing webhook endpoints

## Capabilities

- `network:fetch` - sends HTTP requests to webhook endpoints
- `read:content` - reads content data to include in webhook payloads

## Installation

Install from the EmDash admin panel under Plugins > Marketplace, or via CLI:

```bash
emdash plugin install webhook-notifier
```

## Configuration

After installation, add webhook endpoints in the plugin settings:

1. Go to Plugins > Webhook Notifier > Settings
2. Add a webhook URL
3. Optionally configure headers and select which events trigger it
