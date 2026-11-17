function containsPrivateData(text: string): boolean {
	if (
		/[^\s@]+@[^\s@]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\/(?:Users|home)\/|\b(?:sk-[a-z0-9_-]{16,}|\d{6,}:[a-z0-9_-]{20,})/i.test(
			text,
		)
	)
		return true;
	return Object.entries(process.env).some(
		([key, value]) =>
			/(?:_KEY|_TOKEN|_SECRET|PASSWORD|OWNER_USER_ID|ALLOWED_GROUP_ID)$/.test(
				key,
			) &&
			!!value &&
			value.length >= 8 &&
			text.includes(value),
	);
}

export function hasPrivateQueryData(query: string): boolean {
	return /\b\d{9,}\b/.test(query) || containsPrivateData(query);
}

export function isPublicLookupUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			["https:", "http:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!containsPrivateData(
				decodeURIComponent(url.pathname + url.search + url.hash),
			) &&
			![...url.searchParams.keys()].some((key) =>
				/^(?:token|api[_-]?key|secret|password|auth|access_token|credential|sig|signature|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature))$/i.test(
					key,
				),
			)
		);
	} catch {
		return false;
	}
}
