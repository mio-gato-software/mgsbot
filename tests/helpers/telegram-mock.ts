// Minimal grammY Context mock for routing tests. No real Telegram
// connection — just enough shape for the pure/routing helpers plus
// spies for ctx.reply / ctx.react / ctx.replyWithChatAction / api calls.
import type { Context } from "grammy";

export interface MockUser {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
}

export interface MockMessageEntity {
	type: string;
	offset: number;
	length: number;
}

export interface MockReplyToMessage {
	message_id?: number;
	from?: MockUser;
	text?: string;
	caption?: string;
	photo?: { file_id: string; width: number; height: number }[];
	voice?: { file_id: string; duration?: number };
	audio?: { file_id: string; duration?: number; mime_type?: string };
	document?: { file_id: string; file_name?: string; mime_type?: string };
}

export interface MockContextOptions {
	chatType?: "private" | "group" | "supergroup";
	chatId?: number;
	from?: MockUser;
	me?: { id: number; username: string };
	messageId?: number;
	text?: string;
	caption?: string;
	entities?: MockMessageEntity[];
	captionEntities?: MockMessageEntity[];
	voice?: { file_id?: string; duration?: number };
	audio?: { file_id?: string; duration?: number; mime_type?: string };
	photo?: { file_id: string; width: number; height: number }[];
	document?: { file_id: string; file_name?: string; mime_type?: string };
	replyToMessage?: MockReplyToMessage;
	/** Build a ctx without ctx.message (e.g. non-message updates). */
	noMessage?: boolean;
}

export interface TelegramSpies {
	replies: { text: string; options?: Record<string, unknown> }[];
	reactions: unknown[][];
	chatActions: unknown[][];
	apiCalls: { method: string; args: unknown[] }[];
}

export interface MockContextResult {
	ctx: Context;
	spies: TelegramSpies;
}

export function makeMockContext(
	options: MockContextOptions = {},
): MockContextResult {
	const {
		chatType = "private",
		chatId = chatType === "private" ? 777 : -100500,
		from = { id: 777, first_name: "Test", username: "testuser" },
		me = { id: 42, username: "mgs_test_bot" },
		messageId = 1,
	} = options;

	const spies: TelegramSpies = {
		replies: [],
		reactions: [],
		chatActions: [],
		apiCalls: [],
	};

	const chat = { id: chatId, type: chatType };

	const message = options.noMessage
		? undefined
		: {
				message_id: messageId,
				chat,
				from,
				text: options.text,
				caption: options.caption,
				entities: options.entities,
				caption_entities: options.captionEntities,
				voice: options.voice,
				audio: options.audio,
				photo: options.photo,
				document: options.document,
				reply_to_message: options.replyToMessage,
			};

	// Records every raw api method call (leaveChat, getFile, ...) and
	// resolves with a permissive stub.
	const api = new Proxy(
		{},
		{
			get(_target, method: string) {
				return (...args: unknown[]) => {
					spies.apiCalls.push({ method, args });
					return Promise.resolve({ ok: true });
				};
			},
		},
	);

	const ctx = {
		chat,
		from,
		me,
		message,
		api,
		reply(text: string, opts?: Record<string, unknown>) {
			spies.replies.push({ text, options: opts });
			return Promise.resolve({ message_id: messageId + 1, chat });
		},
		react(...args: unknown[]) {
			spies.reactions.push(args);
			return Promise.resolve(true);
		},
		replyWithChatAction(...args: unknown[]) {
			spies.chatActions.push(args);
			return Promise.resolve(true);
		},
	} as unknown as Context;

	return { ctx, spies };
}
