import { z } from "zod";
import {
	classifyGroupRelationshipTurn,
	type GroupRelationshipDecision,
	type GroupRelationshipTurn,
	groupRelationshipDecisionSchema,
	RELATIONSHIP_TURN_MAX_CHARS,
	relationshipTurnExcerpt,
} from "./ai/group-relationship-classifier.ts";
import { log } from "./logger.ts";
import { withGroupMemberLock } from "./memory/locks.ts";
import { readStore, writeStore } from "./memory/storage.ts";
import { currentOperationSignal } from "./operation-deadline.ts";
import { memoryPath } from "./runtime-paths.ts";
import { truncateText } from "./utils.ts";

export type { GroupRelationshipTurn } from "./ai/group-relationship-classifier.ts";

const TRUST_LIMIT = 6;
const RESPECT_LIMIT = 4;
const CHANGE_INTERVAL_MS = 5 * 60_000;
const id = z.number().int().safe().positive();
const timestamp = z.number().int().safe().nonnegative();

const postureSchema = z.object({
	banter: z.enum(["none", "light", "familiar"]),
	respect: z.enum(["guarded", "neutral", "earned"]),
	boundary: z.enum(["none", "avoid_teasing", "avoid_topic_teasing"]),
	boundaryChange: z.enum(["stop", "reopen"]).optional(),
});

export type GroupRelationshipPosture = z.infer<typeof postureSchema>;

export const CONSERVATIVE_GROUP_POSTURE: GroupRelationshipPosture = {
	banter: "none",
	respect: "neutral",
	boundary: "none",
};

const memberSchema = z.object({
	trust: z.number().int().min(0).max(TRUST_LIMIT),
	respect: z.number().int().min(-RESPECT_LIMIT).max(RESPECT_LIMIT),
	globalBoundary: z.boolean(),
	topics: z.array(
		z.object({
			id,
			evidence: z.string().min(1).max(RELATIONSHIP_TURN_MAX_CHARS),
			context: z.array(z.string().max(300)).max(2).optional(),
		}),
	),
	lastTrustSignalAt: timestamp.optional(),
	lastRespectSignalAt: timestamp.optional(),
	lastRepairAt: timestamp.optional(),
	latestTurn: z.object({ messageId: id, posture: postureSchema }).optional(),
});

type GroupMember = z.infer<typeof memberSchema>;

function initialMember(): GroupMember {
	return {
		trust: 0,
		respect: 0,
		globalBoundary: false,
		topics: [],
	};
}

function memberPosture(
	member: GroupMember,
	decision: GroupRelationshipDecision,
	boundaryChange: GroupRelationshipPosture["boundaryChange"],
): GroupRelationshipPosture {
	const respect =
		member.respect < 0 ? "guarded" : member.respect > 1 ? "earned" : "neutral";
	const topicBlocked =
		decision.boundary === "stop_topic" ||
		decision.boundary === "stop_context_topic" ||
		(member.topics.length > 0 &&
			(decision.matchedTopic === undefined ||
				member.topics.some((topic) => topic.id === decision.matchedTopic)));
	const boundary = member.globalBoundary
		? "avoid_teasing"
		: topicBlocked
			? "avoid_topic_teasing"
			: "none";
	const canPlay =
		decision.room === "playful" &&
		decision.boundary === "none" &&
		boundary === "none" &&
		respect !== "guarded" &&
		!boundaryChange;
	return {
		banter: canPlay ? (member.trust >= 3 ? "familiar" : "light") : "none",
		respect,
		boundary,
		...(boundaryChange && { boundaryChange }),
	};
}

function updateAffinity(
	member: GroupMember,
	decision: GroupRelationshipDecision,
	at: number,
): void {
	// Leave both axes untouched when discussing a limit or when the model is
	// unsure whether a limit is being set.
	if (decision.boundary !== "none") return;
	const trustDelta =
		decision.rapport === "builds" ? 1 : decision.rapport === "breaks" ? -1 : 0;
	if (
		trustDelta &&
		(member.lastTrustSignalAt === undefined ||
			at - member.lastTrustSignalAt >= CHANGE_INTERVAL_MS)
	) {
		member.trust = Math.max(
			0,
			Math.min(TRUST_LIMIT, member.trust + trustDelta),
		);
		member.lastTrustSignalAt = at;
	}
	const repair = decision.regard === "repair";
	const respectDelta =
		decision.regard === "mistreatment"
			? -1
			: decision.regard === "consideration" || repair
				? 1
				: 0;
	const lastRespectSignalAt = repair
		? member.lastRepairAt
		: member.lastRespectSignalAt;
	if (
		respectDelta &&
		(lastRespectSignalAt === undefined ||
			at - lastRespectSignalAt >= CHANGE_INTERVAL_MS)
	) {
		member.respect = Math.max(
			-RESPECT_LIMIT,
			Math.min(RESPECT_LIMIT, member.respect + respectDelta),
		);
		if (repair) member.lastRepairAt = at;
		else member.lastRespectSignalAt = at;
	}
}

