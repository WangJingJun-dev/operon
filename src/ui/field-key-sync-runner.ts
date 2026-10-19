import { App, parseYaml, TFile } from 'obsidian';
import { OperonSettings } from '../types/settings';
import { isOperonExcludedPath } from '../core/operon-path-exclusions';
import { getManagedYamlAliases } from '../core/yaml-fields';
import {
	applyFrontmatterKeySyncPlan,
	FieldKeySyncDirection,
	FieldKeySyncSummary,
	isEmptySyncSummary,
	planFrontmatterKeySync,
	syncInlineTaskLine,
} from '../core/field-key-sync';
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const INLINE_LINE_PRECHECK = /\{\{[^}]*::/;

export interface FieldKeySyncDryRunResult {
	summary: FieldKeySyncSummary;
	candidates: Array<{
		file: TFile;
		frontmatterMoves: number;
		inlineLineCount: number;
	}>;
}

export async function dryRunFieldKeySync(
	app: App,
	settings: OperonSettings,
	direction: FieldKeySyncDirection,
): Promise<FieldKeySyncDryRunResult> {
	const summary = createSummary(direction);
	const candidates: FieldKeySyncDryRunResult['candidates'] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (isOperonExcludedPath(file.path, settings)) continue;
		let content: string;
		try {
			content = await app.vault.read(file);
		} catch (error) {
			summary.failures.push({ path: file.path, message: String(error) });
			continue;
		}
		const plan = planFile(content, settings, direction);
		if (!plan.isManaged) {
			summary.filesSkipped += 1;
			continue;
		}
		summary.conflicts += plan.conflicts;
		const frontmatterMoves = plan.frontmatterMoves;
		const inlineLineCount = plan.inlineLines.length;
		if (frontmatterMoves > 0 || inlineLineCount > 0) {
			candidates.push({ file, frontmatterMoves, inlineLineCount });
			summary.fieldsMoved += frontmatterMoves + plan.inlineTokens;
		}
	}
	summary.filesRewritten = candidates.length;
	return { summary, candidates };
}

export async function applyFieldKeySync(
	app: App,
	settings: OperonSettings,
	direction: FieldKeySyncDirection,
): Promise<FieldKeySyncSummary> {
	const summary = createSummary(direction);
	for (const file of app.vault.getMarkdownFiles()) {
		if (isOperonExcludedPath(file.path, settings)) continue;
		let content: string;
		try {
			content = await app.vault.read(file);
		} catch (error) {
			summary.failures.push({ path: file.path, message: String(error) });
			continue;
		}
		const plan = planFile(content, settings, direction);
		if (!plan.isManaged) {
			summary.filesSkipped += 1;
			continue;
		}
		summary.conflicts += plan.conflicts;
		try {
			let rewritten = false;
			if (plan.frontmatterMoves > 0) {
				let appliedMoves = 0;
				await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
					const freshPlan = planFrontmatterKeySync(frontmatter, settings.keyMappings, direction);
					applyFrontmatterKeySyncPlan(frontmatter, freshPlan);
					appliedMoves = freshPlan.moves.length;
				});
				summary.fieldsMoved += appliedMoves;
				rewritten = appliedMoves > 0;
			}
			if (plan.inlineLines.length > 0) {
				const freshContent = await app.vault.read(file);
				const lines = freshContent.split('\n');
				let inlineTokens = 0;
				for (const lineIndex of plan.inlineLines) {
					const result = syncInlineTaskLine(lines[lineIndex], settings.keyMappings, direction);
					if (result.changedTokens > 0) {
						lines[lineIndex] = result.line;
						inlineTokens += result.changedTokens;
					}
				}
				if (inlineTokens > 0) {
					await app.vault.modify(file, lines.join('\n'));
					summary.fieldsMoved += inlineTokens;
					rewritten = true;
				}
			}
			if (rewritten) summary.filesRewritten += 1;
		} catch (error) {
			summary.failures.push({ path: file.path, message: String(error) });
		}
	}
	return summary;
}

interface FilePlanResult {
	isManaged: boolean;
	frontmatterMoves: number;
	inlineTokens: number;
	inlineLines: number[];
	conflicts: number;
}

function planFile(content: string, settings: OperonSettings, direction: FieldKeySyncDirection): FilePlanResult {
	const empty: FilePlanResult = { isManaged: false, frontmatterMoves: 0, inlineTokens: 0, inlineLines: [], conflicts: 0 };
	const frontmatterBlock = FRONTMATTER_BLOCK_PATTERN.exec(content);
	const frontmatter = frontmatterBlock ? (parseYaml(frontmatterBlock[1]) as Record<string, unknown> | null) : null;
	const identityAliases = getManagedYamlAliases('operonId', settings.keyMappings);
	const isFileTask = !!frontmatter && identityAliases.some(alias => alias in frontmatter);

	let frontmatterMoves = 0;
	let conflicts = 0;
	if (isFileTask) {
		const fmPlan = planFrontmatterKeySync(frontmatter, settings.keyMappings, direction);
		frontmatterMoves = fmPlan.moves.length;
		conflicts = fmPlan.conflicts.length;
	}

	const bodyStart = frontmatterBlock ? content.indexOf('\n', frontmatterBlock[0].length - 1) + 1 : 0;
	const body = content.slice(Math.max(0, bodyStart));
	const inlineLines: number[] = [];
	let inlineTokens = 0;
	let lineIndex = bodyStart === 0 ? 0 : content.slice(0, bodyStart).split('\n').length - 1;
	for (const line of body.split('\n')) {
		if (INLINE_LINE_PRECHECK.test(line)) {
			const result = syncInlineTaskLine(line, settings.keyMappings, direction);
			if (result.changedTokens > 0) {
				inlineLines.push(lineIndex);
				inlineTokens += result.changedTokens;
			}
		}
		lineIndex += 1;
	}

	const isManaged = isFileTask || inlineLines.length > 0;
	if (!isManaged) return empty;
	return { isManaged, frontmatterMoves, inlineTokens, inlineLines, conflicts };
}

function createSummary(direction: FieldKeySyncDirection): FieldKeySyncSummary {
	return { direction, filesRewritten: 0, fieldsMoved: 0, conflicts: 0, filesSkipped: 0, failures: [] };
}

export { isEmptySyncSummary };
export type { FieldKeySyncSummary };
