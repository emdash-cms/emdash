import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as ComEmdashcmsExperimentalLabelerDefs from "./defs.js";

const _mainSchema = /*#__PURE__*/ v.query(
	"com.emdashcms.experimental.labeler.getCurrentAssessment",
	{
		params: /*#__PURE__*/ v.object({
			cid: /*#__PURE__*/ v.cidString(),
			src: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.didString()),
			uri: /*#__PURE__*/ v.resourceUriString(),
		}),
		output: {
			type: "lex",
			get schema() {
				return ComEmdashcmsExperimentalLabelerDefs.currentAssessmentViewSchema;
			},
		},
	},
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params extends v.InferInput<mainSchema["params"]> {}
export type $output = v.InferXRPCBodyInput<mainSchema["output"]>;

declare module "@atcute/lexicons/ambient" {
	interface XRPCQueries {
		"com.emdashcms.experimental.labeler.getCurrentAssessment": mainSchema;
	}
}
