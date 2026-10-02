/**
 * Builds the per-run config overlay (bench/results/<runId>/runs/<cell>/overlay.yml).
 * Per the parent plan (2.3): advisor disabled, plan autosave pointed at the run
 * dir, and disabledExtensions restated verbatim (config arrays replace wholesale
 * on merge, so a partial list here would silently re-enable extensions).
 *
 * The overlay also pins the settings that would otherwise leak the invoking user's
 * global omp config into every cell, so cells are comparable and reproducible:
 * no persistent memory bank per cell (`memory.backend: off`), no model switch at
 * the first edit (`prewalk.enabled: false`), no extra user extensions (`extensions: []`;
 * `--no-extensions` stops discovery, this stops the config list), and no auto-plan on
 * startup in exec cells.
 */

/** A disabled-extension entry that targets the extension under test; the overlay must never disable it. */
function targetsBenchExtension(id: string): boolean {
	return /typesafe/i.test(id) && !/^skill:/i.test(id);
}

export function overlayConfig(disabledExtensions: string[], planAutosaveDir: string): Record<string, unknown> {
	return {
		advisor: { enabled: false },
		plan: { defaultOnStartup: false, autosave: true, autosaveDir: planAutosaveDir },
		memory: { backend: "off" },
		// Also passed as --no-prewalk; a global prewalk.enabled would otherwise change the model mid-run in every cell.
		prewalk: { enabled: false },
		extensions: [],
		disabledExtensions: disabledExtensions.filter((id) => !targetsBenchExtension(id)),
	};
}

function scalar(v: unknown): string {
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	throw new Error(`overlay: unsupported value ${JSON.stringify(v)}`);
}

/** Minimal block-style YAML emitter for nested maps, string/boolean/number scalars and scalar lists (empty list as `[]`). */
function emit(value: Record<string, unknown>, indent: string, lines: string[]): void {
	for (const [key, v] of Object.entries(value)) {
		if (Array.isArray(v)) {
			if (v.length === 0) {
				lines.push(`${indent}${key}: []`);
				continue;
			}
			lines.push(`${indent}${key}:`);
			for (const item of v) lines.push(`${indent}  - ${scalar(item)}`);
		} else if (typeof v === "object" && v !== null) {
			lines.push(`${indent}${key}:`);
			emit(v as Record<string, unknown>, `${indent}  `, lines);
		} else {
			lines.push(`${indent}${key}: ${scalar(v)}`);
		}
	}
}

export function overlayYaml(disabledExtensions: string[], planAutosaveDir: string): string {
	const lines: string[] = [];
	emit(overlayConfig(disabledExtensions, planAutosaveDir), "", lines);
	return `${lines.join("\n")}\n`;
}
