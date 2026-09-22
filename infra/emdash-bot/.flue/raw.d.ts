declare module "*?raw" {
	const content: string;
	export default content;
}

declare module "*/SKILL.md" {
	import type { SkillReference } from "@flue/runtime";

	const skill: SkillReference;
	export default skill;
}
