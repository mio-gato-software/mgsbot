import { describe, expect, test } from "bun:test";
import { getSuppressedIds } from "../src/prompt/modes.ts";
import { PIPELINE } from "../src/prompt/pipeline.ts";
import {
	imageAllowedPhotoRequest,
	imageEditUserAttached,
	imageFullAccess,
	imageWeekly,
} from "../src/prompt/sections/image.ts";
import {
	memoryEpisodes,
	memoryGeneralFacts,
	memoryPermanentOther,
	memoryPermanentPersons,
	memoryPersons,
} from "../src/prompt/sections/memory.ts";
import { rulesBehavior } from "../src/prompt/sections/rules.ts";
import { voiceTts, voiceTutor } from "../src/prompt/sections/voice.ts";
import type { PromptContext } from "../src/prompt/types.ts";
import type { Episode, SemanticFact } from "../src/types.ts";

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
	return {
		relevantEpisodes: [],
		relevantFacts: [],
		permanentFacts: undefined,
		activeNames: undefined,
		mentionType: undefined,
		isVoiceMessage: false,
		userAttachedImage: false,
		shouldGenerateImage: false,
		allowPhotoRequest: false,
		ttsAvailable: false,
		mode: { simpleAssistant: false, fullAccess: false, tutor: false },
		...overrides,
	};
}

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id: "fact_1",
		content: "Likes coffee",
		category: "person",
		subject: "Juan",
		embedding: [],
		importance: 3,
		confidence: 1,
		createdAt: Date.now(),
		lastConfirmed: Date.now(),
		...overrides,
	};
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
	return {
		id: "ep_1",
		summary: "Casual conversation about the day",
		participants: ["Juan"],
		timestamp: Date.now() - 3600_000,
		importance: 3,
		embedding: [],
		...overrides,
	};
}

describe("getSuppressedIds", () => {
	test("normal mode suppresses only mode-specific sections", () => {
		const ids = getSuppressedIds(makeCtx());
		expect(ids.has("image.fullAccess")).toBe(true);
		expect(ids.has("voice.tutor")).toBe(true);
		expect(ids.has("image.weekly")).toBe(false);
	});

	test("full access suppresses weekly image and allowed request", () => {
		const ids = getSuppressedIds(
			makeCtx({
				mode: { simpleAssistant: false, fullAccess: true, tutor: false },
			}),
		);
		expect(ids.has("image.weekly")).toBe(true);
		expect(ids.has("image.allowedPhotoRequest")).toBe(true);
		expect(ids.has("image.fullAccess")).toBe(false);
	});

	test("tutor mode keeps voice.tutor active", () => {
		const ids = getSuppressedIds(
			makeCtx({
				mode: { simpleAssistant: false, fullAccess: false, tutor: true },
			}),
		);
		expect(ids.has("voice.tutor")).toBe(false);
	});
});

