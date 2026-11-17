# Reviewer evaluation

`run.ts` runs the reviewer against a set of plugin bundles with each model and reports whether each case produced the finding categories it expects. It calls the models through AI Gateway, like production, but runs locally and never touches the labeler.

The cases are not in this repository. Most are malicious bundles, and publishing them would hand attackers a list of what the reviewer is tested against. Keep them in a private location and point the runner at it.

## Case layout

Each case is a directory under the cases directory:

```text
cases/
  exfiltrates-content/
    case.json
    bundle/
      manifest.json
      backend.js
```

`case.json` holds what the labeler would send alongside the bundle, and the expected result:

```json
{
	"expect": ["malicious-code"],
	"listing": [{ "ref": "profile.description", "text": "Adds share buttons to posts." }],
	"declaredAccess": { "content": { "read": true } }
}
```

An empty `expect` list marks a clean case, which passes only when the reviewer reports nothing. Include clean cases: a reviewer that flags everything is as useless as one that flags nothing.

## Running

The runner reads `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_NAME` and `AI_GATEWAY_TOKEN` from the environment.

```bash
EVAL_CASES_DIR=/path/to/private/cases pnpm --filter @emdash-cms/plugin-review eval
```

| Option        | Default                                                              | Meaning                                                  |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `--cases-dir` | `EVAL_CASES_DIR`                                                     | Cases directory. The runner refuses one inside the repo. |
| `--models`    | `workers-ai/@cf/thinkingmachines/inkling-2-small,openai/gpt-6.1-sol` | Comma-separated model specifiers.                        |
| `--cases`     | all                                                                  | Comma-separated case directory names.                    |
| `--addendum`  | none                                                                 | File holding private prompt guidance to append.          |
| `--out`       | `<cases-dir>/../results/<timestamp>`                                 | Where to write one JSON result per case and model.       |
| `--prices`    | none                                                                 | JSON file of US dollars per million tokens, by model.    |
| `--reasoning` | the model's default                                                  | `low`, `medium` or `high`, sent as the reasoning effort. |

Specifiers are `anthropic/<id>`, `openai/<id>` or `workers-ai/<id>`, for example `workers-ai/@cf/zai-org/glm-5.3`.

Each line of output is `pass` or `FAIL`, the model, the case, the wall time, and the categories found, the error, or `declined:` with the provider's refusal text. A declined review counts as a failure. The exit code is 1 when any case fails.

Each line also shows the model turns and the input and output tokens, summed over every model call in the review, including a review that fails or is declined. With `--prices`, it shows the cost too. After each model's cases, a `total` line sums them. A price file looks like this; cache prices default to the input price:

```json title="prices.json"
{
	"workers-ai/@cf/zai-org/glm-5.3": { "input": 1.4, "cacheRead": 0.26, "output": 4.4 }
}
```
