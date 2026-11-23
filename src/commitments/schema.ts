import { z } from "zod";
import {
	dateSchema,
	interpretedScheduleSchema,
	MAX_WATCH_CHECKS,
	scheduleSchema,
} from "./calendar.ts";

// Report content is also the image renderer's input, not a single Telegram message.
export const MAX_SCHEDULED_REPORT_CHARS = 32_000;
export const COMMITMENTS_VERSION = 4;
export const MAX_REPORT_PHOTO_IDS = 32;

const text = z.string().trim().min(1).max(1200);
const id = z.string().min(1).max(100);
const domainsSchema = z.array(z.string().trim().min(3).max(253)).max(3);
const canvasSchema = z.union([
	z.enum(["auto", "mobile"]),
	z.strictObject({
		width: z.number().int().positive().max(4096),
		height: z.number().int().positive().max(4096),
	}),
]);
export const reportImageSchema = z.strictObject({
	delivery: z.enum(["image_only", "image_and_text"]),
	description: text,
	canvas: canvasSchema.optional(),
});
export type ReportImage = z.infer<typeof reportImageSchema>;
const formatChangeSchema = z
	.strictObject({
		delivery: z.enum(["text", "image_only", "image_and_text"]).optional(),
		description: text.optional(),
		canvas: canvasSchema.optional(),
	})
	.refine(
		(f) => f.delivery !== "text" || (!f.description && !f.canvas),
		"Text delivery cannot include image settings",
	);
export type FormatChange = z.infer<typeof formatChangeSchema>;
export const behaviorInputSchema = z.object({
	id: id.optional(),
	condition: text,
	instruction: text,
	output: z.enum(["text", "image"]),
	maxPerDay: z.number().int().min(1).max(3).default(1),
	maxEventAgeDays: z.number().int().min(1).max(7).default(2),
});
export const behaviorSchema = behaviorInputSchema.extend({
	id,
	createdAt: z.number().finite(),
});
export type ConditionalBehavior = z.infer<typeof behaviorSchema>;
export const behaviorEventSchema = z.object({
	behaviorId: id,
	eventKey: z.string().min(1).max(200),
	summary: text,
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	status: z.enum(["preparing", "sending", "sent", "failed", "unknown"]),
	attempts: z.array(z.number().finite()).min(1).max(3),
	updatedAt: z.number().finite(),
	lastCaption: z.string().max(1000).optional(),
	creativeConcept: z.string().max(600).optional(),
	creativeScene: z.string().max(300).optional(),
	imageDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
export type BehaviorEvent = z.infer<typeof behaviorEventSchema>;
export const preferenceInputSchema = z.object({
	kind: z.enum(["sources", "style"]),
	instruction: text,
	topics: z.array(z.string().trim().min(2).max(60)).min(1).max(12),
	domains: domainsSchema.default([]),
});
export const taskInputSchema = z.object({
	behaviors: z.array(behaviorInputSchema).max(3).optional(),
	renewalReminderDays: z.number().int().min(1).max(2).optional(),
	instruction: text,
	kind: z.enum(["reminder", "research"]),
	searchQuery: z.string().trim().min(2).max(300).optional(),
	schedule: scheduleSchema,
	domains: domainsSchema.optional(),
});
export const actionSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("watch_event"),
		eventDate: dateSchema,
		anchorTime: scheduleSchema.shape.time,
		waitMinutes: z
			.number()
			.int()
			.min(0)
			.max(7 * 24 * 60),
		searchQuery: taskInputSchema.shape.searchQuery.unwrap(),
		behavior: behaviorInputSchema.omit({ id: true }),
		domains: domainsSchema.optional(),
		evidence: text,
	}),
	z.object({
		type: z.literal("set_behaviors"),
		id,
		behaviors: z.array(behaviorInputSchema).max(3),
		evidence: text,
	}),
	z.object({
		type: z.literal("extend"),
		ids: z.array(id).min(1).max(10),
		days: z.number().int().min(1).max(31),
		evidence: text,
	}),
	z.object({
		type: z.literal("renewal_reminder"),
		id,
		days: z.number().int().min(1).max(2).nullable(),
		evidence: text,
	}),
	z
		.object({
			type: z.literal("update"),
			id,
			instruction: text.optional(),
			time: scheduleSchema.shape.time.optional(),
			domains: domainsSchema.optional(),
			searchQuery: taskInputSchema.shape.searchQuery,
			format: formatChangeSchema.optional(),
			evidence: text,
		})
		.refine(
			(a) =>
				a.instruction ||
				a.time ||
				a.domains ||
				a.searchQuery ||
				Object.keys(a.format ?? {}).length,
			"Provide the requested change",
		),
	z.object({
		type: z.literal("schedule"),
		task: taskInputSchema.extend({ schedule: interpretedScheduleSchema }),
		format: formatChangeSchema.optional(),
		replaceId: id.optional(),
		evidence: text,
	}),
	z.object({
		type: z.literal("prefer"),
		preference: preferenceInputSchema,
		replaceId: id.optional(),
		evidence: text,
	}),
	z.object({
		type: z.literal("cancel"),
		ids: z.array(id).min(1).max(10),
		evidence: text,
	}),
	z.object({
		type: z.literal("renew"),
		days: z.number().int().min(1).max(31).optional(),
		ids: z.array(id).min(1).max(10),
		evidence: text,
	}),
]);
export const interpretationSchema = z.object({
	actions: z.array(actionSchema).max(8),
	needsVisualDescription: z.boolean().optional(),
	run: z.object({ taskId: id, evidence: text }).optional(),
	clarification: z.string().max(400).optional(),
	discardPending: z.boolean().default(false),
	needsWrittenConfirmation: z.boolean().default(false),
	list: z.boolean().default(false),
});
export type Interpretation = z.infer<typeof interpretationSchema>;

