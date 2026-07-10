import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBotName } from "../src/config.ts";
import { isGroupChat } from "../src/conversation.ts";
import {
	buildPassiveVoiceContent,
	buildReplyAwareTextContent,
	buildUntranscribedVoiceContent,
	buildVoiceContent,
	detectMentionType,
	getLastBotMessageBeforeLatest,
	getTelegramReplyContext,
	isIgnorableGroupMessage,
	isUsableTranscription,
	shouldTranscribePassiveGroupVoice,
} from "../src/handlers.ts";
import type { ConversationMessage } from "../src/types.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

const BOT = { id: 42, username: "mgs_test_bot" };

describe("isGroupChat (DM vs group gating)", () => {
	test("private chats are not groups", () => {
		const { ctx } = makeMockContext({ chatType: "private" });
		expect(isGroupChat(ctx)).toBe(false);
	});

	test("group and supergroup chats are groups", () => {
		expect(isGroupChat(makeMockContext({ chatType: "group" }).ctx)).toBe(true);
		expect(isGroupChat(makeMockContext({ chatType: "supergroup" }).ctx)).toBe(
			true,
		);
	});
});

describe("detectMentionType", () => {
	test("reply to the bot is 'reply'", () => {
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			text: "sí claro",
			replyToMessage: { message_id: 5, from: { id: BOT.id, is_bot: true } },
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("reply");
	});

	test("reply to another user is not 'reply'", () => {
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			text: "sí claro",
			replyToMessage: { message_id: 5, from: { id: 999 } },
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("none");
	});

	test("@mention of the bot username is 'tag'", () => {
		const text = `hola @${BOT.username} dime algo`;
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			text,
			entities: [
				{
					type: "mention",
					offset: text.indexOf("@"),
					length: `@${BOT.username}`.length,
				},
			],
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("tag");
	});

	test("@mention of another bot is 'none'", () => {
		const text = "hola @other_bot dime algo";
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			text,
			entities: [
				{
					type: "mention",
					offset: text.indexOf("@"),
					length: "@other_bot".length,
				},
			],
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("none");
	});

	test("@mention in a photo caption is 'tag'", () => {
		const caption = `mira esto @${BOT.username}`;
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			photo: [{ file_id: "p1", width: 100, height: 100 }],
			caption,
			captionEntities: [
				{
					type: "mention",
					offset: caption.indexOf("@"),
					length: `@${BOT.username}`.length,
				},
			],
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("tag");
	});

	test("configured bot name in the text is 'name'", () => {
		const botName = getBotName();
		if (!botName.trim()) return;
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			text: `oye ${botName} ven`,
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("name");
	});

	test("plain text with no mention is 'none'", () => {
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			text: "hola a todos",
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("none");
	});

	test("context without a message is 'none'", () => {
		const { ctx } = makeMockContext({
			chatType: "group",
			me: BOT,
			noMessage: true,
		});
		expect(detectMentionType(ctx, BOT.id)).toBe("none");
	});
});

describe("getTelegramReplyContext", () => {
	test("undefined when the message is not a reply", () => {
		const { ctx } = makeMockContext({ text: "hola" });
		expect(getTelegramReplyContext(ctx, BOT.id)).toBeUndefined();
	});

	test("captures sender name, trimmed text, and non-bot flag", () => {
		const { ctx } = makeMockContext({
			text: "respuesta",
			replyToMessage: {
				from: { id: 9, first_name: "Juan", last_name: "Wispe" },
				text: "  hola mundo  ",
			},
		});
		expect(getTelegramReplyContext(ctx, BOT.id)).toEqual({
			senderName: "Juan Wispe",
			content: "hola mundo",
			isBot: false,
		});
	});

	test("marks replies to the bot", () => {
		const { ctx } = makeMockContext({
			text: "gracias",
			replyToMessage: {
				from: { id: BOT.id, is_bot: true, first_name: "Bot" },
				text: "de nada",
			},
		});
		expect(getTelegramReplyContext(ctx, BOT.id)?.isBot).toBe(true);
	});

	test("falls back to caption, then media placeholders", () => {
		const base = { from: { id: 9, first_name: "Ana" } };
		const cases: [Record<string, unknown>, string][] = [
			[{ ...base, caption: "una foto" }, "una foto"],
			[{ ...base, photo: [{ file_id: "p", width: 1, height: 1 }] }, "[photo]"],
			[{ ...base, voice: { file_id: "v" } }, "[voice message]"],
			[{ ...base, audio: { file_id: "a" } }, "[audio file]"],
			[{ ...base }, "[message]"],
		];
		for (const [replyToMessage, expected] of cases) {
			const { ctx } = makeMockContext({ text: "mira", replyToMessage });
			expect(getTelegramReplyContext(ctx, BOT.id)?.content).toBe(expected);
		}
	});
});

