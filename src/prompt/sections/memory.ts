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

function formatFactAge(fact: SemanticFact): string {
	const reference = fact.lastConfirmed ?? fact.createdAt;
	if (!reference) return "";
	return ` _(heard ${formatTimeAgo(reference)})_`;
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

export const memoryRelationship: PromptSection = {
	id: "memory.relationship",
	render(ctx: PromptContext) {
		const memory = ctx.relationshipMemory;
		if (!memory?.summary) return null;

		let section =
			"## Relationship memory\nThis is a living sense of the relationship, not a script. Let it influence tone subtly; don't mention it unless it naturally fits.";
		section += `\nTone: ${memory.tone}`;
		section += `\nSummary: ${memory.summary}`;

		const notableDynamics = memory.notableDynamics ?? [];
		const openThreads = memory.openThreads ?? [];

		if (notableDynamics.length > 0) {
			section += "\nNotable dynamics:";
			for (const dynamic of notableDynamics) {
				section += `\n  - ${dynamic}`;
			}
		}

		if (openThreads.length > 0) {
			section += "\nThreads that still feel alive:";
			for (const thread of openThreads) {
				section += `\n  - ${thread}`;
			}
		}

		return section;
	},
};

export const memoryChapters: PromptSection = {
	id: "memory.chapters",
	render(ctx: PromptContext) {
		if (!ctx.recentChapters?.length) return null;
		const chapters = ctx.recentChapters
			.map(
				(chapter) =>
					`- [${chapter.month}] ${chapter.title}: ${chapter.summary}`,
			)
			.join("\n");
		return `## Long-term chapters\nCompressed narrative memory from recent months. Use it for continuity, not as something to recite.\n${chapters}`;
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

		const relevantNames = [
			...(ctx.activeNames ?? []),
			...(ctx.mentionedNames ?? []),
		];
		const filtered = relevantNames.length
			? (() => {
					const activeNormalized = new Set(relevantNames.map(normalizeName));
					return personFacts.filter(
						(f) => f.subject && activeNormalized.has(normalizeName(f.subject)),
					);
				})()
			: personFacts;

		if (filtered.length === 0) return null;

		let section =
			"## What you know about the members\nThis information is CONTEXT, not a script. Each fact is annotated with when you heard it — treat older items skeptically (a plan or activity from days ago is likely no longer current). Only mention a fact if it comes up NATURALLY in the conversation. NEVER force a mention. If the topic has no connection to what you know, don't bring it up.";
		for (const { displayName, facts } of groupBySubject(filtered)) {
			section += `\n### ${displayName}`;
			for (const fact of facts) {
				section += `\n  - ${fact.content}${formatFactAge(fact)}`;
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
		const text = generalFacts
			.map((f) => `- ${f.content}${formatFactAge(f)}`)
			.join("\n");
		return `## General facts\nEach fact is annotated with when you heard it — older items may be stale. Only mention these facts if they're relevant to the current conversation topic.\n${text}`;
	},
};
