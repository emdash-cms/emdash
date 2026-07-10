import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as ComEmdashcmsExperimentalLabelerDefs from "./defs.js";

const _mainSchema = /*#__PURE__*/ v.query(
	"com.emdashcms.experimental.labeler.getAssessment",
	{
		params: /*#__PURE__*/ v.object({
			/**
			 * @minLength 1
			 * @maxLength 64
			 */
			id: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(1, 64),
			]),
		}),
		output: {
			type: "lex",
			get schema() {
				return ComEmdashcmsExperimentalLabelerDefs.publicAssessmentSchema;
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
		"com.emdashcms.experimental.labeler.getAssessment": mainSchema;
	}
}
