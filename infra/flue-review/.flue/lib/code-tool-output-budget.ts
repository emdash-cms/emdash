import { utf8ByteLength } from "./byte-budget.js";

export const MAX_CODE_TOOL_OUTPUT_BYTES = 256 * 1024;

export function assertCodeToolOutputWithinBudget(
	output: string,
	maxBytes = MAX_CODE_TOOL_OUTPUT_BYTES,
): void {
	const bytes = utf8ByteLength(output);
	if (bytes <= maxBytes) return;
	throw new Error(
		`code tool output is ${bytes} bytes, exceeding the ${maxBytes}-byte limit. Return a smaller targeted excerpt: slice file content before returning it, or use state.searchFiles or state.searchText with bounded matches.`,
	);
}

export function formatCodeToolOutput(
	resultText: string,
	logs?: readonly string[],
	maxBytes = MAX_CODE_TOOL_OUTPUT_BYTES,
): string {
	const logsText = logs?.length ? `\n\n--- logs ---\n${logs.join("\n")}` : "";
	const output = resultText + logsText;
	assertCodeToolOutputWithinBudget(output, maxBytes);
	return output;
}
