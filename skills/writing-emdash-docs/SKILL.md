---
name: writing-emdash-docs
description: Write, revise, and review EmDash documentation for technical accuracy, useful structure, house style, and natural prose. Use when working on user documentation, guides, API reference pages, migration or upgrade guides, READMEs, contributor documentation, technical specifications, or release notes in the EmDash repository, and when asked to improve, audit, de-slop, or humanize existing documentation.
---

# Writing EmDash docs

Produce documentation that helps a specific reader complete a task or understand a concrete part of EmDash. Treat factual accuracy, information design, and sentence-level style as separate checks.

## Load the right context

Before drafting or editing:

1. Read `docs/src/content/docs/contributing/docs-style-guide.mdx` completely for public documentation. Apply its relevant voice and readability rules to other prose in the repository.
2. Read [references/docs-practice.md](references/docs-practice.md) completely for every writing or revision task.
3. Read [references/anti-slop.md](references/anti-slop.md) completely for every writing or revision task.
4. Read nearby pages of the same type to preserve established structure, terminology, frontmatter, imports, and Starlight component usage.
5. Inspect the implementation, types, tests, command help, or configuration that establishes every technical claim. Do not rely on memory when the repository can answer the question.
6. Read `AGENTS.md` for repository-wide rules.
7. For changesets, read [.changeset/README.md](../../.changeset/README.md) completely. Treat the entry as public CHANGELOG documentation and review whether affected readers can recognize the surface, understand the observable effect, and act on any migration guidance. Frontmatter validity and technical accuracy do not make an unhelpful entry acceptable.

## Define the reader and outcome

State the intended outcome privately in one sentence: "After reading this, the reader can ..." Use it to decide what belongs on the page.

Classify the document before choosing its structure:

| Document                    | Reader need                                  | Default shape                                                                                                  |
| --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tutorial                    | Learn through a reliable, guided experience  | Visible goal, prerequisites, one path, expected results after each stage, recap                                |
| Task guide                  | Complete one practical task                  | Outcome, prerequisites, ordered actions, result, optional next step                                            |
| Concept or explanation      | Build an accurate mental model               | Definition, relevant behavior, concrete example, implications                                                  |
| Reference                   | Look up exact behavior                       | Signature or syntax, parameters, defaults, return value, errors, examples                                      |
| Troubleshooting             | Diagnose and resolve a known failure         | Exact symptom, context, cause or diagnostic checks, workaround or resolution, verification                     |
| Upgrade or migration guide  | Make an existing project work after a change | Previous behavior, current behavior, required action, minimal diff                                             |
| README or contributor guide | Start or contribute quickly                  | Short purpose, fastest working path, common operations, deeper links                                           |
| Technical specification     | Evaluate and implement a decision            | Goal, constraints, decision, interfaces and data flow, failure handling, rollout, verification, open decisions |

Do not force every section into the same size. Give common or risky tasks more space than incidental details.

## Draft for the task

- Lead with the reader's outcome. Move project history or implementation chronology to a page where it helps the reader make a decision.
- Use the words readers will search for in the title, introduction, headings, and exact error messages. Prefer specific labels to `Overview`, `Introduction`, or `Why it matters`.
- Use direct subject-verb-object sentences and precise nouns. Repeat the established name for a concept; synonyms can imply a second concept.
- Use imperative instructions for required actions. Reserve "can" for a genuine option and explain consequences when a choice matters.
- Put a condition before the action it governs so the reader knows whether the instruction applies before acting.
- Keep prerequisites explicit. Do not hide setup assumptions inside a later step.
- Prefer one realistic, working path over a menu of hypothetical choices. State the selection criteria before an opinionated example.
- Introduce code samples with what they accomplish. Add `title=` filenames to blocks that represent files.
- Keep code and output consistent with the current API. Include defaults, errors, permissions, and caveats when they affect successful use.
- Link to authoritative material for non-EmDash topics. Keep explanations focused on EmDash-specific behavior.
- Keep one canonical explanation for recurring information and link to it. Do not duplicate commands, option lists, or procedures across pages when they can drift independently.
- Preserve valid frontmatter, imports, links, anchors, code-fence metadata, and MDX component boundaries while editing prose.

For public docs, describe how to use EmDash. Put internal design detail in contributor or architecture documentation unless it changes a reader's decision.

## Run the anti-slop pass

Finish the content pass before polishing sentences. Then inspect every changed paragraph using [references/anti-slop.md](references/anti-slop.md).

Ask of each sentence:

1. Is it stating information or staging a reveal?
2. Does it name the actor, behavior, and consequence precisely?
3. Does it add information the reader needs?
4. Does it preserve the source's meaning, uncertainty, and scope?

Remove chatbot residue, generic promotion, manufactured drama, self-grading, process narration, diff-centered language, and empty transitions. Replace vague emphasis with facts. Do not add anecdotes, measurements, opinions, dates, citations, or guarantees merely to make prose sound more human.

Treat pattern lists as prompts for judgment, not lexical bans. Keep a contrast when the reader is likely to hold the wrong model. Keep a hedge when evidence is limited. Keep repeated terminology when it prevents ambiguity.

## Review the whole document

Read the finished page in order after reviewing the diff.

- Check that headings work as table-of-contents labels and use sentence case.
- Check that the introduction matches what the page actually delivers.
- Check that each step starts from the state produced by the previous step.
- Check that examples use the same names and assumptions throughout.
- Check links, filenames, commands, code, and stated outcomes against the repository.
- Search for the same feature, option, command, and old terminology across the documentation. Resolve contradictions by updating related claims or linking to the canonical page.
- Check that warnings explain the concrete risk and the action that avoids it.
- Check headings, links, images, tables, and instructions against the accessibility and global-audience rules in [references/docs-practice.md](references/docs-practice.md).
- Cut duplicated conclusions and paragraphs that only announce importance.

When asked for an audit only, report prioritized, concrete findings without editing. Otherwise, make the edits and summarize only material changes.

## Verify

Run the narrowest checks that cover the changed artifact:

```bash
pnpm lint:quick
pnpm --dir docs build
git diff --check
```

Use additional tests when code samples or generated reference material depend on executable behavior. If a repository-wide check is already broken, record the pre-existing failure and still run any independent checks that remain meaningful.
