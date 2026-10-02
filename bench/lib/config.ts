import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for ~/.omp/agent/config.yml. It parses the file with Bun's YAML parser (so
 * block lists at any indentation, flow lists/maps, comments and quoting all behave
 * as YAML says) and extracts the two fields the bench harness needs:
 * `disabledExtensions` and `modelRoles.default`.
 */
export interface GlobalConfig {
	disabledExtensions: string[];
	defaultModel: string;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pure counterpart of readGlobalConfig. A malformed shape throws rather than
 * falling back: a silently dropped `disabledExtensions` would make the overlay
 * re-enable extensions the user disabled, in every cell.
 */
export function parseGlobalConfig(text: string, source: string = GLOBAL_CONFIG_PATH): GlobalConfig {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(text);
	} catch (err) {
		throw new Error(`readGlobalConfig: ${source} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
	}
	const root = isRecord(doc) ? doc : {};

	const rawDisabled = root.disabledExtensions;
	let disabledExtensions: string[] = [];
	if (rawDisabled !== undefined && rawDisabled !== null) {
		if (!Array.isArray(rawDisabled)) {
			throw new Error(`readGlobalConfig: disabledExtensions in ${source} must be a list, got ${typeof rawDisabled}`);
		}
		disabledExtensions = rawDisabled.map((entry, i) => {
			if (typeof entry !== "string") {
				throw new Error(`readGlobalConfig: disabledExtensions[${i}] in ${source} must be a string, got ${JSON.stringify(entry)}`);
			}
			return entry;
		});
	}

	const defaultModel = isRecord(root.modelRoles) ? root.modelRoles.default : undefined;
	if (typeof defaultModel !== "string" || !defaultModel.trim()) {
		throw new Error(`readGlobalConfig: could not find modelRoles.default in ${source}`);
	}

	return { disabledExtensions, defaultModel: defaultModel.trim() };
}

export async function readGlobalConfig(path: string = GLOBAL_CONFIG_PATH): Promise<GlobalConfig> {
	return parseGlobalConfig(await Bun.file(path).text(), path);
}
