import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as ComEmdashcmsExperimentalLabellerDefs from "./defs.js";

const _mainSchema = /*#__PURE__*/ v.query(
	"com.emdashcms.experimental.labeller.listAssessments",
	{
		params: /*#__PURE__*/ v.object({
			cid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.cidString()),
			/**
			 * @maxLength 1024
			 */
			cursor: /*#__PURE__*/ v.optional(
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
					/*#__PURE__*/ v.stringLength(0, 1024),
				]),
			),
			/**
			 * @minimum 1
			 * @maximum 100
			 * @default 50
			 */
			limit: /*#__PURE__*/ v.optional(
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
					/*#__PURE__*/ v.integerRange(1, 100),
				]),
				50,
			),
			src: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.didString()),
			state: /*#__PURE__*/ v.optional(
				/*#__PURE__*/ v.string<
					| "blocked"
					| "error"
					| "passed"
					| "pending"
					| "superseded"
					| "warned"
					| (string & {})
				>(),
			),
			uri: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.resourceUriString()),
		}),
		output: {
			type: "lex",
			schema: /*#__PURE__*/ v.object({
				/**
				 * @maxLength 100
				 */
				get assessments() {
					return /*#__PURE__*/ v.constrain(
						/*#__PURE__*/ v.array(
							ComEmdashcmsExperimentalLabellerDefs.publicAssessmentSchema,
						),
						[/*#__PURE__*/ v.arrayLength(0, 100)],
					);
				},
				/**
				 * @maxLength 1024
				 */
				cursor: /*#__PURE__*/ v.optional(
					/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
						/*#__PURE__*/ v.stringLength(0, 1024),
					]),
				),
			}),
		},
	},
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params extends v.InferInput<mainSchema["params"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
	interface XRPCQueries {
		"com.emdashcms.experimental.labeller.listAssessments": mainSchema;
	}
}
