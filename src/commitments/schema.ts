import { z } from "zod";
import { scheduleSchema } from "./calendar.ts";

const text = z.string().trim().min(1).max(1200);
const id = z.string().min(1).max(100);
export const preferenceInputSchema = z.object({
	kind: z.enum(["sources", "style"]),
	instruction: text,
	topics: z.array(z.string().trim().min(2).max(60)).min(1).max(12),
	domains: z.array(z.string().trim().min(3).max(253)).max(3).default([]),
});
export const taskInputSchema = z.object({
	instruction: text,
	kind: z.enum(["reminder", "research"]),
	searchQuery: z.string().trim().min(2).max(300).optional(),
	schedule: scheduleSchema,
	domains: z.array(z.string().trim().min(3).max(253)).max(3).default([]),
});
export const actionSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("schedule"),
		task: taskInputSchema,
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
		ids: z.array(id).min(1).max(10),
		evidence: text,
	}),
]);
export const interpretationSchema = z.object({
	actions: z.array(actionSchema).max(8),
	clarification: z.string().max(400).optional(),
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
	status: z.enum(["preparing", "sending", "sent", "failed", "unknown"]),
});
export const taskSchema = taskInputSchema.extend({
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
	lastMessage: z.string().max(4000).optional(),
});
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
				/** Only text actually typed by this user, never speech transcription. */
				writtenText: z.string().max(5000).optional(),
				requireWritten: z.boolean().default(false),
				expiresAt: z.number(),
			}),
		)
		.max(100),
});
export type CommitmentState = z.infer<typeof stateSchema>;
