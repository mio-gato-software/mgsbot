export interface ImageGenerationOptions {
	/** Report illustrations may need labels and exact numeric tables. */
	allowText?: boolean;
	dimensions?: { width: number; height: number };
}

export interface ImageProvider {
	readonly name: string;
	isAvailable(): boolean;
	generateImage(
		prompt: string,
		referenceImagePath?: string,
		options?: ImageGenerationOptions,
	): Promise<Buffer>;
	/**
	 * Edit a user-provided image according to the prompt. Differs from
	 * generateImage(prompt, ref) in intent: edit applies the prompt as a
	 * modification to the image, while generateImage with a reference treats
	 * the reference as a character template.
	 */
	editImage(prompt: string, imagePath: string): Promise<Buffer>;
}
