import { normalizeName } from "../../memory/queries.ts";
import type { SemanticFact } from "../../types.ts";
import type { PromptContext, PromptSection } from "../types.ts";

function formatTimeAgo(timestamp: number): string {
	const now = Date.now();
	const diffMs = now - timestamp;
	const diffHours = diffMs / (1000 * 60 * 60);
	const diffDays = diffMs / (1000 * 60 * 60 * 24);

	if (diffHours < 1) return "a moment ago";
	if (diffHours < 24) return `${Math.round(diffHours)} hours ago`;
	if (diffDays < 2) return "yesterday";
	if (diffDays < 7) return `${Math.round(diffDays)} days ago`;
	return `${Math.round(diffDays / 7)} weeks ago`;
}

function groupBySubject(
	facts: SemanticFact[],
): Array<{ displayName: string; facts: SemanticFact[] }> {
	const grouped = new Map<string, SemanticFact[]>();
	const displayNames = new Map<string, string>();
	for (const fact of facts) {
		const subject = fact.subject ?? "Unknown";
		const key = normalizeName(subject);
		const existing = grouped.get(key) ?? [];
		existing.push(fact);
		grouped.set(key, existing);
		const currentDisplay = displayNames.get(key) ?? "";
		if (subject.length > currentDisplay.length) {
			displayNames.set(key, subject);
		}
	}
	return Array.from(grouped, ([key, facts]) => ({
		displayName: displayNames.get(key) ?? key,
		facts,
	}));
}

export const memoryEpisodes: PromptSection = {
	id: "memory.episodes",
	render(ctx: PromptContext) {
		if (ctx.relevantEpisodes.length === 0) return null;
		const episodesText = ctx.relevantEpisodes
			.map((e) => `- [${formatTimeAgo(e.timestamp)}] ${e.summary}`)
			.join("\n");
		return `## Recent memories\nEpisodes from past conversations:\n${episodesText}`;
	},
};

export const memoryPermanentPersons: PromptSection = {
	id: "memory.permanentFacts.persons",
	render(ctx: PromptContext) {
		if (!ctx.permanentFacts?.length) return null;
		const personPermanent = ctx.permanentFacts.filter(
			(f) => f.category === "person",
		);
		if (personPermanent.length === 0) return null;

		let section =
			"## Core facts about people\nThese are permanent biographical facts you must NEVER forget.";
		for (const { displayName, facts } of groupBySubject(personPermanent)) {
			section += `\n### ${displayName}`;
			for (const fact of facts) {
				section += `\n  - ${fact.content}`;
			}
		}
		return section;
	},
};

export const memoryPermanentOther: PromptSection = {
	id: "memory.permanentFacts.other",
	render(ctx: PromptContext) {
		if (!ctx.permanentFacts?.length) return null;
		const otherPermanent = ctx.permanentFacts.filter(
			(f) => f.category !== "person",
		);
		if (otherPermanent.length === 0) return null;
		const text = otherPermanent.map((f) => `- ${f.content}`).join("\n");
		return `## Permanent facts\n${text}`;
	},
};

export const memoryPersons: PromptSection = {
	id: "memory.persons",
	render(ctx: PromptContext) {
		const personFacts = ctx.relevantFacts.filter(
			(f) => f.category === "person",
		);
		if (personFacts.length === 0) return null;

		const filtered = ctx.activeNames?.length
			? (() => {
					const activeNormalized = new Set(ctx.activeNames.map(normalizeName));
					return personFacts.filter(
						(f) => f.subject && activeNormalized.has(normalizeName(f.subject)),
					);
				})()
			: personFacts;

		if (filtered.length === 0) return null;

		let section =
			"## What you know about the members\nThis information is CONTEXT, not a script. Only mention a fact if it comes up NATURALLY in the conversation. NEVER force a mention. If the topic has no connection to what you know, don't bring it up.";
		for (const { displayName, facts } of groupBySubject(filtered)) {
			section += `\n### ${displayName}`;
			for (const fact of facts) {
				section += `\n  - ${fact.content}`;
			}
		}
		return section;
	},
};

export const memoryGeneralFacts: PromptSection = {
	id: "memory.generalFacts",
	render(ctx: PromptContext) {
		const generalFacts = ctx.relevantFacts.filter(
			(f) => f.category !== "person",
		);
		if (generalFacts.length === 0) return null;
		const text = generalFacts.map((f) => `- ${f.content}`).join("\n");
		return `## General facts\nOnly mention these facts if they're relevant to the current conversation topic.\n${text}`;
	},
};