describe("buildReplyAwareTextContent truncation", () => {
	test("reply context longer than 500 chars is truncated", () => {
		const result = buildReplyAwareTextContent("ok", {
			senderName: "Ana",
			content: "a".repeat(600),
			isBot: false,
		});
		expect(result).toContain(" [truncated]");
		expect(result).toContain(`"${"a".repeat(488)} [truncated]"`);
	});

	test("reply context of exactly 500 chars is kept verbatim", () => {
		const content = "b".repeat(500);
		const result = buildReplyAwareTextContent("ok", {
			senderName: "Ana",
			content,
			isBot: false,
		});
		expect(result).toContain(`"${content}"`);
		expect(result).not.toContain("[truncated]");
	});
});

// Default env: ENABLE_GROUP_VOICE_CONTEXT unset (enabled),
// GROUP_PASSIVE_VOICE_MAX_SECONDS unset (120).
describe("passive group voice gating (defaults)", () => {
	test("unknown duration is transcribed", () => {
		expect(shouldTranscribePassiveGroupVoice(undefined)).toBe(true);
	});

	test("durations up to 120s are transcribed", () => {
		expect(shouldTranscribePassiveGroupVoice(1)).toBe(true);
		expect(shouldTranscribePassiveGroupVoice(120)).toBe(true);
	});

	test("durations over 120s are not transcribed", () => {
		expect(shouldTranscribePassiveGroupVoice(121)).toBe(false);
	});

	test("untranscribed content cites the 120s passive limit", () => {
		expect(buildUntranscribedVoiceContent("Juan", 200)).toBe(
			"[Voice message from Juan, 200s, not transcribed because it exceeds the passive group limit of 120s]",
		);
	});

	test("untranscribed content omits duration when unknown", () => {
		expect(buildUntranscribedVoiceContent("Juan")).toBe(
			"[Voice message from Juan, not transcribed because it exceeds the passive group limit of 120s]",
		);
	});
});

describe("voice content builders", () => {
	test("direct voice content format", () => {
		expect(buildVoiceContent("Juan", "hola")).toBe("[Audio from Juan]: hola");
	});

	test("passive voice content format", () => {
		expect(buildPassiveVoiceContent("Juan", "hola")).toBe(
			"[Voice message from Juan]: hola",
		);
	});

	test("passive transcript over 1200 chars is truncated", () => {
		const result = buildPassiveVoiceContent("Juan", "y".repeat(1300));
		expect(result.endsWith(" [truncated]")).toBe(true);
		expect(result).toContain("y".repeat(1200));
		expect(result).not.toContain("y".repeat(1201));
	});
});

describe("group message helpers", () => {
	test("isIgnorableGroupMessage", () => {
		expect(isIgnorableGroupMessage("")).toBe(true);
		expect(isIgnorableGroupMessage("   ")).toBe(true);
		expect(isIgnorableGroupMessage("😂👍")).toBe(true);
		expect(isIgnorableGroupMessage("hola")).toBe(false);
		expect(isIgnorableGroupMessage("jaja 😂")).toBe(false);
	});

	test("isUsableTranscription", () => {
		expect(isUsableTranscription("")).toBe(false);
		expect(isUsableTranscription("   ")).toBe(false);
		expect(isUsableTranscription("[transcription failed]")).toBe(false);
		expect(isUsableTranscription("hola")).toBe(true);
	});

	test("getLastBotMessageBeforeLatest skips the latest turn", () => {
		const msg = (role: "user" | "model", content: string) =>
			({ role, content, timestamp: 0 }) as ConversationMessage;
		expect(getLastBotMessageBeforeLatest([])).toBeUndefined();
		expect(
			getLastBotMessageBeforeLatest([msg("user", "a"), msg("user", "b")]),
		).toBeUndefined();
		expect(
			getLastBotMessageBeforeLatest([
				msg("model", "old"),
				msg("model", "recent"),
				msg("user", "latest"),
			]),
		).toBe("recent");
		// A bot message in the latest slot is ignored
		expect(
			getLastBotMessageBeforeLatest([msg("user", "a"), msg("model", "last")]),
		).toBeUndefined();
	});
});

// --- Env-dependent behavior (constants baked at module load) ---
// Runs tests/helpers/routing-probe.ts in a subprocess with a controlled env
// and a hermetic temp cwd (no .env, controlled bot_config.json).

