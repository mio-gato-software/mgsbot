import type { PromptContext, PromptSection } from "../types.ts";

export const mentionGroupName: PromptSection = {
	id: "mention.groupName",
	render(ctx: PromptContext) {
		if (ctx.mentionType !== "name") return null;
		return `## Group addressee
The latest speaker is addressing you directly. Respond to what they said in your usual voice, even if they continued without repeating your name.`;
	},
};
