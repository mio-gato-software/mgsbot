import { z } from "zod";

const timestamp = z.number().finite().nonnegative();
const strings = z.array(z.string());
const embedding = z.array(z.number().finite());
const importance = z.number().min(1).max(5);
export const messageSchema = z
	.object({
		role: z.enum(["user", "model"]),
		content: z.string(),
		timestamp,
		name: z.string().optional(),
		userId: z.number().optional(),
		id: z.string().optional(),
	})
	.passthrough();
export const sensorySchema = z
	.object({
		chatId: z.number(),
		messages: z.array(messageSchema),
		lastActivity: timestamp,
		messageCountSincePromotion: z.number().int().nonnegative(),
		allowPhotoRequest: z.boolean().optional(),
		lastImageDate: z.string().optional(),
		imageTargetTime: z.string().optional(),
		imageTargetDate: z.string().optional(),
		schemaVersion: z.number().optional(),
	})
	.passthrough();
export const factSchema = z
	.object({
		appliedFactIds: strings.optional(),
		id: z.string(),
		content: z.string(),
		category: z.enum(["person", "group", "rule", "event"]),
		subject: z.string().optional(),
		context: z.string().optional(),
		embedding,
		embeddingModel: z.string().optional(),
		embeddingDim: z.number().int().nonnegative().optional(),
		importance,
		confidence: z.number().min(0).max(1),
		createdAt: timestamp,
		lastConfirmed: timestamp,
		lastRecalledAt: timestamp.optional(),
		lastDecayedAt: timestamp.optional(),
		scope: z.enum(["global", "chat", "person"]).optional(),
		sourceChatId: z.number().optional(),
		validUntil: timestamp.optional(),
		supersedes: strings.optional(),
		supersededBy: z.string().optional(),
		permanent: z.boolean().optional(),
	})
	.passthrough();
export const factsSchema = z.array(factSchema);
export const episodeSchema = z
	.object({
		id: z.string(),
		summary: z.string(),
		participants: strings,
		timestamp,
		importance,
		embedding,
		embeddingModel: z.string().optional(),
		embeddingDim: z.number().int().nonnegative().optional(),
	})
	.passthrough();
export const episodesSchema = z
	.object({
		chatId: z.number(),
		episodes: z.array(episodeSchema),
		schemaVersion: z.number().optional(),
	})
	.passthrough();
export const relationshipSchema = z
	.object({
		appliedEpisodeIds: strings.optional(),
		chatId: z.number(),
		summary: z.string(),
		tone: z.string(),
		notableDynamics: strings,
		openThreads: strings,
		updatedAt: timestamp,
		interactionCount: z.number().int().nonnegative(),
		schemaVersion: z.number().optional(),
	})
	.passthrough();
export const chapterSchema = z
	.object({
		id: z.string(),
		chatId: z.number(),
		month: z.string(),
		title: z.string(),
		summary: z.string(),
		participants: strings,
		importance,
		episodeIds: strings,
		updatedAt: timestamp,
	})
	.passthrough();
export const chaptersSchema = z
	.object({
		chatId: z.number(),
		chapters: z.array(chapterSchema),
		schemaVersion: z.number().optional(),
	})
	.passthrough();
export const identitiesSchema = z.record(
	z.string(),
	z
		.object({
			userId: z.number(),
			canonicalName: z.string(),
			aliases: strings,
			username: z.string().optional(),
			lastSeen: timestamp,
		})
		.passthrough(),
);
export const followUpsSchema = z.array(
	z
		.object({
			id: z.string(),
			chatId: z.number(),
			event: z.string(),
			followUpQuestion: z.string(),
			detectedAt: timestamp,
			scheduledFor: timestamp,
			sentAt: timestamp.optional(),
			status: z.enum(["pending", "sent", "cancelled", "expired"]),
			attempts: z.number().int().nonnegative(),
		})
		.passthrough(),
);
export const checkInsSchema = z.array(
	z
		.object({
			chatId: z.number(),
			weekStart: z.string(),
			slots: z.array(
				z
					.object({
						scheduledFor: timestamp,
						status: z.enum(["pending", "sent", "skipped"]),
					})
					.passthrough(),
			),
			lastSentTimestamp: timestamp,
			recentStrategies: strings,
			recentMessages: z
				.array(z.object({ text: z.string(), sentAt: timestamp }))
				.optional(),
			unansweredStreak: z.number().int().nonnegative().optional(),
		})
		.passthrough(),
);
