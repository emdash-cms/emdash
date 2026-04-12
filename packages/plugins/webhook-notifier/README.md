# Webhook Notifier

Send webhook notifications when content changes in your EmDash site.

## Features

- Fires HTTP POST to a configured URL on content and media events
- Supports a secret token for webhook authentication
- Toggle between all events, content-only, or media-only
- Option to include full content data in payloads
- Admin settings page for configuration
- Dashboard widget showing delivery status

## Capabilities

- `network:fetch:any` - sends HTTP requests to webhook endpoints

## Installation

Install from the EmDash admin panel under Plugins > Marketplace.

## Configuration

After installation, configure the webhook in the plugin settings:

1. Go to Plugins > Webhook Notifier > Settings
2. Enter the webhook URL
3. Optionally provide a secret token for authentication
4. Choose which events to send (all, content-only, or media-only)
