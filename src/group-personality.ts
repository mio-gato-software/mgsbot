import type { Context } from "grammy";

export function groupPersonalityEnabled(): boolean {
	return (
		process.env.ENABLE_GROUP_PERSONALITY === "true" &&
		process.env.SIMPLE_ASSISTANT_MODE !== "true"
	);
}

export function groupMemberTurn(ctx: Context) {
	const chat = ctx.chat;
	const message = ctx.message;
	const sender = ctx.from;
	if (
		!groupPersonalityEnabled() ||
		!chat ||
		(chat.type !== "group" && chat.type !== "supergroup") ||
		!message ||
		message.sender_chat ||
		message.forward_origin ||
		!sender ||
		sender.is_bot ||
		!Number.isSafeInteger(sender.id) ||
		sender.id <= 0 ||
		!Number.isSafeInteger(message.message_id) ||
		message.message_id <= 0
	)
		return undefined;
	return { chatId: chat.id, userId: sender.id, messageId: message.message_id };
}
