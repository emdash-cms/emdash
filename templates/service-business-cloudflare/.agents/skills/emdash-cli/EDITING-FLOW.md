# Editing Flow

How content editing works through the CLI. Covers Portable Text conversion, `_rev` tokens, and raw mode.

## Portable Text and Markdown

EmDash stores rich text as [Portable Text](https://portabletext.org/) (PT) — a structured JSON format. The CLI automatically converts between PT and markdown so you work with a familiar text format.

### Automatic Conversion

- **On read**: PT arrays in `portableText` fields are converted to markdown strings
- **On write**: markdown strings in `portableText` fields are converted back to PT arrays
- **Non-PT fields** (string, text, number, etc.) pass through unchanged

The CLI detects which fields need conversion by fetching the collection's field schema.

### Supported Markdown Syntax

Standard blocks (lossless round-trip):

| Markdown                     | PT block                                   |
| ---------------------------- | ------------------------------------------ |
| `# Heading` through `######` | h1-h6 blocks                               |
| Plain paragraph              | normal block                               |
| `> Quote`                    | blockquote                                 |
| `- item` / `* item`          | bullet list (nesting via 2-space indent)   |
| `1. item`                    | numbered list (nesting via 2-space indent) |
| ` ``` ```lang``` `           | code block with language                   |
| `![alt](url)`                | image block                                |

Inline marks:

| Markdown      | PT mark         |
| ------------- | --------------- |
| `**bold**`    | `strong`        |
| `_italic_`    | `em`            |
| `` `code` ``  | `code`          |
| `~~strike~~`  | `strikethrough` |
| `[text](url)` | link annotation |

### Unknown Blocks (Opaque Fences)

Blocks the converter doesn't recognize (custom blocks, embeds, etc.) are serialized as HTML comments:

```markdown
<!--ec:block {"_type":"callout","level":"warning","text":"Be careful"} -->
```

These survive round-trips intact. You can see and move them, but editing the JSON risks corruption. On write, they're deserialized back to the original PT block.

### Raw Mode

Skip markdown conversion entirely to work with raw PT JSON:

```bash
npx emdash content get posts 01ABC123 --raw
```

Use raw mode when:

- You need exact control over PT structure
- You're working with custom block types
- You're copying PT between items without transformation

### Writing Content

When creating or updating content, each field is checked:

- `portableText` field + **string value** → converts markdown to PT before sending
- `portableText` field + **array value** → sends as raw PT (no conversion)
- Any other field type → sends as-is

```bash
# Markdown string — converted to PT automatically
npx emdash content create posts --data '{"title": "Hello", "body": "# Welcome\n\nThis is **bold**."}'

# Raw PT array — passed through as-is
npx emdash content create posts --data '{"title": "Hello", "body": [{"_type": "block", "children": [{"_type": "span", "text": "Welcome"}]}]}'
```

## Auto-Publishing

The CLI is designed for agents. It auto-publishes on `create` and `update` by default so agents get read-after-write consistency without managing the draft/publish lifecycle.

### How It Works

- **`create`** — creates the item, then publishes it. The returned item is in `published` status.
- **`update`** — updates the item. If the collection uses revisions and the update created a draft revision, it auto-publishes to promote the draft to the content table. The returned item reflects the updated data.
- **`get`** — returns the latest state. If a pending draft exists (e.g. someone edited in the admin UI but didn't publish), the draft data is returned instead of the published data. Use `--published` to see only published data.

Use `--draft` on create/update to skip auto-publishing.

### Why Auto-Publish?

EmDash collections can support draft revisions. When they do, `update` writes data to a draft revision instead of the content table. Without auto-publish, an agent would update, then `get` the item, and see stale published data — not the changes it just made. Auto-publish eliminates this confusion.

## Read-Before-Write

Updates use `_rev` tokens for optimistic concurrency — the same principle as a file editing tool that requires you to read a file before you can edit it. You must see what you're overwriting.

### The Analogy

Think of it like a filesystem edit tool:

1. You **read** the file to see its current contents
2. You decide what to change
3. You **write** with a reference to the version you read

If someone else changed the file between your read and your write, the write fails — you can't overwrite changes you haven't seen. The `_rev` token is your proof that you've seen the current state.

### How It Works

1. `content get` returns the item with a `_rev` token in the output
2. You pass that `_rev` back to `content update` via `--rev`
3. The server checks: if the item has changed since your read, it returns **409 Conflict**
4. A successful update returns a new `_rev` for subsequent edits

### What Is a `_rev` Token?

An opaque base64 string. Don't parse it — just pass it back.

### CLI Workflow

The CLI **requires** `--rev` on updates. The typical workflow:

```bash
# 1. Read the item — note the _rev in the output
npx emdash content get posts 01ABC123
# Output includes: _rev: MToyMDI2LTAyLTE0...

# 2. Update with the _rev you received — auto-publishes by default
npx emdash content update posts 01ABC123 \
  --rev MToyMDI2LTAyLTE0... \
  --data '{"title": "New Title"}'
# Output shows updated item with new _rev
```

If you try to update without `--rev`, the CLI rejects the command. This ensures you always know what you're overwriting.

### Conflict Handling

If someone else updated the item between your read and write:

```
EmDashApiError: Content has been modified since last read (version conflict)
  status: 409
  code: CONFLICT
```

Resolution: re-read with `get`, inspect the new state, then `update` with the fresh `_rev`.

### Which Operations Need `_rev`?

Only `update`. All other operations are either idempotent or non-destructive:

| Command             | `--rev` needed? | Why                      |
| ------------------- | --------------- | ------------------------ |
| `content create`    | No              | Nothing exists yet       |
| `content update`    | **Yes**         | Overwrites existing data |
| `content delete`    | No              | Soft delete, reversible  |
| `content publish`   | No              | Idempotent status change |
| `content unpublish` | No              | Idempotent status change |
| `content schedule`  | No              | Only changes metadata    |
| `content restore`   | No              | Restores from trash      |
