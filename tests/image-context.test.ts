import { expect, test } from "bun:test";
import { describeImagePrompt } from "../src/ai/vision.ts";
import {
	getMessageImage,
	imageDocumentMimeType,
	RECENT_IMAGE_MAX_AGE_MS,
	selectRecentImage,
} from "../src/image-context.ts";
import { messageSchema } from "../src/memory/schemas.ts";
import type { ConversationMessage } from "../src/types.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

test("photo, follow-up, reply and uncompressed-file handlers deliver images and clean up unique files", async () => {
	const proc = Bun.spawn([process.execPath, "tests/helpers/image-probe.ts"], {
		cwd: `${import.meta.dir}/..`,
		env: {
			...process.env,
			CHAT_PROVIDER: "openai",
			OPENAI_API_KEY: "test-no-network",
			NODE_ENV: "production",
			ENABLE_SLEEP_SCHEDULE: "false",
			ENABLE_CHAT_LOG: "false",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	expect(stdout).toContain("IMAGE_PROBE_OK");
});

test("keeps the largest photo reference; a new upload wins over a replied photo", () => {
	const { ctx } = makeMockContext({
		messageId: 12,
		photo: [
			{ file_id: "small", width: 100, height: 100 },
			{ file_id: "large", width: 1000, height: 1000 },
		],
		replyToMessage: {
			message_id: 3,
			photo: [{ file_id: "old", width: 10, height: 10 }],
		},
	});
	expect(getMessageImage(ctx)).toEqual({ fileId: "large", messageId: 12 });
	const reply = makeMockContext({
		replyToMessage: {
			message_id: 3,
			photo: [{ file_id: "old", width: 10, height: 10 }],
		},
	});
	expect(getMessageImage(reply.ctx)).toEqual({ fileId: "old", messageId: 3 });
});

test("uncompressed image files and replies preserve MIME type", () => {
	const document = { file_id: "file-photo", file_name: "PHOTO.PNG" };
	expect(
		getMessageImage(makeMockContext({ messageId: 4, document }).ctx),
	).toEqual({ fileId: "file-photo", messageId: 4, mimeType: "image/png" });
	expect(
		getMessageImage(
			makeMockContext({ replyToMessage: { message_id: 4, document } }).ctx,
		)?.mimeType,
	).toBe("image/png");
	expect(imageDocumentMimeType({ mime_type: "image/webp" })).toBe("image/webp");
	expect(imageDocumentMimeType({ file_name: "notes.pdf" })).toBeUndefined();
});

test("selects at most one recent image from the same speaker, with a fixed lifetime", () => {
	const now = Date.now();
	const photo: ConversationMessage = {
		role: "user",
		userId: 7,
		content: "photo",
		timestamp: now,
		image: { fileId: "first", messageId: 1 },
	};
	const newest = { ...photo, image: { fileId: "second", messageId: 2 } };
	const someoneElse = {
		...photo,
		userId: 9,
		image: { fileId: "other", messageId: 3 },
	};
	expect(selectRecentImage([photo, newest, someoneElse], 7, now)).toBe(newest);
	expect(selectRecentImage([photo], 9, now)).toBeUndefined();
	expect(selectRecentImage([photo], undefined, now)).toBeUndefined();
	expect(
		selectRecentImage(
			[
				photo,
				{
					role: "user",
					userId: 7,
					content: "follow-up",
					timestamp: now + RECENT_IMAGE_MAX_AGE_MS,
				},
			],
			7,
			now + RECENT_IMAGE_MAX_AGE_MS + 1,
		),
	).toBeUndefined();
	expect(selectRecentImage([], 7, now)).toBeUndefined();
});

test("image references validate without invalidating legacy messages", () => {
	const legacy = { role: "user", content: "hi", timestamp: 1 };
	expect(messageSchema.safeParse(legacy).success).toBe(true);
	expect(
		messageSchema.safeParse({ ...legacy, image: { fileId: "", messageId: 1 } })
			.success,
	).toBe(false);
	expect(
		messageSchema.parse({ ...legacy, image: { fileId: "photo", messageId: 1 } })
			.image?.fileId,
	).toBe("photo");
});

test("fallback vision prioritizes the current question and does not invent illegible details", () => {
	const prompt = describeImagePrompt("¿Qué dice el letrero pequeño?");
	expect(prompt).toContain("¿Qué dice el letrero pequeño?");
	expect(prompt).toContain("Prioritize visual evidence");
	expect(prompt).toContain("never invent");
});
