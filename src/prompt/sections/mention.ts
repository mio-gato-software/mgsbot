import { getBotName } from "../../config.ts";
import type { PromptContext, PromptSection } from "../types.ts";

export const mentionGroupName: PromptSection = {
	id: "mention.groupName",
	render(ctx: PromptContext) {
		if (ctx.mentionType !== "name") return null;
		const botName = getBotName();
		return `## Mention context (group)
The user mentioned your name in the message. Evaluate whether they're talking DIRECTLY to you or just mentioning you while speaking to others.
- If they're talking to you (e.g., "${botName}, what do you think?", "Hey ${botName}"): respond normally
- If they're just mentioning you without addressing you (e.g., "I was telling María about ${botName}", "${botName} said something funny yesterday"): respond exactly \`[SILENCE]\` to avoid interrupting`;
	},
};
