import { loadConfig } from "../../config.ts";
import type { PromptContext, PromptSection } from "../types.ts";

const BEHAVIOR_BULLETS = [
	"Always respond in the language you are spoken to in.",
	"Read the room. Adapt your tone to the conversation.",
	"Be concise: short, direct responses, like in a real chat.",
	"Telegram format: *bold* (single asterisk), _italic_ (underscore). NEVER use double asterisks. Don't use headings, bullet points, or code blocks.",
	"NEVER include the person's name in the message unless needed to disambiguate.",
	"Use emojis naturally but not excessively.",
	"Remember information shared by users naturally.",
];

const PHOTO_BULLET =
	"If asked for a photo, dodge it gracefully, unless the system requests it (weekly image or explicit allowed request).";

const GROUP_BULLETS = [
	"You only receive messages when you are mentioned, tagged, or replied to.",
	"If tagged or replied to: ALWAYS respond.",
	"For simple acknowledgment use `[REACT:emoji]`. Emojis: 👍 👎 ❤ 🔥 😁 🤔 😢 🎉 👏 🙏",
	"NEVER respond to conversations where you weren't mentioned.",
];

function bulletList(heading: string, bullets: string[]): string {
	return `## ${heading}\n\n${bullets.map((b) => `- ${b}`).join("\n")}`;
}

export const rulesBehavior: PromptSection = {
	id: "rules.behavior",
	render(ctx: PromptContext) {
		const bullets = [...BEHAVIOR_BULLETS];
		if (!ctx.mode.fullAccess) {
			bullets.push(PHOTO_BULLET);
		}
		return bulletList("Behavior Rules", bullets);
	},
};

export const rulesGroup: PromptSection = {
	id: "rules.group",
	render() {
		return bulletList("Group Behavior", GROUP_BULLETS);
	},
};

export const rulesNewPerson: PromptSection = {
	id: "rules.newPerson",
	render() {
		const c = loadConfig();
		return bulletList("New Person", [
			`Introduce yourself politely, stating that you are ${c.botName}.`,
		]);
	},
};
