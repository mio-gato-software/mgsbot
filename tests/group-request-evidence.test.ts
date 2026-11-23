import { expect, spyOn, test } from "bun:test";
import type { Context } from "grammy";
import {
	groupFavorEvidence,
	restoreGroupFavorEvidence,
} from "../src/group-request-evidence.ts";

function groupTurn(message: Record<string, unknown>): Context {
	return { message: { message_id: 2, ...message } } as unknown as Context;
}

test("a reconsidered media favor preserves the original Telegram reference", async () => {
	const image = {
		fileId: "group-photo",
		messageId: 2,
		dimensions: { width: 720, height: 480 },
	};
	expect(
		groupFavorEvidence(
			groupTurn({
				photo: [{ file_id: "group-photo", width: 720, height: 480 }],
			}),
			"media",
		),
	).toEqual({ kind: "image", image });
	expect(
		await restoreGroupFavorEvidence(
			groupTurn({}),
			{ kind: "image", image },
			"",
		),
	).toEqual({ image });
	expect(
		groupFavorEvidence(
			groupTurn({
				text: "¿Me resumes ese informe?",
				reply_to_message: {
					message_id: 1,
					document: { file_id: "group-report", file_name: "report.pdf" },
				},
			}),
			"media",
		),
	).toEqual({ kind: "pdf", fileId: "group-report", messageId: 1 });
});

test("media replay distinguishes quoted audio from the author's own voice note", () => {
	const voice = { file_id: "group-voice" };
	expect(groupFavorEvidence(groupTurn({ voice }), "media")).toBeUndefined();
	expect(
		groupFavorEvidence(
			groupTurn({
				text: "¿Qué dice el audio?",
				reply_to_message: { message_id: 1, voice },
			}),
			"media",
		),
	).toEqual({
		kind: "audio",
		fileId: "group-voice",
		messageId: 1,
		mimeType: "audio/ogg",
	});
});

test("replay references come from the original turn without forwarding or private links", () => {
	const origin = { type: "hidden_user" };
	expect(
		groupFavorEvidence(
			groupTurn({
				reply_to_message: {
					message_id: 1,
					voice: { file_id: "forwarded-voice" },
					forward_origin: origin,
				},
			}),
			"media",
		),
	).toBeUndefined();
	expect(
		groupFavorEvidence(
			groupTurn({
				text: "https://example.com/article?token=mock-confidential",
			}),
			"link",
		),
	).toBeUndefined();
	const publicPage = groupTurn({
		text: "¿Puedes leer https://example.com/story?",
	});
	expect(groupFavorEvidence(publicPage, "link")).toEqual({
		kind: "web",
		url: "https://example.com/story",
	});
	expect(groupFavorEvidence(publicPage, "media")).toBeUndefined();
	expect(
		groupFavorEvidence(
			groupTurn({
				text: "Mira https://youtu.be/abcdefghijk",
				forward_origin: origin,
			}),
			"link",
		),
	).toBeUndefined();
	expect(
		groupFavorEvidence(
			groupTurn({ text: "Mira https://youtu.be/abcdefghijk" }),
			"link",
		),
	).toEqual({ kind: "youtube", videoId: "abcdefghijk" });
});

test("an accepted text attachment is reacquired with its original file ID", async () => {
	const getFile = spyOn(
		{ getFile: async () => ({ file_path: "documents/sample.txt" }) },
		"getFile",
	);
	const api = { getFile, token: "mock-bot-token" };
	const ctx = { api } as unknown as Context;
	const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("This is the original attachment."),
	);
	try {
		const result = await restoreGroupFavorEvidence(
			ctx,
			{ kind: "text", fileId: "original-attachment", fileSize: 34 },
			"Resúmeme el archivo.",
		);
		expect(getFile).toHaveBeenCalledWith("original-attachment", undefined);
		expect(result.content).toContain("This is the original attachment.");
		expect(result.content).toContain("untrusted");
	} finally {
		getFile.mockRestore();
		fetch.mockRestore();
	}
});