interface ProbeResult {
	gating: {
		short: boolean;
		atLimit30: boolean;
		over30: boolean;
		unknownDuration: boolean;
		untranscribedMsg: string;
		passiveLong: string;
	};
	mention: {
		plainName: string;
		strippedDiacritics: string;
		noName: string;
		transcribedName: string;
		transcribedNone: string;
	};
	security: {
		allowedGroupNext: boolean;
		allowedGroupLeaveCalls: { method: string; args: unknown[] }[];
		otherGroupNext: boolean;
		otherGroupLeaveCalls: { method: string; args: unknown[] }[];
		ownerDmNext: boolean;
		ownerDmReplies: { text: string }[];
		strangerDmNextFirst: boolean;
		strangerDmNextSecond: boolean;
		strangerDmReplies: { text: string }[];
	};
}

function runProbe(env: Record<string, string>): ProbeResult {
	const cwd = mkdtempSync(join(tmpdir(), "mgsbot-routing-"));
	try {
		mkdirSync(join(cwd, "memory"), { recursive: true });
		writeFileSync(
			join(cwd, "memory", "bot_config.json"),
			JSON.stringify({ isConfigured: true, botName: "Niña" }),
		);
		const probe = join(import.meta.dir, "helpers", "routing-probe.ts");
		const proc = Bun.spawnSync([process.execPath, probe], {
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				...env,
			},
		});
		const stdout = proc.stdout.toString();
		if (proc.exitCode !== 0) {
			throw new Error(`probe failed: ${stdout}\n${proc.stderr.toString()}`);
		}
		// The middleware logs [guard] lines; the JSON payload is the last line.
		const lines = stdout.trim().split("\n");
		return JSON.parse(lines[lines.length - 1] ?? "");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("security middleware (subprocess, ALLOWED_GROUP_ID/OWNER_USER_ID set)", () => {
	const result = runProbe({
		ALLOWED_GROUP_ID: "-100500",
		OWNER_USER_ID: "777",
		GROUP_PASSIVE_VOICE_MAX_SECONDS: "0",
	});

	test("allowed group passes through to handlers", () => {
		expect(result.security.allowedGroupNext).toBe(true);
		expect(result.security.allowedGroupLeaveCalls).toHaveLength(0);
	});

	test("unauthorized group is left without calling handlers", () => {
		expect(result.security.otherGroupNext).toBe(false);
		expect(result.security.otherGroupLeaveCalls).toEqual([
			{ method: "leaveChat", args: [-100999] },
		]);
	});

	test("owner DM passes through without a warning reply", () => {
		expect(result.security.ownerDmNext).toBe(true);
		expect(result.security.ownerDmReplies).toHaveLength(0);
	});

	test("unauthorized DM gets the access warning once per user", () => {
		expect(result.security.strangerDmNextFirst).toBe(false);
		expect(result.security.strangerDmNextSecond).toBe(false);
		expect(result.security.strangerDmReplies).toHaveLength(1);
		expect(result.security.strangerDmReplies[0]?.text).toContain("888");
		expect(result.security.strangerDmReplies[0]?.text).toContain(
			"No tienes acceso a este bot",
		);
	});

	test("GROUP_PASSIVE_VOICE_MAX_SECONDS=0 disables passive transcription", () => {
		expect(result.gating.short).toBe(false);
		expect(result.gating.unknownDuration).toBe(false);
	});

	test("configured bot name matches loosely (diacritics/case)", () => {
		expect(result.mention.plainName).toBe("name");
		expect(result.mention.strippedDiacritics).toBe("name");
		expect(result.mention.noName).toBe("none");
		expect(result.mention.transcribedName).toBe("name");
		expect(result.mention.transcribedNone).toBe("none");
	});
});

describe("passive voice gating (subprocess, env overrides)", () => {
	test("ENABLE_GROUP_VOICE_CONTEXT=false disables passive transcription", () => {
		const result = runProbe({ ENABLE_GROUP_VOICE_CONTEXT: "false" });
		expect(result.gating.short).toBe(false);
		expect(result.gating.unknownDuration).toBe(false);
		expect(result.gating.untranscribedMsg).toBe(
			"[Voice message from Juan, 200s, not transcribed because group voice context is disabled]",
		);
	});

	test("GROUP_PASSIVE_VOICE_MAX_SECONDS / TRANSCRIPT_MAX_CHARS overrides", () => {
		const result = runProbe({
			GROUP_PASSIVE_VOICE_MAX_SECONDS: "30",
			GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS: "20",
		});
		expect(result.gating.atLimit30).toBe(true);
		expect(result.gating.over30).toBe(false);
		expect(result.gating.unknownDuration).toBe(true);
		expect(result.gating.untranscribedMsg).toContain(
			"exceeds the passive group limit of 30s",
		);
		expect(result.gating.passiveLong).toBe(
			`[Voice message from Juan]: ${"x".repeat(20)} [truncated]`,
		);
	});
});