function boundaryContext(input: GroupRelationshipTurn): string[] {
	const context = input.replyTo?.text
		? [input.replyTo.text]
		: input.recentMessages.slice(-2).flatMap((message) => {
				const text =
					message.role === "model"
						? message.content
						: message.userTextVerified === true && message.userText;
				return text ? [text] : [];
			});
	return context.map((text) => truncateText(text, 300));
}

function applyBoundary(
	member: GroupMember,
	decision: GroupRelationshipDecision,
	input: GroupRelationshipTurn,
): GroupRelationshipPosture["boundaryChange"] {
	switch (decision.boundary) {
		case "stop_all":
			member.globalBoundary = true;
			return "stop";
		case "reopen_all":
			member.globalBoundary = false;
			return "reopen";
		case "stop_topic":
		case "stop_context_topic":
			if (!member.topics.some((topic) => topic.id === decision.matchedTopic)) {
				member.topics.push({
					id: input.messageId,
					evidence: relationshipTurnExcerpt(input.text),
					context:
						decision.boundary === "stop_context_topic"
							? boundaryContext(input)
							: undefined,
				});
			}
			return "stop";
		case "reopen_topic": {
			const index = member.topics.findIndex(
				(topic) => topic.id === decision.matchedTopic,
			);
			if (index < 0) return undefined;
			member.topics.splice(index, 1);
			return "reopen";
		}
		default:
			return undefined;
	}
}

/**
 * Both passive and responding handlers may see the same Telegram message.
 * Keep one serialized assessment and atomic update per group/member, even
 * across restart. Older redeliveries have no effect and use the latest limits.
 */
export async function recordGroupRelationshipTurn(
	input: GroupRelationshipTurn,
	classify: typeof classifyGroupRelationshipTurn = classifyGroupRelationshipTurn,
): Promise<GroupRelationshipPosture> {
	if (
		!Number.isSafeInteger(input.chatId) ||
		input.chatId >= 0 ||
		!id.safeParse(input.userId).success ||
		!id.safeParse(input.messageId).success ||
		!input.text.trim()
	)
		return CONSERVATIVE_GROUP_POSTURE;
	const path = memoryPath(
		"group-relationships",
		String(input.chatId),
		`${input.userId}.json`,
	);
	try {
		return await withGroupMemberLock(input.chatId, input.userId, async () => {
			const member = await readStore(path, memberSchema, initialMember);
			const previous = member.latestTurn;
			if (previous && input.messageId <= previous.messageId) {
				return input.messageId === previous.messageId
					? previous.posture
					: memberPosture(member, {}, undefined);
			}
			const text = input.text.trim();
			const classification = await classify({
				...input,
				text,
				topicBoundaries: member.topics,
			}).catch(() => {
				currentOperationSignal()?.throwIfAborted();
				log.warn(
					"[group-relationships] Classifier unavailable; using restrained posture.",
				);
				return null;
			});
			const parsed = groupRelationshipDecisionSchema.safeParse(classification);
			const decision = parsed.success ? parsed.data : {};
			const at = timestamp.safeParse(input.messageAt ?? Date.now());
			updateAffinity(member, decision, at.success ? at.data : Date.now());
			const boundaryChange = applyBoundary(member, decision, {
				...input,
				text,
			});
			const posture = memberPosture(member, decision, boundaryChange);
			member.latestTurn = { messageId: input.messageId, posture };
			currentOperationSignal()?.throwIfAborted();
			await writeStore(path, member, memberSchema, true);
			return posture;
		});
	} catch {
		currentOperationSignal()?.throwIfAborted();
		log.warn(
			"[group-relationships] Member memory unavailable; using restrained posture.",
		);
		return CONSERVATIVE_GROUP_POSTURE;
	}
}
