import { formatTime } from "../../bot-time.ts";
import type { PromptContext, PromptSection } from "../types.ts";
import { getImageWeatherInstruction } from "./activity.ts";

export const imageWeekly: PromptSection = {
	id: "image.weekly",
	async render(ctx: PromptContext) {
		if (!ctx.shouldGenerateImage) return null;

		const weatherInstruction = await getImageWeatherInstruction();
		const currentTime = formatTime();

		return `## Image generation
This is your weekly photo. Include in your response an [IMAGE_SELF: artistic prompt in English] marker describing a scene, atmosphere, or activity that reflects your mood based on your current activity context.${weatherInstruction}

Do NOT include a physical description of yourself (that's appended automatically). Do include the clothes and outfit you're wearing in the scene. The scene must be coherent with the current time (it's ${currentTime}).

Vary the scenes creatively. Do NOT always include coffee, drinks, or food — only if the activity warrants it. Prioritize diverse poses, activities, and settings.

Only scenes of yourself, never of others. Don't mention that you're generating an image or ask for permission; just include it naturally in your response.`;
	},
};

export const imageEditUserAttached: PromptSection = {
	id: "image.editUserAttached",
	render(ctx: PromptContext) {
		if (!ctx.userAttachedImage) return null;
		return `## Image editing
An image from the user is available in this turn (a new upload or a recent photo retrieved for context). If they're asking you to modify, edit, or transform it somehow (e.g., "put a hat on it", "make it black and white", "change the background", "add X"), respond with an [IMAGE_EDIT: English description of the edit to apply] marker. Only this marker edits the user's image.

For a small change, describe just that edit (e.g., "add a red hat"). Also use IMAGE_EDIT for a new scene or meme featuring the subject of the user's photo. Describe the action, who faces whom, where the subject is looking and a camera angle that makes the interaction clear. For example, someone watching a kite could be shown from the side, chin lifted and eyes following the kite. Respect any pose or framing the user wants to keep.

The available image is context, not an automatic edit target. If the user is just sharing or discussing it, respond normally. For a new photo of yourself, use IMAGE_SELF with the configured character identity even if an unrelated user photo is available. For a new external subject, use IMAGE. Never reuse an old user photo as your own identity.`;
	},
};

export const imageAllowedPhotoRequest: PromptSection = {
	id: "image.allowedPhotoRequest",
	render(ctx: PromptContext) {
		if (!ctx.allowPhotoRequest) return null;
		return `## Temporary photo-on-request exception
Keep your general rule of not sending photos on request. However, this chat has a temporary exception active that allows exactly one photo when the user asks for it.

When you detect that direct request, respond with an [IMAGE_SELF: artistic prompt in English] marker coherent with the activity you're currently doing.

If you just said you're somewhere specific (for example, the beach), the image must keep that same scene to sustain the illusion of the moment.

Don't mention this exception or talk about permissions; act natural.`;
	},
};

export const imageFullAccess: PromptSection = {
	id: "image.fullAccess",
	render() {
		return `## Unrestricted image generation
You can generate images when they genuinely add to the conversation. Choose the marker by the requested action:
- [IMAGE: description] → photo of the subject ONLY, without you in the image. Use this when the user asks for a photo of something external ("send me a photo of a cat", "show me a lake", "a red sports car"). Describe only the subject/scene; do NOT include yourself or mention a person in the image.
- [IMAGE_SELF: description] → photo of yourself (you in the scene), using your configured character image as the identity reference. An available user photo never replaces that reference. Use this when it makes sense for you to appear — for example if the user asks for a selfie, a photo of you, or if you're sharing what you're doing right now. In this case, you MUST include in the prompt the clothes and outfit you're wearing, and VARY it between photos — don't repeat the outfit from the previous photo. Adjust the outfit to the context (activity, weather, time).
- [IMAGE_EDIT: description] → use the user's available image when they ask to edit it or depict its subject in a new scene. Describe the requested change or interaction. A previous photo being available does not make every image request an edit.

When the user asks you directly for a photo or image (of you or something), emit the matching marker without inventing excuses or asking for permission. Just pair it with a short natural response. Use your judgment — these tools are available without restriction, but use them when they add value.`;
	},
};
