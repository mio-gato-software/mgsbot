import type { Context } from "grammy";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { loadConfig } from "../config.ts";
import { isGroupChat } from "../conversation.ts";
import {
	type GroupRequestDecision,
	preflightGroupRequest,
} from "../group-autonomy.ts";
import type { MentionType } from "../types.ts";
import { processConversationAndTrackGroupContinuation } from "./routing.ts";

export async function preflightGroupWork(
	ctx: Context,
	input: {
		requestKind: "link" | "media";
		text?: string;
		content: string;
		userName: string;
		options: { mentionType?: MentionType; groupContinuation?: boolean };
	},
): Promise<
	| { handled: true }
	| { handled: false; groupRequestDecision?: GroupRequestDecision }
> {
	if (!isGroupChat(ctx) || isBotOff() || isSleepingHour())
		return { handled: false };

	const decision = await preflightGroupRequest(
		ctx,
		input.text,
		input.requestKind,
		loadConfig().personality ?? "",
	);
	if (decision?.kind === "handled") return { handled: true };
	if (
		decision?.kind !== "decline" &&
		!(decision?.kind === "resume" && decision.previous.evidence)
	)
		return { handled: false, groupRequestDecision: decision };

	await processConversationAndTrackGroupContinuation(
		ctx,
		input.content,
		input.userName,
		{
			...input.options,
			botOff: isBotOff(),
			isSleepingHour: isSleepingHour(),
			groupRequestDecision: decision,
		},
	);
	return { handled: true };
}
