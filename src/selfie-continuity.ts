import type { DeliveredSelfie } from "./types.ts";

/** Updates from this chat are serialized, so a queued request can predate the
 * photo even when its handler starts after Telegram confirmed delivery. */
export function crossedSelfieDelivery(
	selfie: DeliveredSelfie,
	messageId: number,
) {
	return messageId > selfie.requestMessageId && messageId < selfie.messageId;
}

export function selfieContext(
	selfie: DeliveredSelfie,
	messageId: number,
	canTakePhoto: boolean,
	replyToSelfie: boolean,
) {
	const crossed = crossedSelfieDelivery(selfie, messageId);
	return `\n## Last delivered selfie in this chat
Telegram confirmed your last selfie at ${new Date(selfie.sentAt).toISOString()}. ${crossed ? "The current message was posted BEFORE that photo appeared. If it simply asks again for the photo already delivered, the request is fulfilled. Use [SILENCE], or answer only any separate question." : "The current message was posted after that selfie appeared."}
${replyToSelfie ? "The Telegram reply points to this selfie. It is your photo." : ""}
If the speaker wants that exact photo again, emit [SELFIE_RESEND]. This redelivers the original and needs no new photo permission.
${canTakePhoto ? "For another take of that moment, including a different angle, pose or framing, emit [SELFIE_RETAKE: requested visual change in English]. Use this even when replying to your own selfie as an attachment. Keep the outfit, setting and lighting. Reserve IMAGE_SELF for an independent new scene." : "A new take requires new photo permission. If asked for one, decline naturally."}
Only use these follow-up actions for your own last delivered selfie. A reference to another image or a discussion of the selfie does not request redelivery.`;
}
