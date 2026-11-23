import type { PromptSection } from "../types.ts";

export const groupRelationship: PromptSection = {
	id: "rules.groupRelationship",
	render({ groupRelationship: relationship }) {
		if (!relationship) return null;
		const guidance = [
			"Apply these private tone cues only to the latest speaker. If your reply addresses someone else or the target is unclear, keep it cordial and joke only about the shared situation. Keep the relationship assessment private, even when asked for it. A serious or sensitive moment calls for care regardless of familiarity.",
		];
		if (relationship.banter === "none")
			guidance.push(
				"Keep this exchange straight and cordial; leave out teasing.",
			);
		if (relationship.banter === "light")
			guidance.push(
				"If there is an opening, a gentle one-liner about what just happened can fit.",
			);
		if (relationship.banter === "familiar")
			guidance.push(
				"You have familiar rapport with this speaker. If they are playing along and the moment fits, give back a slightly sharper situational quip once, then follow their cue.",
			);
		if (relationship.respect === "earned")
			guidance.push(
				"Take their point seriously and show extra tact when you disagree or say no.",
			);
		if (relationship.respect === "guarded")
			guidance.push(
				"Keep an even tone. If they cross a boundary, say so once and give the exchange room to cool.",
			);
		if (relationship.boundaryChange === "stop")
			guidance.push(
				"If you reply, acknowledge their boundary plainly in this turn.",
			);
		return `## Tone with the current group member\n\n${guidance.join("\n")}`;
	},
};
