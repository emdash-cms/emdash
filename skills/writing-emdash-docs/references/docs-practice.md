# Documentation practice

Use this reference with the EmDash documentation style guide. The style guide defines the house voice and local conventions. This reference covers information architecture, document types, accessibility, examples, and maintenance.

## Contents

- [Start with the reader](#start-with-the-reader)
- [Keep document types distinct](#keep-document-types-distinct)
- [Write clearly and directly](#write-clearly-and-directly)
- [Design for finding and scanning](#design-for-finding-and-scanning)
- [Write usable code examples](#write-usable-code-examples)
- [Make the page accessible and global](#make-the-page-accessible-and-global)
- [Maintain one source of truth](#maintain-one-source-of-truth)
- [Test the reader's path](#test-the-readers-path)

## Start with the reader

Define these before outlining:

- **Role:** site builder, plugin author, administrator, contributor, evaluator, or another specific reader.
- **Goal:** the task they need to complete or decision they need to make.
- **Starting state:** installed software, permissions, configuration, prior reading, and knowledge they already have.
- **Outcome:** the observable state or understanding they need at the end.

Document the difference between what the reader needs and what the reader already knows. Give experienced readers direct access to tasks. Explain setup that a beginner cannot infer.

Define the page scope. State non-scope only for adjacent topics a reader would reasonably expect the page to cover, then link to the correct page when it exists.

## Keep document types distinct

Choose the reader need before the format. A page can contain multiple topic types, but each section should do one job.

### Tutorial

Use a tutorial to help a learner acquire familiarity through a guided experience.

- Choose one achievable, meaningful result and one reliable path.
- Assume little beyond the stated prerequisites.
- Produce visible output early and after each meaningful stage.
- State expected output so the learner can confirm that each step worked.
- Mention likely failure signals at the step where they can occur.
- Remove options, exhaustive reference detail, and long explanations that interrupt the learning flow. Link to them instead.
- Test the complete tutorial from its stated starting state. A tutorial that only works in the author's existing environment is broken.

### Task guide

Use a task guide to help a competent reader solve a real problem.

- Define the task by the reader's goal. Include buttons, functions, and settings only when the reader needs them to complete it.
- Start and end at meaningful states in the reader's work.
- List permissions, setup, destructive effects, and other prerequisites before the steps.
- Document the primary path. Add alternatives only when different reader contexts require them, ordered by likely use.
- Keep each step focused on one action or decision and preserve the sequence of the reader's work.
- State the result and any necessary verification after the steps.
- Move background teaching and exhaustive option lists to concept or reference pages.

### Concept or explanation

Use a concept topic to answer what something is, why it exists, how its parts relate, or what trade-offs it creates.

- Cover one concept per section.
- Use a noun or specific noun phrase for the title.
- Connect new ideas to knowledge the stated audience already has.
- Include a concrete example or diagram only when it makes a relationship easier to understand.
- Do not let step-by-step instructions take over the explanation. Link to task guides.

### Reference

Use reference material for exact facts a reader consults while working.

- Mirror the product's conceptual structure so names and relationships are predictable.
- Use a stable, repeated schema for comparable APIs, commands, fields, hooks, or settings.
- Include syntax, type, required status, default, constraints, return value, errors, permissions, and version or environment conditions when applicable.
- Prefer scan-friendly lists, description lists, or tables when the data is genuinely parallel.
- Place each caveat beside the item it qualifies. Avoid catch-all `Important notes` or `Limitations` sections.
- Include concise examples to show context, then link to task guides for complete procedures.
- Verify completeness and exact spelling against source, generated types, schemas, or command output.

### Troubleshooting

Use troubleshooting content for a known symptom or failure mode.

- Put the exact error text or observable symptom in the heading and body so readers can find it by search.
- State the environment or action in which the problem appears.
- Separate confirmed causes from diagnostic possibilities.
- Give diagnostic checks before a resolution when multiple causes produce the same symptom.
- Distinguish a temporary **workaround** from a permanent **resolution**.
- Put data-changing or destructive commands behind a concrete warning. Include backup, test-environment, or recovery steps when required.
- State how to confirm that the problem is resolved.
- Keep rare but useful failures near the relevant feature. Split out a troubleshooting page when they overwhelm the main task.

### Upgrade and migration guide

Use an upgrade guide when a version change requires reader action.

- Identify who is affected and how to check.
- State the previous and current behavior only as needed to choose an action.
- Give the migration action and a minimal before-and-after example.
- Include ordering, downtime, rollback, backup, and compatibility constraints when applicable.
- End each breaking change with a verifiable working state.

## Write clearly and directly

- Use a neutral, factual tone that is calm, friendly, and respectful. Avoid whimsy, mascots, cultural references, and jokes that add work for the reader or translator.
- Use active voice and present tense. Name the actor when responsibility matters.
- Address the reader as `you` when necessary. Do not use `I`, `we`, `us`, `our`, or `let's` in documentation.
- Give required actions as direct imperative instructions. Use `can` only for an available option or permission. Replace ambiguous `should` statements with the expected result or a clear recommendation and its reason.
- Start instructions with the goal or action and the reason the reader needs it. Remove narration such as "next, we will" or "now that this is configured."
- Prefer short sentences, short paragraphs, and familiar words. Define an abbreviation on first use and explain only the background the stated audience lacks.
- When several valid choices exist, state the requirement or selection criteria first. Choose one option for the example and identify that choice so the reader can substitute another.
- Keep headings short, specific, and in sentence case. Do not end a heading with punctuation. Format code terms in headings as code.
- Use bullets for related items and numbers for an ordered sequence. Convert long, multi-paragraph list items into subsections.
- Write `for example` when introducing one example. Use `e.g.` inside parentheses for a non-exhaustive list. Do not label a complete list as examples.
- Keep exclamation points rare. Use a period unless the sentence is genuinely encouraging or surprising.

## Design for finding and scanning

- Use the terms readers see in the UI, API, command output, and error message. Include common prior terminology only when it helps migration or search.
- Write titles that identify the task or subject without depending on navigation context.
- Front-load the distinguishing information in a paragraph, list item, heading, and link.
- Keep heading levels hierarchical and never skip levels. Add prose between a heading and its first subheading.
- Avoid one-sentence sections and pages that exist only to collect links. Merge thin material or add a brief explanation of what the reader will find.
- Use related links sparingly and group them after the content they support. Prefer an inline link at the point of need.
- Introduce lists and tables. Use a table for information with meaningful row and column relationships.
- Keep parallel items grammatically parallel, but do not force equal length or a set of three.

## Write usable code examples

- Use repository conventions and current public APIs.
- Show the smallest complete example that demonstrates the behavior without teaching an unsafe or obsolete shortcut.
- Use realistic names and reserved example values. Make placeholders visually unambiguous and explain each replacement.
- Include imports, setup, permissions, and surrounding structure needed to run the example, or link to a clearly defined starting project.
- Mark omitted code with a language-appropriate comment. Do not use an ellipsis that a reader might copy as code.
- Introduce every sample with a complete sentence that states its purpose. A direct imperative can introduce a sample inside an ordered step.
- Add a `title=` filename to a block that represents a file.
- Follow the sample with the expected result or the detail the reader should notice.
- Keep comments for non-obvious choices. Explain the code in prose when several lines need narration.
- Run or type-check examples when practical. Otherwise, verify every symbol and behavior against executable source or tests.
- Never put secrets, live tokens, unsafe permissions, destructive production commands, or non-reserved domains in copyable examples.

## Make the page accessible and global

- Use descriptive link text that makes sense outside its sentence. Do not use `click here` or expose a raw URL as the label unless the URL is the subject.
- Preserve heading hierarchy and semantic Markdown or HTML. Do not choose markup only for its visual appearance.
- Write alt text for the image's purpose in context. Use empty alt text for decoration. Put any new information from an image, diagram, video, or animation in text as well.
- Do not depend on color, position, shape, sound, punctuation, or mouse input alone to communicate a step.
- Introduce tables and interactive elements before they appear. Avoid complex or merged table cells.
- Define unfamiliar abbreviations on first use and avoid idioms, cultural references, jokes, and figurative language that do not translate literally.
- Prefer simple sentence structures. State a condition before its instruction.
- Describe unexpected link behavior such as a download or an external tool.

## Maintain one source of truth

- Search the documentation before adding a definition, option list, setup sequence, or recurring command.
- Put stable information in one canonical location and link to it from other pages. Repeated prose drifts.
- Check every page that names a changed API, option, default, workflow, or old term.
- Preserve redirects or update inbound links when moving or renaming content.
- Keep promises about unreleased behavior out of evergreen docs. Document shipped behavior; put planned work in issues, discussions, or a clearly marked experimental section.
- Treat documentation like code: review diffs, build the site, test procedures, and keep changes scoped to the behavior being documented.

## Test the reader's path

Before finishing, verify more than grammar:

1. Start from the stated prerequisites, ideally in a clean environment.
2. Follow every step in order and copy commands exactly as rendered.
3. Compare actual and documented output, defaults, errors, and side effects.
4. Test at least one likely failure or boundary when the page gives troubleshooting or safety guidance.
5. Scan headings and links without body text. Confirm that they still identify the destination or task.
6. Search for duplicate and contradictory claims elsewhere in the docs.
7. Build the rendered site and inspect components, code fences, tables, images, and anchors.

Apply these principles with the EmDash style guide and repository rules, which take precedence when conventions differ.
