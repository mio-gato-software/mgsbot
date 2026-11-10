const sceneComposition =
	"Compose the shot around the action. Choose a camera viewpoint that shows the interaction clearly, and orient the subject's body, head and gaze toward what they are doing or looking at. Render their recognizable features from that angle. A frontal view is appropriate when it fits the scene. Honor any requested pose, gaze or framing.";

export function characterReferencePrompt(scene: string): string {
	return `Create a new image of the SAME subject in this scene: ${scene}. Use the reference for recognizable facial features, complexion, hair and body characteristics. Preserve its visual style and medium: a photographic reference should remain photographic, and an illustrated reference should retain its illustration style. Follow the scene's outfit, setting and lighting. ${sceneComposition}`;
}

export function userImageEditPrompt(instruction: string): string {
	return `Use the attached image for this request: ${instruction}. For a local edit, preserve the original pose, gaze, framing and other details outside the requested change. When the request places the subject in a new scene or action, use the photo to preserve their identity. ${sceneComposition}`;
}

export const noImageText =
	"Do NOT render any text, clocks, timestamps, or time indicators in the image.";
