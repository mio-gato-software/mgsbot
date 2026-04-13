import { getPersonalityInstructions } from "../../personality.ts";
import type { PromptSection } from "../types.ts";

export const personalityTraits: PromptSection = {
	id: "personality.traits",
	async render() {
		const instructions = await getPersonalityInstructions();
		return instructions ? instructions : null;
	},
};