describe("pipeline structure", () => {
	test("contains all expected section ids in order", () => {
		const ids = PIPELINE.map((s) => s.id);
		const expected = [
			"identity.personality",
			"rules.behavior",
			"rules.group",
			"rules.newPerson",
			"header.datetime",
			"personality.traits",
			"memory.episodes",
			"memory.permanentFacts.persons",
			"memory.permanentFacts.other",
			"memory.persons",
			"memory.generalFacts",
			"activity.current",
			"time.awareness",
			"weather.current",
			"image.weekly",
			"image.editUserAttached",
			"image.allowedPhotoRequest",
			"voice.tts",
			"mention.groupName",
			"image.fullAccess",
			"voice.tutor",
		];
		expect(ids).toEqual(expected);
	});

	test("all section ids are unique", () => {
		const ids = PIPELINE.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("section: rules.behavior", () => {
	test("includes photo bullet in normal mode", async () => {
		const out = (await rulesBehavior.render(makeCtx())) ?? "";
		expect(out).toContain("If asked for a photo");
	});

	test("omits photo bullet in full-access mode", async () => {
		const out =
			(await rulesBehavior.render(
				makeCtx({
					mode: { simpleAssistant: false, fullAccess: true, tutor: false },
				}),
			)) ?? "";
		expect(out).not.toContain("If asked for a photo");
		expect(out).toContain("Behavior Rules");
	});
});

describe("section: image.fullAccess", () => {
	test("no override boilerplate", async () => {
		const out = await imageFullAccess.render(makeCtx());
		expect(out).toBeTruthy();
		expect(out).not.toMatch(/overrides/i);
		expect(out).not.toMatch(/dodge/i);
	});

	test("defines both IMAGE and IMAGE_SELF markers", async () => {
		const out = (await imageFullAccess.render(makeCtx())) ?? "";
		expect(out).toContain("[IMAGE:");
		expect(out).toContain("[IMAGE_SELF:");
	});
});

describe("section: memory.episodes", () => {
	test("returns null when no episodes", async () => {
		expect(await memoryEpisodes.render(makeCtx())).toBeNull();
	});

	test("renders episode summaries when present", async () => {
		const out = await memoryEpisodes.render(
			makeCtx({ relevantEpisodes: [makeEpisode()] }),
		);
		expect(out).toContain("## Recent memories");
		expect(out).toContain("Casual conversation");
	});
});

describe("section: memory.permanentFacts", () => {
	test("persons section groups by subject", async () => {
		const ctx = makeCtx({
			permanentFacts: [
				makeFact({ id: "f1", subject: "Juan", content: "Born in Santiago" }),
				makeFact({ id: "f2", subject: "Juan", content: "Is an engineer" }),
			],
		});
		const out = (await memoryPermanentPersons.render(ctx)) ?? "";
		expect(out).toContain("### Juan");
		expect(out).toContain("Born in Santiago");
		expect(out).toContain("Is an engineer");
	});

	test("other section renders non-person permanent facts", async () => {
		const ctx = makeCtx({
			permanentFacts: [
				makeFact({
					category: "group",
					subject: undefined,
					content: "This is the family chat",
				}),
			],
		});
		const out = (await memoryPermanentOther.render(ctx)) ?? "";
		expect(out).toContain("## Permanent facts");
		expect(out).toContain("This is the family chat");
	});

	test("returns null when permanentFacts is empty", async () => {
		expect(await memoryPermanentPersons.render(makeCtx())).toBeNull();
		expect(await memoryPermanentOther.render(makeCtx())).toBeNull();
	});
});

describe("section: memory.persons", () => {
	test("filters by activeNames when provided", async () => {
		const ctx = makeCtx({
			relevantFacts: [
				makeFact({ id: "f1", subject: "Juan" }),
				makeFact({ id: "f2", subject: "María", content: "Lives in Madrid" }),
			],
			activeNames: ["Juan"],
		});
		const out = (await memoryPersons.render(ctx)) ?? "";
		expect(out).toContain("Juan");
		expect(out).not.toContain("María");
	});

	test("returns null when filter removes all facts", async () => {
		const ctx = makeCtx({
			relevantFacts: [makeFact({ subject: "Juan" })],
			activeNames: ["Pedro"],
		});
		expect(await memoryPersons.render(ctx)).toBeNull();
	});
});

describe("section: memory.generalFacts", () => {
	test("renders only non-person facts", async () => {
		const ctx = makeCtx({
			relevantFacts: [
				makeFact({ category: "person" }),
				makeFact({
					category: "rule",
					subject: undefined,
					content: "Never double asterisks",
				}),
			],
		});
		const out = (await memoryGeneralFacts.render(ctx)) ?? "";
		expect(out).toContain("Never double asterisks");
		expect(out).not.toContain("Likes coffee");
	});
});

describe("section: image.*", () => {
	test("weekly returns null when shouldGenerateImage is false", async () => {
		expect(await imageWeekly.render(makeCtx())).toBeNull();
	});

	test("editUserAttached returns null without an attached image", async () => {
		expect(await imageEditUserAttached.render(makeCtx())).toBeNull();
	});

	test("editUserAttached renders when userAttachedImage is true", async () => {
		const out = await imageEditUserAttached.render(
			makeCtx({ userAttachedImage: true }),
		);
		expect(out).toContain("## Image editing");
	});

	test("allowedPhotoRequest renders when flag is set", async () => {
		const out = await imageAllowedPhotoRequest.render(
			makeCtx({ allowPhotoRequest: true }),
		);
		expect(out).toContain("Temporary photo-on-request exception");
	});
});

describe("section: voice.*", () => {
	test("tts returns null when not available", async () => {
		expect(await voiceTts.render(makeCtx())).toBeNull();
	});

	test("tts renders when ttsAvailable is true", async () => {
		const out = (await voiceTts.render(makeCtx({ ttsAvailable: true }))) ?? "";
		expect(out).toContain("[TTS]");
	});

	test("tts adds voice-note hint when user sent a voice message", async () => {
		const out =
			(await voiceTts.render(
				makeCtx({ ttsAvailable: true, isVoiceMessage: true }),
			)) ?? "";
		expect(out).toContain("sent you a voice note");
	});

	test("tutor renders tutor instructions", async () => {
		const out = (await voiceTutor.render(makeCtx())) ?? "";
		expect(out).toContain("English tutor mode");
	});

	test("tutor adds voice preference when user sent a voice message", async () => {
		const out =
			(await voiceTutor.render(makeCtx({ isVoiceMessage: true }))) ?? "";
		expect(out).toContain("pronunciation");
	});
});
