/**
 * Where the bench finds TYPESAFE_API_KEY. One parser serves the runner (which hands the key to every omp
 * subprocess) and the graders (which call the API themselves), so both read the same key from the same file.
 */

/**
 * The value of the last `[export ]TYPESAFE_API_KEY=...` assignment in a shell env file,
 * read the way a shell would: quotes are removed, and an unquoted value ends at the first
 * whitespace, so `abc # prod` is `abc`. Commented-out lines never match.
 */
export function parseApiKeyFromEnvFile(text: string): string | undefined {
	let key: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/);
		if (!m) continue;
		const raw = m[1].trimStart();
		const quote = raw[0];
		if (quote === '"' || quote === "'") {
			const end = raw.indexOf(quote, 1);
			key = (end === -1 ? raw.slice(1) : raw.slice(1, end)).trim() || undefined;
		} else {
			key = raw.split(/\s/)[0] || undefined;
		}
	}
	return key;
}

export interface ApiKeyResolution {
	key?: string;
	source: "env" | "file" | null;
}

/** An explicit TYPESAFE_API_KEY in the environment wins; the secrets file is the fallback. */
export function resolveTypesafeApiKey(env: Record<string, string | undefined>, fileText: string | undefined): ApiKeyResolution {
	const fromEnv = env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) return { key: fromEnv, source: "env" };
	const fromFile = fileText ? parseApiKeyFromEnvFile(fileText) : undefined;
	if (fromFile) return { key: fromFile, source: "file" };
	return { source: null };
}
