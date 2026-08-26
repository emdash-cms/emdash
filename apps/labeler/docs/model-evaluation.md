# Listing moderation model evaluation

The deployed labeler uses AI findings as advisory evidence. Automatic positive decisions remain
disabled because the protected evaluation did not meet the automatic-pass safety gates.

## Selected advisory models

The current advisory bundle uses the following Workers AI catalog models:

- Text: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Images: `@cf/qwen/qwen3.8-27b`, with thinking disabled and a 512-pixel WebP derivative

The text prompt is `listing-text-v7`, with content hash
`6190ae294c1ffae4f7c5996b8836a128dd214d2a36ae18ab8e7ff3fe4492f076`. The image prompt is
`listing-image-v5`, with content hash
`3ffb045c3af8a5787387f21ced7375170000323a4c9557bf89d68079d77866f3`. The runtime computes
these hashes from the embedded prompts; operators do not configure separate prompt-hash values.

## Candidate selection

The candidate sweep started from the live Workers AI catalog rather than a fixed list from model
documentation. It evaluated current general models, older controls, specialist moderation models,
and native vision interfaces. The evaluated families included GPT-OSS, GLM, DeepSeek, Nemotron,
Gemma, Kimi, Qwen, Llama, Llama Guard, Moondream, and LLaVA.

The public development corpus contains 24 fixtures: 18 text cases and six image cases. It covers
all eight finding categories, clean inputs, borderline wording, prompt injection, Unicode
confusables, multilingual text, long input, and redacted realistic input. The development sweep
also found provider-interface differences that required support for OpenAI-compatible choice
envelopes, provider-parsed objects, native vision inputs, server-sent event responses, and models
whose native thinking mode must be disabled.

The first broad sweep passed the output schema directly as `response_format.json_schema`. The live
schemas for current OpenAI-compatible models instead require
`json_schema: { name, schema, strict }`. The earlier invalid-JSON results for DeepSeek V4, Gemma 4,
GLM, GPT-OSS 120B, Kimi, Nemotron 3, Qwen 3.8 text, and Llama 3.2 Vision therefore mix adapter
incompatibility with model behavior and cannot be used as model-quality evidence.

A four-case diagnostic used the nested strict schema and disabled thinking for GLM 5.2 and Kimi
K2.7 Code. GLM returned valid, correct JSON for all four cases. Kimi handled the two simpler cases,
but exhausted 1,024 completion tokens and returned empty content for the two phishing cases. With
`max_completion_tokens` and low reasoning effort, Kimi handled the prompt-injected phishing case
at 1,227 completion tokens. The Unicode-confusable case still exhausted 4,096 completion tokens
and returned empty content. Raw provider responses were retained for these diagnostics.

A corrected one-pass GLM 5.2 run covered all 318 text fixtures. Two transient provider errors were
retried, and all fixtures received a model response. Twenty-three expected-review rows resolved to
pass: 12 rows represented five distinct phishing patterns, while 11 were synthetic lookalike-link
variants whose expectations require separate validation. Six responses exhausted the 2,048-token
limit while emitting an unfinished JSON object followed by whitespace. GLM did not send a clean
case to review. P95 latency was 9.93 seconds. The artifact has SHA-256 digest
`6275ba4f4bd3d1bff8c7b0c7247bd53029a87378a9874053d89b743740b9441e`.

On the earlier public corpus, Llama produced 51 valid text results across three repeats without a
pass/review error. The password-form screenshots are benign negative controls: an image of a
credential form is passive UI evidence and cannot establish phishing or credential solicitation.
Under image prompt v5, Qwen matched all six corrected image outcomes and categories without an
invalid output or model error. P95 latency was 33.35 seconds, above the 15-second evaluation
budget. Exact category assignments remain an advisory quality metric rather than an automatic-pass
safety claim.

## Protected validation

The first protected corpus contained 400 cases: 300 expected-review cases, 100 expected-pass
cases, and 100 images. It was used for candidate selection and is retained separately from the
promotion holdout.

Llama caught every prohibited text case but sent four clean variants of the same independent
compatibility statement to review. The statement was added to the public development corpus, and
the text prompt was clarified to treat explicit independent, unaffiliated, or compatibility-only
statements as non-impersonation. Llama then passed the public regression and five protected
variants in all 18 repeated calls.

Nemotron 3 was the only alternative text model to pass the 55-case clean screen without an
error. A later screen against 15 hard prohibited cases produced five unsafe passes, six model
errors, one invalid output, and three correct reviews. GLM 5.2 and GPT-OSS 120B each failed a
clean case during the earlier screen, before the response-format correction. None replaced Llama.

## Promotion evaluation

The frozen three-repeat evaluation used promotion dataset
`d9b8ecfec2b9662e193b6a927939c9d72d966ab0ffc805916b337658dea5dbb6`. Its artifact has SHA-256
digest `0ee8eedfc76288d713823788dd1ec3baa5ce846959e9ec15d90b19d6c9fc14a4`.

The combined run made 1,275 model calls. It produced no invalid model output, model error, coverage
failure, or missing usage record. P95 model latency was 9.30 seconds. The decision gates failed:

- 38 protected prohibited fixtures passed in at least one repeat.
- 14 fixtures changed decision or category across repeats.
- 109 individual repeated runs disagreed with the expected pass/review outcome.

Fifteen fixture rows were text failures, but they represented four unique strings. Six duplicate
rows contained one credential-solicitation sentence that Llama missed in every repeat. Two unique
prompt-injection cases each failed in one of three repeats. Seven duplicate rows asserted an
independently measured installation count without giving the model evidence that the count was
false; those rows were not valid misleading-claim tests. The genuine phishing misses and repeated
disagreement still block automatic passing.

Twenty-three unsafe fixtures were images. The generated images were text-only cards rather than
representative visual content, and visual inspection found that the PNGs omitted their body text
because the SVG renderer did not paint the `foreignObject` content. Those image results do not
establish a Qwen regression. The genuine text failures are sufficient to reject the model bundle
without relying on the defective image cases.

The manifest therefore sets `promotionEnabled` to `false`. The runtime keeps `autoPass` disabled,
and the promotion code rejects this corpus even if a caller presents an otherwise valid review
credential.

## Promotion requirements

The promotion path requires all of the following evidence:

- Three or more repeats.
- At least 300 protected expected-review fixtures and 100 protected expected-pass fixtures.
- At least 100 protected image fixtures and 30 protected fixtures for every finding category.
- No unsafe pass in any repeat.
- No invalid output, model error, incomplete coverage, missing usage, or expected-outcome error.
- No repeated-run disagreement and P95 latency within the configured budget.

Zero unsafe passes across 300 independent expected-review cases gives a one-sided 95% binomial
upper bound just below 1%. This calculation assumes representative independent cases; synthetic
variations alone do not establish the same real-world error rate. A future promotion corpus must
remain untouched during model and prompt selection, and generated images must be rendered and
visually checked before their commitment is published.
