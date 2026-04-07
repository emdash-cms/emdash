---
name: agent-browser
description: Browser automation for testing and verification. Use when you need to interact with web UIs, verify visual changes, fill forms, or capture screenshots.
---

# Agent Browser Skill

Fast browser automation CLI for AI agents. Use this to verify web UI changes, test interactions, and capture screenshots.

## When to Use

- Verify visual changes after modifying frontend code
- Test form interactions and user flows
- Capture screenshots for documentation or debugging
- Inspect rendered HTML/accessibility tree
- Debug why something isn't working in the browser

## Core Workflow

### 1. Open a URL

```bash
agent-browser open http://localhost:4321/
```

### 2. Take a Snapshot

The snapshot command returns an accessibility tree with refs (`@e1`, `@e2`, etc.) that you can use for interactions:

```bash
agent-browser snapshot -i    # -i = interactive elements only (recommended)
agent-browser snapshot -c    # -c = compact (removes empty structural elements)
agent-browser snapshot -i -c # Both flags work together
```

### 3. Interact Using Refs

Use the `@ref` values from the snapshot to interact with elements:

```bash
agent-browser click @e5           # Click element
agent-browser fill @e3 "hello"    # Clear and type
agent-browser type @e3 "world"    # Type without clearing
agent-browser select @e7 "option" # Select dropdown
agent-browser check @e9           # Check checkbox
```

### 4. Screenshot

```bash
agent-browser screenshot              # Viewport only
agent-browser screenshot --full       # Full page
agent-browser screenshot output.png   # Save to file
```

ALWAYS check the image size before attempting to load. If it is larger than 2MB, process it using a tool such as sips or ImageMagick to reduce the size. Large files cannot be loaded by your tools.

## Common Patterns

### Form Verification

```bash
agent-browser open http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/content/posts/new
agent-browser snapshot -i   # Check what fields are visible
agent-browser fill @e3 "Test Title"
agent-browser fill @e5 "Test content here"
agent-browser click @e7     # Save button
```

### Get Element Info

```bash
agent-browser get text @e1      # Get text content
agent-browser get html @e1      # Get inner HTML
agent-browser get value @e2     # Get input value
agent-browser get url           # Current URL
agent-browser get title         # Page title
agent-browser get count "button" # Count matching elements
```

### Check Element State

```bash
agent-browser is visible @e1
agent-browser is enabled @e2
agent-browser is checked @e3
```

### Find by Role/Label

```bash
agent-browser find role button click --name "Submit"
agent-browser find label "Email" fill "test@example.com"
agent-browser find placeholder "Search..." type "query"
```

## Sessions

Sessions keep browser state (cookies, storage) between commands:

```bash
# Use named session (persists until closed)
agent-browser --session mytest open http://localhost:4321
agent-browser --session mytest snapshot -i

# Or set via environment
export AGENT_BROWSER_SESSION=mytest
agent-browser open http://localhost:3000
```

## Useful Options

| Option             | Description                         |
| ------------------ | ----------------------------------- |
| `--session <name>` | Isolated browser session            |
| `--headed`         | Show browser window (not headless)  |
| `--json`           | JSON output for programmatic use    |
| `--full`           | Full page screenshot                |
| `-i`               | Snapshot: interactive elements only |
| `-c`               | Snapshot: compact output            |
| `-d <n>`           | Snapshot: limit tree depth          |

## Debugging

```bash
agent-browser --headed open http://localhost:3000  # See what's happening
agent-browser console                               # View console logs
agent-browser errors                                # View page errors
agent-browser highlight @e5                         # Highlight element
agent-browser eval "document.title"                 # Run JS
```

## Tips

1. **Always snapshot first** - Get refs before interacting
2. **Use `-i` flag** - Interactive-only snapshots are much cleaner
3. **Wait when needed** - Use `wait <ms>` or `wait <selector>` after actions that trigger loading
4. **Sessions for auth** - Use named sessions to persist login state
5. **Headed for debugging** - Use `--headed` when things aren't working as expected
