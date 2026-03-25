export interface TtsProvider {
	readonly name: string;
	synthesize(text: string): Promise<string>;
}
