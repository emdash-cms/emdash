# AT Protocol

Syndicate your EmDash content to Bluesky and the AT Protocol network.

## Features

- Automatically posts to Bluesky when content is published
- Supports text posts with rich text formatting
- Configurable post templates
- Links back to original content on your site
- Works with any AT Protocol-compatible service

## Capabilities

- `network:fetch` - connects to AT Protocol services
- `read:content` - reads published content for syndication

## Installation

Install from the EmDash admin panel under Plugins > Marketplace, or via CLI:

```bash
emdash plugin install atproto
```

## Configuration

After installation, configure your Bluesky credentials in the plugin settings:

1. Go to Plugins > AT Protocol > Settings
2. Enter your Bluesky handle and app password
3. Choose which collections trigger syndication
