# Plugin review

A Worker that reviews one release of an EmDash registry plugin with one language model and returns cited findings. The labeler calls its `review()` method over a service binding for each configured model; it has no public routes.

## How a review runs

The labeler sends the verified bundle files, the listing text and the release's declared access. The Worker gives the model four tools over an in-memory copy of the bundle: `list_files`, `read_file`, `search` and `submit_review`. The model cannot run code, and nothing in the bundle is evaluated.

Trusted code checks each `submit_review` call before accepting it:

- Every text file must have been read in full.
- Each finding needs a known category and severity, a confidence from 0 to 1, and one to eight citations.
- Each citation's quote must appear on the cited line.

A rejected submission goes back to the model with the problems listed, up to three attempts. A review that ends without an accepted submission throws, and the labeler marks the code assessment unavailable.

## Prompt

The prompt in [`src/prompt.ts`](src/prompt.ts) is public. During an embargo, set the `PLUGIN_REVIEW_PROMPT_ADDENDUM` secret to append private guidance; remove it once the issue is disclosed. Change `PROMPT_VERSION` with every prompt change. The labeler stores it with each review, so the operator console shows which prompt reviewed a release. Changing it does not invalidate or re-run earlier assessments; to review an earlier release with a new prompt, re-run its assessment from the operator console.

## Configuration

| Secret                          | Required | Purpose                                       |
| ------------------------------- | -------- | --------------------------------------------- |
| `AI_GATEWAY_ACCOUNT_ID`         | Yes      | Account that owns the gateway.                |
| `AI_GATEWAY_NAME`               | Yes      | Gateway name.                                 |
| `AI_GATEWAY_TOKEN`              | Yes      | Gateway token, also used as the provider key. |
| `PLUGIN_REVIEW_PROMPT_ADDENDUM` | No       | Private guidance appended to the prompt.      |

Models are `anthropic/<id>`, `openai/<id>` or `workers-ai/<id>` specifiers, such as `workers-ai/@cf/zai-org/glm-5.3`, chosen by the labeler's `LABELER_CODE_REVIEW_MODELS`.

## Evaluation

See [`eval/README.md`](eval/README.md). Evaluation cases are kept out of the repository.
