import { CANONICAL_KEYS, LEGACY_CANONICAL_KEY_ALIASES } from '../types/keys';
import type { KeyMapping } from '../types/settings';
import { isRetiredKeyMapping } from '../types/settings';
import { buildReverseMapping, getVisiblePropertyName } from './yaml-fields';

export type FieldKeySyncDirection = 'to-visible' | 'to-canonical';

export interface FieldKeyMove {
	from: string;
	to: string;
}

export interface FrontmatterKeySyncPlan {
	moves: FieldKeyMove[];
	conflicts: string[];
}

export interface InlineLineSyncResult {
	line: string;
	changedTokens: number;
}

export interface FieldKeySyncSummary {
	direction: FieldKeySyncDirection;
	filesRewritten: number;
	fieldsMoved: number;
	conflicts: number;
	filesSkipped: number;
	failures: Array<{ path: string; message: string }>;
}

interface ManagedKeyTarget {
	canonicalKey: string;
	visibleName: string;
	sourcesToVisible: string[];
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function managedTargets(keyMappings: KeyMapping[]): ManagedKeyTarget[] {
	const targets: ManagedKeyTarget[] = [];
	for (const key of CANONICAL_KEYS) {
		if (isRetiredKeyMapping(key.name)) continue;
		const visibleName = getVisiblePropertyName(key.name, keyMappings);
		if (!visibleName) continue;
		const sourcesToVisible = [
			...new Set([key.name, ...(LEGACY_CANONICAL_KEY_ALIASES[key.name] ?? [])]),
		].filter(source => source !== visibleName);
		targets.push({ canonicalKey: key.name, visibleName, sourcesToVisible });
	}
	return targets;
}

/**
 * Plans frontmatter key moves for one file. Values are carried verbatim;
 * a source key whose target already exists with a differing value is a
 * conflict and both keys are left untouched.
 */
export function planFrontmatterKeySync(
	frontmatter: Record<string, unknown> | null | undefined,
	keyMappings: KeyMapping[],
	direction: FieldKeySyncDirection,
): FrontmatterKeySyncPlan {
	const moves: FieldKeyMove[] = [];
	const conflicts: string[] = [];
	if (!frontmatter) return { moves, conflicts };
	const keys = new Set(Object.keys(frontmatter));
	for (const target of managedTargets(keyMappings)) {
		if (direction === 'to-visible') {
			if (!target.sourcesToVisible.length) continue;
			const presentSources = target.sourcesToVisible.filter(source => keys.has(source));
			const targetPresent = keys.has(target.visibleName);
			if (targetPresent && presentSources.length) {
				if (presentSources.every(source => sameValue(frontmatter[source], frontmatter[target.visibleName]))) {
					for (const source of presentSources) moves.push({ from: source, to: '' });
				} else {
					conflicts.push(target.canonicalKey);
				}
				continue;
			}
			for (const source of presentSources) moves.push({ from: source, to: target.visibleName });
		} else {
			if (target.visibleName === target.canonicalKey) continue;
			const targetPresent = keys.has(target.canonicalKey);
			const sourcePresent = keys.has(target.visibleName);
			if (!sourcePresent) continue;
			if (targetPresent) {
				if (sameValue(frontmatter[target.visibleName], frontmatter[target.canonicalKey])) {
					moves.push({ from: target.visibleName, to: '' });
				} else {
					conflicts.push(target.canonicalKey);
				}
				continue;
			}
			moves.push({ from: target.visibleName, to: target.canonicalKey });
		}
	}
	return { moves, conflicts };
}

/**
 * Applies a frontmatter plan inside a processFrontMatter callback.
 * A move with an empty `to` deletes the source key (dedupe after value match).
 */
export function applyFrontmatterKeySyncPlan(
	frontmatter: Record<string, unknown>,
	plan: FrontmatterKeySyncPlan,
): void {
	for (const move of plan.moves) {
		if (!(move.from in frontmatter)) continue;
		if (move.to) {
			frontmatter[move.to] = frontmatter[move.from];
		}
		delete frontmatter[move.from];
	}
}

const INLINE_TOKEN_KEY_PATTERN = /\{\{\s*([^\s{:][^:{]*?)\s*::/g;

interface InlineToken {
	rawKey: string;
	canonicalKey: string;
	targetForm: string;
	span: [number, number];
}

function collectInlineTokens(line: string, keyMappings: KeyMapping[], direction: FieldKeySyncDirection): InlineToken[] {
	const reverseMap = buildReverseMapping(keyMappings);
	const tokens: InlineToken[] = [];
	INLINE_TOKEN_KEY_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INLINE_TOKEN_KEY_PATTERN.exec(line)) !== null) {
		const rawKey = match[1];
		const canonicalKey = reverseMap.get(rawKey) ?? null;
		if (!canonicalKey) continue;
		const targetForm = direction === 'to-visible'
			? getVisiblePropertyName(canonicalKey, keyMappings)
			: canonicalKey;
		if (!targetForm) continue;
		const rawStart = match.index + match[0].indexOf(rawKey);
		tokens.push({ rawKey, canonicalKey, targetForm, span: [rawStart, rawStart + rawKey.length] });
	}
	return tokens;
}

/**
 * Rewrites {{key:: value}} token keys on one line to the written form for the
 * requested direction. Values are never touched; unknown keys pass through.
 * If a line carries both the source and target form of one canonical key the
 * line is left untouched and the key is reported as a conflict.
 */
export function syncInlineTaskLine(
	line: string,
	keyMappings: KeyMapping[],
	direction: FieldKeySyncDirection,
): InlineLineSyncResult {
	const tokens = collectInlineTokens(line, keyMappings, direction);
	if (tokens.length === 0) return { line, changedTokens: 0 };

	const formsByCanonical = new Map<string, Set<string>>();
	for (const token of tokens) {
		const forms = formsByCanonical.get(token.canonicalKey) ?? new Set<string>();
		forms.add(token.rawKey);
		formsByCanonical.set(token.canonicalKey, forms);
	}
	const conflicted = new Set<string>();
	for (const [canonicalKey, forms] of formsByCanonical) {
		const targetForm = tokens.find(token => token.canonicalKey === canonicalKey)?.targetForm;
		if (targetForm && forms.has(targetForm) && forms.size > 1) conflicted.add(canonicalKey);
	}

	const edits = tokens
		.filter(token => !conflicted.has(token.canonicalKey) && token.rawKey !== token.targetForm)
		.sort((a, b) => b.span[0] - a.span[0]);
	let rewritten = line;
	for (const edit of edits) {
		rewritten = rewritten.slice(0, edit.span[0]) + edit.targetForm + rewritten.slice(edit.span[1]);
	}
	return { line: rewritten, changedTokens: edits.length };
}

export function isEmptySyncSummary(summary: FieldKeySyncSummary): boolean {
	return summary.filesRewritten === 0 && summary.fieldsMoved === 0 && summary.conflicts === 0;
}
