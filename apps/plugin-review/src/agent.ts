import { Type, type AssistantMessage, type Context, type Tool } from "@earendil-works/pi-ai";

import { PROMPT_VERSION, systemPrompt } from "./prompt.js";
import { checkSubmission } from "./submission.js";
import {
	REVIEW_CATEGORIES,
	SEVERITIES,
	type PluginReviewRequest,
	type PluginReviewResponse,
} from "./types.js";
import { BundleWorkspace, ToolInputError } from "./workspace.js";

export const MAX_TURNS = 60;
const MAX_SUBMISSIONS = 3;
const MAX_NUDGES = 2;

/** One model turn: the conversation so far in, the model's next message out. */
export interface ReviewModel {
	readonly id: string;
	complete(context: Context, signal: AbortSignal): Promise<AssistantMessage>;
}

export class ReviewFailedError extends Error {
	override readonly name = "ReviewFailedError";
}

/** The model's provider refused the request, for example under a safety policy. */
export class ReviewDeclinedError extends Error {
	override readonly name = "ReviewDeclinedError";

	readonly reply: AssistantMessage | undefined;

	constructor(message: string, reply?: AssistantMessage) {
		super(message);
		this.reply = reply;
	}
}

const TOOLS: Tool[] = [
	{
		name: "list_files",
		description: "List the files in the bundle with their sizes.",
		parameters: Type.Object({}),
	},
	{
		name: "read_file",
		description:
			"Read a text file from the bundle, up to 131,072 characters at a time, with line numbers. Call again with the returned offset until the file ends.",
		parameters: Type.Object({
			path: Type.String({ description: "File path from list_files." }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset to start at." }),
			),
		}),
	},
	{
		name: "search",
		description:
			"Search the bundle's text files and return matching lines with surrounding text. Literal by default.",
		parameters: Type.Object({
			query: Type.String(),
			path: Type.Optional(Type.String({ description: "Limit the search to one file." })),
			regex: Type.Optional(
				Type.Boolean({ description: "Treat the query as a JavaScript regular expression." }),
			),
			ignoreCase: Type.Optional(Type.Boolean()),
		}),
	},
	{
		name: "submit_review",
		description:
			"Submit the review. Call once, after reading every text file in full. Use an empty findings list when nothing qualifies.",
		parameters: Type.Object({
			summary: Type.String({
				description: "One or two sentences: what the plugin does and the conclusion.",
			}),
			findings: Type.Array(
				Type.Object({
					category: Type.Union(REVIEW_CATEGORIES.map((category) => Type.Literal(category))),
					severity: Type.Union(SEVERITIES.map((severity) => Type.Literal(severity))),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					summary: Type.String({
						description: "What the code does, why it harms an installing site, and how.",
					}),
					evidence: Type.Array(
						Type.Object({
							file: Type.String(),
							line: Type.Integer({ minimum: 1 }),
							quote: Type.String({ description: "Text copied exactly from that line." }),
						}),
					),
				}),
			),
		}),
	},
];

export async function runReview(
	request: PluginReviewRequest,
	model: ReviewModel,
	options: {
		addendum?: string;
		signal: AbortSignal;
		token?: string;
		/** Called with every model message, including the last one of a failed review. */
		onMessage?: (message: AssistantMessage) => void;
	},
): Promise<PluginReviewResponse> {
	const workspace = new BundleWorkspace(request.files, options.token ?? crypto.randomUUID());
	const context: Context = {
		systemPrompt: systemPrompt(options.addendum),
		messages: [
			{ role: "user", content: openingMessage(request, workspace), timestamp: Date.now() },
		],
		tools: TOOLS,
	};
	let submissions = 0;
	let nudges = 0;
	for (let turn = 0; turn < MAX_TURNS; turn += 1) {
		let message: AssistantMessage;
		try {
			// oxlint-disable-next-line no-await-in-loop -- each turn depends on the previous one
			message = await model.complete(context, options.signal);
			options.onMessage?.(message);
		} catch (error) {
			if (!(error instanceof ReviewDeclinedError)) throw error;
			if (error.reply) options.onMessage?.(error.reply);
			return {
				model: model.id,
				promptVersion: PROMPT_VERSION,
				summary: error.message.slice(0, 500),
				findings: [],
				declined: true,
			};
		}
		context.messages.push(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new ReviewFailedError(message.errorMessage ?? `${model.id} request failed`);
		}
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) {
			nudges += 1;
			if (nudges > MAX_NUDGES) {
				throw new ReviewFailedError(`${model.id} stopped without submitting a review`);
			}
			context.messages.push({
				role: "user",
				content: "Continue the review with the tools, and finish by calling submit_review.",
				timestamp: Date.now(),
			});
			continue;
		}
		const submitsWithOtherCalls = calls.some((call) => call.name !== "submit_review");
		for (const call of calls) {
			if (call.name === "submit_review" && submitsWithOtherCalls) {
				context.messages.push(
					toolResult(
						call.id,
						call.name,
						"Call submit_review on its own, after you have seen the results of your other tool calls.",
						true,
					),
				);
				continue;
			}
			if (call.name === "submit_review") {
				submissions += 1;
				const checked = checkSubmission(call.arguments, workspace);
				if ("submission" in checked) {
					return {
						model: model.id,
						promptVersion: PROMPT_VERSION,
						summary: checked.submission.summary,
						findings: checked.submission.findings,
					};
				}
				if (submissions >= MAX_SUBMISSIONS) {
					throw new ReviewFailedError(
						`${model.id} did not submit a valid review: ${checked.problems.join(" ")}`,
					);
				}
				context.messages.push(toolResult(call.id, call.name, checked.problems.join("\n"), true));
				continue;
			}
			try {
				context.messages.push(
					toolResult(call.id, call.name, runTool(workspace, call.name, call.arguments), false),
				);
			} catch (error) {
				if (!(error instanceof ToolInputError)) throw error;
				context.messages.push(toolResult(call.id, call.name, error.message, true));
			}
		}
	}
	throw new ReviewFailedError(`${model.id} used its turn budget without submitting a review`);
}

function runTool(workspace: BundleWorkspace, name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "list_files":
			return workspace.listFiles();
		case "read_file":
			return workspace.readFile(
				stringArgument(args, "path"),
				args["offset"] === undefined ? 0 : integerArgument(args, "offset"),
			);
		case "search":
			return workspace.search(stringArgument(args, "query"), {
				...(args["path"] === undefined ? {} : { path: stringArgument(args, "path") }),
				regex: args["regex"] === true,
				ignoreCase: args["ignoreCase"] === true,
			});
		default:
			throw new ToolInputError(`unknown tool ${name}`);
	}
}

function openingMessage(request: PluginReviewRequest, workspace: BundleWorkspace): string {
	const listing = request.listing.map(({ ref, text }) => `[${ref}]\n${text}`).join("\n\n");
	return [
		`Review release ${request.subject.version} of the plugin at ${request.subject.uri}.`,
		"",
		"Listing text, written by the publisher:",
		workspace.fence(listing || "(no listing text)"),
		"",
		"Declared access from the signed release record:",
		workspace.fence(JSON.stringify(request.declaredAccess, null, 2)),
		"",
		"Bundle files:",
		workspace.listFiles(),
	].join("\n");
}

function toolResult(toolCallId: string, toolName: string, text: string, isError: boolean) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError,
		timestamp: Date.now(),
	};
}

function stringArgument(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== "string") throw new ToolInputError(`${name} must be a string`);
	return value;
}

function integerArgument(args: Record<string, unknown>, name: string): number {
	const value = args[name];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new ToolInputError(`${name} must be an integer`);
	}
	return value;
}