const provenance = {
	id,
	chatId: z.number().int(),
	creatorId: z.number().int().positive(),
	creatorName: z.string().max(200),
	createdAt: z.number().finite(),
	updatedAt: z.number().finite(),
	sourceMessageId: z.number().int(),
	evidence: text,
};
export const preferenceSchema = preferenceInputSchema.extend({
	...provenance,
	status: z.enum(["active", "cancelled"]),
});
const occurrenceSchema = z.object({
	dueAt: z.number().finite(),
	claimedAt: z.number().finite(),
	status: z.enum([
		"preparing",
		"sending",
		"sent",
		"failed",
		"unknown",
		"checked",
	]),
});
export const taskSchema = taskInputSchema
	.extend({
		kind: z.enum(["research", "reminder", "event_watch"]),
		checksMade: z.number().int().min(0).max(MAX_WATCH_CHECKS).optional(),
		domains: domainsSchema.default([]),
		// Missing on legacy tasks. Null is a persisted decision to deliver text.
		reportImage: reportImageSchema.nullable().optional(),
		reportPhotoIds: z
			.array(z.number().int().positive())
			.max(MAX_REPORT_PHOTO_IDS)
			.optional(),
		behaviors: z.array(behaviorSchema).max(3).optional(),
		behaviorEvents: z.array(behaviorEventSchema).max(500).optional(),
		...provenance,
		timezone: z
			.string()
			.min(1)
			.max(100)
			.refine((zone) => {
				try {
					new Intl.DateTimeFormat("en", { timeZone: zone });
					return true;
				} catch {
					return false;
				}
			}),
		expiresAt: z.number().finite(),
		nextRunAt: z.number().finite().optional(),
		status: z.enum(["active", "cancelled", "expired", "completed"]),
		lastOccurrence: occurrenceSchema.optional(),
		lastMessage: z.string().max(MAX_SCHEDULED_REPORT_CHARS).optional(),
		renewalTermStartedAt: z.number().finite().optional(),
		renewalNotice: z
			.object({
				forExpiresAt: z.number().finite(),
				at: z.number().finite(),
				status: z.enum(["sending", "sent", "unknown", "declined"]),
			})
			.optional(),
	})
	.refine(
		(task) =>
			task.kind !== "event_watch" ||
			(task.schedule.frequency === "once" &&
				!!task.searchQuery &&
				task.behaviors?.length === 1 &&
				task.reportImage === null &&
				task.checksMade !== undefined),
		"An event watch needs a single condition, public query and finite check state",
	);
export type ScheduledTask = z.infer<typeof taskSchema>;
export type StandingPreference = z.infer<typeof preferenceSchema>;
export const stateSchema = z.object({
	tasks: z.array(taskSchema).max(2000),
	preferences: z.array(preferenceSchema).max(2000),
	receipts: z
		.array(z.object({ key: id, result: z.string().max(60000), at: z.number() }))
		.max(500),
	pending: z
		.array(
			z.object({
				chatId: z.number().int(),
				userId: z.number().int(),
				text: z.string().max(5000),
				requestDate: dateSchema.optional(),
				/** Only text actually typed by this user, never speech transcription. */
				question: z.string().max(400).optional(),
				writtenText: z.string().max(5000).optional(),
				requireWritten: z.boolean().default(false),
				expiresAt: z.number(),
			}),
		)
		.max(100),
});
export type CommitmentState = z.infer<typeof stateSchema>;
