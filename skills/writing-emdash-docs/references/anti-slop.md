# Anti-slop editing reference

Use this pass after the document is factually complete. Judge what each sentence does. Treat word lists as prompts: a flagged phrase may be legitimate, and an unfamiliar phrase can still perform the same bad pattern.

## Contents

- [The central test](#the-central-test)
- [Staged reveals](#staged-reveals)
- [Missing precision](#missing-precision)
- [Generic AI vocabulary](#generic-ai-vocabulary)
- [Structure and rhythm](#structure-and-rhythm)
- [Chatbot and diff residue](#chatbot-and-diff-residue)
- [Avoid overcorrection](#avoid-overcorrection)
- [Final questions](#final-questions)

## The central test

Ask whether a sentence is **stating** information or **staging** it.

Stated prose puts the subject, behavior, and consequence on the page. Staged prose withholds a noun, invents a contrast, labels its own significance, or manufactures a beat before delivering the fact.

> Staged: It is not just a schema change. It is the key to a more flexible content model.
>
> Stated: Adding the field changes the collection schema and makes the field available to every entry in that collection.

Also ask whether a paragraph could describe any CMS, API, or open-source project. If it could, replace generic praise or advice with verified EmDash behavior, or delete it.

Read the whole document before editing individual tics. Importance claims, vague transitions, and generic summaries often cover a contradiction, unsupported claim, missing prerequisite, or gap in the procedure. Report factual conflicts separately and leave their resolution to the author.

## Staged reveals

Look for these mechanisms:

- **Negation-first reveal:** "not just X, but Y", "the problem is not X; it is Y", or a straw-man interpretation the reader never proposed. State the supported behavior directly. Keep a contrast only when correcting a likely misconception or distinguishing two easily confused APIs.
- **Significance designation:** "the real issue", "what matters", "the key takeaway", "crucial", or "pivotal". Delete the ranking and state the fact that makes it important.
- **Deferred nouns and suspense:** "there is one catch", a paragraph-ending colon before the answer, or "here is where it gets interesting". Name the constraint when it first becomes relevant.
- **Rhetorical questions:** asking a question only to answer it in the next sentence. Replace both with one declarative sentence unless the question is a real heading readers use to navigate.
- **Drama beats:** isolated fragments, punch-line em dashes, or a short sentence placed alone for gravitas. Join the thought to its paragraph or state the result normally.
- **Aphoristic closers:** a quotable contrast or moral that restates the paragraph. End on the last useful fact or action.
- **Self-grading:** "this is rigorous", "worth noting", "the useful distinction", or "as the data clearly shows". Present the evidence and let the reader assess it.

## Missing precision

Replace style that hides the actual mechanism:

- Give agency to a real actor. Prefer "The runtime caches the result for the request" to "The cache takes care of repeated work."
- Name an available noun instead of pointing at it with "this", "that", "the former", "the latter", or "one thing".
- Replace structural and dressed metaphors such as "the hinge", "the seam", "load-bearing", "under the hood", "magic", or "wearing the costume of" with the concrete behavior.
- Replace promotional adjectives and verdicts with observable effects, requirements, names, or measurements.
- Use `is`, `has`, and `uses` when "serves as", "boasts", "features", or "offers" adds ceremony rather than meaning.
- Cut participle tails that claim significance: "highlighting", "showcasing", "underscoring", "ensuring", "fostering", or "reflecting". Keep the claim only if the evidence supports it, then give it a full sentence.
- Name who reported or measured a claim. Do not use "experts say", "developers agree", or other vague attribution.
- Preserve unusual, concrete details that the repository supports. Generic rewriting often smooths exact behavior into a broad claim that could describe any product.

## Generic AI vocabulary

Treat these as strong prompts to inspect the sentence, especially in clusters:

- delve, dive deep, embark, navigate the complexities
- tapestry, landscape, realm, ecosystem when used figuratively
- robust, seamless, scalable, cutting-edge, game-changing
- unlock, harness, elevate, leverage or utilize when `use` is accurate
- crucial, pivotal, myriad, plethora, transformative
- "in today's ...", "at the end of the day", "it is important to note", "that said"
- seam, fold, load-bearing, belt-and-suspenders
- footgun, rabbit hole, yak shaving, sane defaults, just works

Replace the phrase with specific behavior. If the sentence has no specific behavior, delete it.

## Structure and rhythm

Check the document above the sentence level:

- **Forced triads:** List the real number of items. Do not add or remove one to produce a set of three.
- **Staccato fragments:** Combine three or more short parallel fragments when they are a list disguised as prose.
- **Sentence uniformity:** Vary length according to the idea. Do not mechanically alternate short and long sentences.
- **Over-balanced sections:** Allocate space by reader need and risk, not symmetry.
- **False ranges:** Use "from X to Y" only for actual endpoints. Otherwise, list the topics.
- **Coy headings:** Replace "Why it matters", "What this really means", or verdict-shaped headings with a short label that names the section's content.
- **Broken hierarchy:** Remove duplicate page-title headings, skipped heading levels, headings followed immediately by subheadings, and decorative thematic breaks that substitute for structure.
- **Inline-header lists:** Avoid bold labels that merely repeat the first words of each bullet. Keep labels when they are real terms, option names, or an index.
- **List addiction:** Use prose for a connected argument and lists for genuinely parallel items or steps.
- **Table addiction:** Use a table for data with meaningful row and column relationships, not to decorate a short list or force unlike ideas into equal boxes.
- **Em-dash overuse:** Use an em dash for a useful inline aside, not to delay the point. Repeated punch-line dashes make technical prose sound manufactured.
- **Elegant variation:** Repeat the same technical term when it refers to the same thing. A synonym can imply a second concept.

## Chatbot and diff residue

Delete text that belongs to the generation process rather than the document:

- "Great question", "Certainly", "I hope this helps", or invitations to ask for more.
- "In this guide, we will explore", "let's dive in", "first, some background", or other throat-clearing.
- Praise, agreement, performed humility, or comments about how difficult the writing task was.
- "Now", "new", "previously", "was added", "was updated", or "replaces the old approach" in evergreen docs. Put version differences in release notes or an upgrade guide.
- Generic conclusions that summarize the outline without adding a result, action, or constraint.
- Placeholder instructions, prompt fragments, model citation markers, search-result links, tracking parameters, and other generation artifacts.

Verify every citation and external link. Confirm that it exists, resolves to the claimed source, and supports the adjacent statement. A polished rewrite does not repair an invented DOI, unrelated source, or unsupported attribution.

## Avoid overcorrection

Editing out AI tics must not flatten or falsify the document.

- Preserve necessary caveats, uncertainty, scope, and warnings.
- Preserve a negation that defines a real boundary or prevents a common error.
- Preserve lists, tables, headings, and bold terms when they improve lookup or navigation.
- Preserve deliberate voice in an authored post. Public EmDash docs use the neutral voice defined by the style guide.
- Preserve a surrounding page's established register unless that register conflicts with the EmDash style guide. A sudden polished or promotional passage is a quality problem even when each sentence passes alone.
- Never invent a fact, source, quote, measurement, date, opinion, or anecdote to add specificity.
- Never trade a precise technical term for a casual synonym merely to sound human.
- Do not optimize for evading AI detectors. Optimize for a reader completing a task accurately.

## Final questions

1. Could a sentence be deleted without costing the reader information or a needed transition?
2. Does any sentence tell the reader which sentence is important?
3. Does a heading name its contents when read alone in a table of contents?
4. Does the last paragraph add a result or action, or only restate the page's theme?
5. Did an edit change a claim, remove a caveat, or add unsupported specificity?
6. Does every example use real EmDash names and behavior?
