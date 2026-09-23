# Phase 6: Verify the rendered site

Run the site against disposable data, compare each in-scope page with its reference, and verify the interactions that matter to the port.

## Start from known data

Use a dedicated test database or a disposable site. Do not delete an existing database or terminate an unrelated process to force the seed to reapply. If the current project cannot be reset safely, create a separate fixture or ask the user which data may be replaced.

Start the project with its package script and watch for seed or runtime errors:

```bash
pnpm dev
```

Record the actual URL and viewport used for comparison.

## Capture comparable screenshots

Capture only the page types and responsive states selected during discovery. Use the same viewport, content shape, scroll position, and UI state for each reference-and-result pair.

```bash
agent-browser open http://localhost:4321
agent-browser screenshot output/homepage.png --full
```

Inspect each screenshot before using it as evidence. Confirm that fonts and images loaded, transient overlays are absent, and the screenshot shows the intended route and state.

## Compare behavior and presentation

Check:

- layout structure, content width, alignment, and spacing;
- typography, colors, borders, and imagery;
- navigation, menus, forms, and interactive states;
- desktop and mobile behavior;
- long, missing, and representative CMS content;
- focus, keyboard use, semantic headings, and visible labels;
- console and request failures.

Match the fidelity requested by the user. Do not substitute a vague “same design language” judgment when the task requires a close reproduction, and do not spend time on pixel-level differences when the requested outcome is structural.

Re-capture the affected state after each meaningful round of fixes. Keep the final reference-and-result images and report deliberate deviations.

## Build

Run the project build after rendered verification:

```bash
pnpm run build
```

## License and attribution

Inspect the theme's actual license and bundled notices. Preserve required attribution and include the applicable license text for code or assets that the port redistributes. Track third-party fonts, images, icons, and demo content separately; their licenses may differ from the theme code.
