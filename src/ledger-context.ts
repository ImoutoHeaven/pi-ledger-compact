import { randomUUID } from "node:crypto";
import { Type, type Static } from "@earendil-works/pi-ai";
import { SessionManager, convertToLlm, estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_ENTRY_TYPE = "ledger-context/checkpoint";
export const RAW_TAIL_MARKER_ENTRY_TYPE = "ledger-context/tail-marker";
export const COMPACTION_DETAILS_KIND = "ledger-context";
export const LEDGER_SCHEMA_VERSION = 1 as const;
export const MAX_ACTIVE_REQUEST_IDS = 8;
export const LEDGER_BYTE_LIMIT = 65_536;
export const DEFAULT_LEDGER_TOKEN_LIMIT = 4_096;
export const DEFAULT_TASK_TOKEN_LIMIT = 4_096;
export const DEFAULT_TAIL_TOKEN_LIMIT = 4_096;
export const DEFAULT_HISTORY_READ_TOKEN_LIMIT = 2_048;
export const DEFAULT_OUTPUT_RESERVE_TOKEN_LIMIT = 16_384;
export const REMINDER_MESSAGE_TYPE = "ledger-context/reminder";
export const DEFAULT_SOFT_REMINDER_TOKEN_LIMIT = 32_768;
export const DEFAULT_URGENT_REMINDER_TOKEN_LIMIT = 16_384;
export const MAX_HISTORY_SEARCH_QUERY_LENGTH = 8_192;
export const MAX_HISTORY_IDENTIFIER_LENGTH = 1_024;
export const MAX_HISTORY_PAGE_SIZE = 100;
export const MAX_HISTORY_READ_LENGTH = 65_536;

const checkpointParameters = Type.Object({
	ledger: Type.String({ minLength: 1, description: "The complete active working ledger." }),
	activeRequestEntryIds: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			maxItems: MAX_ACTIVE_REQUEST_IDS,
			description: "Current-branch user request entry IDs that define the active task.",
		}),
	),
});

const historyReadParameters = Type.Object({
	entryId: Type.String({ minLength: 1, description: "Entry ID on the current session branch." }),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "UTF-16 text offset within the rendered entry." }),
	),
	length: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_HISTORY_READ_LENGTH, description: "Maximum UTF-16 characters to return." }),
	),
});

const historySearchParameters = Type.Object({
	query: Type.String({ minLength: 1, description: "Case-sensitive literal text to find." }),
	windowId: Type.Optional(Type.String({ minLength: 1, description: "Only return entries attributed to this committed window." })),
	role: Type.Optional(Type.String({ minLength: 1, description: "Only return entries with this source role or entry type." })),
	cursor: Type.Optional(Type.String({ minLength: 1, description: "Cursor returned by a previous history_search call." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_PAGE_SIZE, description: "Maximum number of matching entries." })),
});

type CheckpointParameters = Static<typeof checkpointParameters>;
type HistoryReadParameters = Static<typeof historyReadParameters>;
type HistorySearchParameters = Static<typeof historySearchParameters>;
type ContextMessage = Parameters<typeof convertToLlm>[0][number];
type MessageLike = {
	role?: string;
	content?: unknown;
	customType?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
};

type HistoryExecutionStatus = "received" | "requested" | "completed" | "failed" | "saved" | "committed" | "metadata";

type ReminderLevel = "soft" | "urgent";

interface ContentBudgets {
	ledgerTokens: number;
	taskTokens: number;
	tailTokens: number;
	readTokens: number;
	outputReserveTokens: number;
}

interface RawTailMarkerData {
	schemaVersion: typeof LEDGER_SCHEMA_VERSION;
	sourceEntryId: string;
	reason: "tail-budget";
}

interface ReminderDetails {
	schemaVersion: typeof LEDGER_SCHEMA_VERSION;
	reminderKey: string;
	level: ReminderLevel;
	windowId: string;
	contextWindow: number;
	estimatedTokens: number;
	remainingTokens: number;
	usageKnown: boolean;
}

interface HistoryPayloadReference {
	kind: "image";
	mimeType: string;
	bytes: number;
	reference: string;
}

interface HistoryEntryView {
	entry: SessionEntry;
	text: string;
	role: string;
	windowId: string;
	executionStatus: HistoryExecutionStatus;
	payloads: HistoryPayloadReference[];
}

export interface RequestHistoryPosition {
	/** The current branch leaf when the provider request began. */
	entryId: string | null;
	/** Branch depth at the same point, useful when the leaf is later unavailable. */
	branchDepth: number;
}

export interface CheckpointData {
	schemaVersion: typeof LEDGER_SCHEMA_VERSION;
	ledger: string;
	activeRequestEntryIds: string[];
	requestHistoryPosition: RequestHistoryPosition;
	sourceWindowId: string;
}

export interface CheckpointReceiptDetails extends CheckpointData {
	checkpointEntryId: string;
	windowId: string;
	saveScope: "persistent" | "process-memory";
	estimatedLedgerTokens: number;
	ledgerBytes: number;
	ledgerTokenLimit: number;
	ledgerByteLimit: number;
	handoff: "awaiting-native-compaction-threshold";
	historyTools: "history_search then history_read; continue with nextCursor/nextOffset on this branch";
}

export interface PendingHistoryRange {
	fromEntryId: string | null;
	toEntryId: string | null;
}

export interface LedgerCompactionDetails {
	schemaVersion: typeof LEDGER_SCHEMA_VERSION;
	kind: typeof COMPACTION_DETAILS_KIND;
	windowId: string;
	sourceWindowId: string;
	checkpointEntryId: string | null;
	sourceBranchTip: string | null;
	firstKeptEntryId: string;
	requestHistoryPosition: RequestHistoryPosition | null;
	pendingHistoryRange: PendingHistoryRange;
}

interface StoredCheckpoint {
	entryId: string;
	data: CheckpointData;
}

interface SessionState {
	activeWindowId: string;
	boundSessionManager?: ExtensionContext["sessionManager"];
	checkpoint?: StoredCheckpoint;
	checkpointCapacityError?: string;
	requestHistoryPosition?: RequestHistoryPosition;
	inferredActiveRequestEntryIds: string[];
	lastCompactionEntryId?: string;
	persistenceUncertain?: string;
	softReminderWindowId?: string;
	urgentReminderWindowId?: string;
}

interface TailUnit {
	entries: Array<{ entry: SessionEntry; index: number }>;
}

interface ContextUnitEntry {
	message: ContextMessage;
	entryId?: string;
}

interface ContextUnit {
	entries: ContextUnitEntry[];
}

function positiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${name} must be a positive integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function reminderThresholds(contextWindow: number): { soft: number; urgent: number } {
	const defaultSoft = Math.max(2, Math.floor(Math.min(contextWindow * 0.2, DEFAULT_SOFT_REMINDER_TOKEN_LIMIT)));
	const defaultUrgent = Math.max(
		1,
		Math.min(defaultSoft - 1, Math.floor(Math.min(contextWindow * 0.1, DEFAULT_URGENT_REMINDER_TOKEN_LIMIT))),
	);
	const soft = positiveIntegerEnv("LEDGER_CONTEXT_REMINDER_TOKENS", defaultSoft);
	const urgent = positiveIntegerEnv("LEDGER_CONTEXT_URGENT_TOKENS", defaultUrgent);
	if (urgent >= soft) {
		throw new Error("LEDGER_CONTEXT_URGENT_TOKENS must be less than LEDGER_CONTEXT_REMINDER_TOKENS");
	}
	return { soft, urgent };
}

function contentBudgets(contextWindow: number): ContentBudgets {
	const defaultOutputReserve = Math.max(1, Math.floor(Math.min(contextWindow * 0.1, DEFAULT_OUTPUT_RESERVE_TOKEN_LIMIT)));
	return {
		ledgerTokens: positiveIntegerEnv("LEDGER_CONTEXT_LEDGER_TOKENS", DEFAULT_LEDGER_TOKEN_LIMIT),
		taskTokens: positiveIntegerEnv("LEDGER_CONTEXT_TASK_TOKENS", DEFAULT_TASK_TOKEN_LIMIT),
		tailTokens: positiveIntegerEnv("LEDGER_CONTEXT_TAIL_TOKENS", DEFAULT_TAIL_TOKEN_LIMIT),
		readTokens: positiveIntegerEnv("LEDGER_CONTEXT_READ_TOKENS", DEFAULT_HISTORY_READ_TOKEN_LIMIT),
		outputReserveTokens: positiveIntegerEnv("LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS", defaultOutputReserve),
	};
}

function estimateMessageTokens(messages: ContextMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function activeToolSchemaTokens(pi: ExtensionAPI): number {
	const activeTools = new Set(pi.getActiveTools());
	const schemas = pi
		.getAllTools()
		.filter((tool) => activeTools.has(tool.name))
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }));
	return ledgerTokenEstimate(safeJson(schemas));
}

function modelMetadataTokens(ctx: ExtensionContext): number {
	const model = ctx.model;
	if (!model) return 0;
	return ledgerTokenEstimate(
		safeJson({
			provider: model.provider,
			id: model.id,
			api: model.api,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
		}),
	);
}

function requestFixedTokens(pi: ExtensionAPI, ctx: ExtensionContext): number {
	return ledgerTokenEstimate(ctx.getSystemPrompt()) + activeToolSchemaTokens(pi) + modelMetadataTokens(ctx);
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

function ledgerTokenEstimate(value: string): number {
	return estimateTokens({ role: "user", content: [{ type: "text", text: value }], timestamp: 0 });
}

function visibleContextTokenEstimate(ctx: ExtensionContext): number {
	return ctx.sessionManager
		.buildContextEntries()
		.flatMap(sessionEntryToContextMessages)
		.reduce((total, message) => total + estimateTokens(message), 0);
}

function reminderUsage(ctx: ExtensionContext): { contextWindow: number; tokens: number; usageKnown: boolean } | undefined {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	if (usage?.tokens !== null && usage?.tokens !== undefined && Number.isFinite(usage.tokens) && usage.tokens >= 0) {
		return { contextWindow, tokens: Math.floor(usage.tokens), usageKnown: true };
	}
	return { contextWindow, tokens: Math.min(contextWindow, visibleContextTokenEstimate(ctx)), usageKnown: false };
}

function reminderText(level: ReminderLevel, windowId: string, usage: { contextWindow: number; tokens: number; usageKnown: boolean }): string {
	const usageText = usage.usageKnown ? `${usage.tokens}` : `unknown (visible-content estimate: ${usage.tokens})`;
	const remaining = Math.max(0, usage.contextWindow - usage.tokens);
	return [
		`Ledger Context ${level} budget reminder.`,
		`window: ${windowId}`,
		`usage: ${usageText}/${usage.contextWindow} tokens; estimated remaining: ${remaining}`,
		"Save a complete checkpoint now. The current run continues while pi waits for its native compaction threshold.",
	].join("\n");
}

function reminderDetails(
	level: ReminderLevel,
	windowId: string,
	usage: { contextWindow: number; tokens: number; usageKnown: boolean },
): ReminderDetails {
	return {
		schemaVersion: LEDGER_SCHEMA_VERSION,
		reminderKey: `${windowId}:${level}`,
		level,
		windowId,
		contextWindow: usage.contextWindow,
		estimatedTokens: usage.tokens,
		remainingTokens: Math.max(0, usage.contextWindow - usage.tokens),
		usageKnown: usage.usageKnown,
	};
}

function isReminderDetails(value: unknown): value is ReminderDetails {
	if (!value || typeof value !== "object") return false;
	const input = value as Record<string, unknown>;
	if (
		input.schemaVersion !== LEDGER_SCHEMA_VERSION ||
		(input.level !== "soft" && input.level !== "urgent") ||
		typeof input.windowId !== "string" ||
		input.windowId.length === 0 ||
		input.reminderKey !== `${input.windowId}:${input.level}` ||
		typeof input.contextWindow !== "number" ||
		!Number.isFinite(input.contextWindow) ||
		input.contextWindow <= 0 ||
		typeof input.estimatedTokens !== "number" ||
		!Number.isFinite(input.estimatedTokens) ||
		input.estimatedTokens < 0 ||
		typeof input.remainingTokens !== "number" ||
		!Number.isFinite(input.remainingTokens) ||
		input.remainingTokens < 0 ||
		typeof input.usageKnown !== "boolean"
	) {
		return false;
	}
	return true;
}

function ledgerCapacityError(value: string, tokenLimit: number): string | undefined {
	const bytes = utf8Bytes(value);
	if (bytes > LEDGER_BYTE_LIMIT) return `ledger exceeds ${LEDGER_BYTE_LIMIT} UTF-8 bytes`;
	const tokens = ledgerTokenEstimate(value);
	if (tokens > tokenLimit) return `ledger exceeds ${tokenLimit} estimated tokens`;
	return undefined;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function clippedText(value: string, maxChars: number, entryId?: string): string {
	if (value.length <= maxChars) return value;
	const marker = entryId
		? `[truncated; complete entry: ${historyEntryReference(entryId)}]`
		: "[truncated; complete entry remains in the session log]";
	const prefixLength = Math.max(1, maxChars - marker.length - 1);
	return `${value.slice(0, prefixLength)}\n${marker}`;
}

function clippedStructuredValue(value: unknown, maxChars: number, depth = 0): unknown {
	if (maxChars <= 8) {
		if (Array.isArray(value)) return [];
		if (value && typeof value === "object") return {};
		return typeof value === "string" ? value.slice(0, maxChars) : value;
	}
	if (typeof value === "string") return value.length <= maxChars ? value : value.slice(0, Math.max(1, maxChars - 1));
	if (value === null || typeof value !== "object") return value;
	if (depth >= 6) return Array.isArray(value) ? [] : {};
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		let used = 2;
		for (const item of value) {
			const remaining = maxChars - used;
			if (remaining <= 8) break;
			const clipped = clippedStructuredValue(item, Math.floor(remaining / 2), depth + 1);
			const size = safeJson(clipped).length + 1;
			if (used + size > maxChars) break;
			result.push(clipped);
			used += size;
		}
		return result;
	}
	const result: Record<string, unknown> = {};
	let used = 2;
	for (const [key, item] of Object.entries(value)) {
		const remaining = maxChars - used - key.length - 6;
		if (remaining <= 8) break;
		const clipped = clippedStructuredValue(item, Math.floor(remaining / 2), depth + 1);
		const size = key.length + safeJson(clipped).length + 5;
		if (used + size > maxChars) break;
		result[key] = clipped;
		used += size;
	}
	return result;
}

function clippedContent(content: unknown, tokenLimit: number, entryId?: string): unknown {
	const maxChars = Math.max(16, tokenLimit * 4);
	if (typeof content === "string") return clippedText(content, maxChars, entryId);
	if (!Array.isArray(content)) return content;
	const blockLimit = Math.max(16, Math.floor(maxChars / Math.max(1, content.length)));
	return content.map((block: any) => {
		if (!block || typeof block !== "object") return block;
		if (block.textSignature !== undefined || block.thinkingSignature !== undefined || block.redacted === true) return block;
		if (block.type === "text") return { ...block, text: clippedText(String(block.text ?? ""), blockLimit, entryId) };
		if (block.type === "thinking") {
			return { ...block, thinking: clippedText(String(block.thinking ?? ""), blockLimit, entryId) };
		}
		if (block.type === "image") {
			return {
				type: "text",
				text: entryId
					? `[image payload omitted; complete entry: ${historyEntryReference(entryId)}]`
					: "[image payload omitted; complete entry remains in the session log]",
			};
		}
		return block;
	});
}

function clippedContextMessage(message: ContextMessage, tokenLimit: number, entryId?: string): ContextMessage {
	const maxChars = Math.max(16, tokenLimit * 4);
	if (message.role === "assistant") {
		return {
			...message,
			content: message.content.map((block: any) => {
				if (
					block.textSignature !== undefined ||
					block.thinkingSignature !== undefined ||
					block.redacted === true ||
					block.thoughtSignature !== undefined ||
					block.namespace !== undefined
				) {
					return block;
				}
				if (block.type === "text") return { ...block, text: clippedText(block.text, maxChars, entryId) };
				if (block.type === "thinking") return block;
				if (block.type === "toolCall") {
					return {
						...block,
						arguments: clippedStructuredValue(block.arguments, Math.max(64, maxChars)),
					};
				}
				return block;
			}),
		} as ContextMessage;
	}
	if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
		return { ...message, content: clippedContent(message.content, tokenLimit, entryId) } as ContextMessage;
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return { ...message, summary: clippedText(message.summary, maxChars, entryId) } as ContextMessage;
	}
	if (message.role === "bashExecution") {
		return { ...message, output: clippedText(message.output, maxChars, entryId) } as ContextMessage;
	}
	return message;
}

function encodedPayloadBytes(data: unknown): number {
	if (typeof data !== "string") return 0;
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function payloadReference(entryId: string, contentIndex: number): string {
	return `pi://entry/${entryId}/content/${contentIndex}`;
}

function contentText(content: unknown, entryId?: string): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined ? "" : safeJson(content);

	return content
		.map((block: any, index: number) => {
			if (!block || typeof block !== "object") return String(block);
			switch (block.type) {
				case "text":
					return block.text ?? "";
				case "thinking":
					return `[thinking] ${block.thinking ?? ""}`;
				case "toolCall":
					return `[tool call ${block.name ?? "unknown"} id=${block.id ?? "unknown"}] ${safeJson(block.arguments ?? {})}`;
				case "image": {
					const reference = entryId ? ` ref=${payloadReference(entryId, index)}` : "";
					return `[image mimeType=${block.mimeType ?? "unknown"} bytes=${encodedPayloadBytes(block.data)}${reference}]`;
				}
				default:
					return safeJson(block);
			}
		})
		.join("\n");
}

function entryMessage(entry: SessionEntry): MessageLike | undefined {
	return entry.type === "message" ? (entry.message as MessageLike) : undefined;
}

function messageRole(entry: SessionEntry): string | undefined {
	return entryMessage(entry)?.role;
}

function isUserEntry(entry: SessionEntry): boolean {
	return messageRole(entry) === "user";
}

function latestUserEntry(entries: SessionEntry[]): SessionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (isUserEntry(entries[index])) return entries[index];
	}
	return undefined;
}

function userRequestEntryIds(entries: SessionEntry[]): string[] {
	const ids = entries.filter(isUserEntry).map((entry) => entry.id);
	if (ids.length <= MAX_ACTIVE_REQUEST_IDS) return ids;
	return [ids[0], ...ids.slice(-(MAX_ACTIVE_REQUEST_IDS - 1))];
}

function messageToolCallIds(entry: SessionEntry): string[] {
	const message = entryMessage(entry);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content
		.filter((block: any) => block?.type === "toolCall" && typeof block.id === "string")
		.map((block: any) => block.id);
}

function messageToolResultId(entry: SessionEntry): string | undefined {
	const message = entryMessage(entry);
	return message?.role === "toolResult" && typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function contextToolCallIds(message: ContextMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content
		.filter((block: any) => block?.type === "toolCall" && typeof block.id === "string")
		.map((block: any) => block.id);
}

function contextToolResultId(message: ContextMessage): string | undefined {
	return message.role === "toolResult" && typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function contextMessagesMatch(a: ContextMessage, b: ContextMessage): boolean {
	if (a.role !== b.role) return false;
	const right = b as any;
	if (a.role === "assistant") {
		const aIds = contextToolCallIds(a);
		const bIds = contextToolCallIds(b);
		return JSON.stringify(aIds) === JSON.stringify(bIds) && (aIds.length > 0 || safeJson(a.content) === safeJson(right.content));
	}
	if (a.role === "toolResult") return contextToolResultId(a) === contextToolResultId(b);
	if (a.role === "custom") return a.customType === right.customType;
	if (a.role === "branchSummary" || a.role === "compactionSummary") return a.summary === right.summary;
	return safeJson((a as any).content) === safeJson(right.content);
}

function contextEntryIds(messages: ContextMessage[], ctx: ExtensionContext): Array<string | undefined> {
	const entries = ctx.sessionManager
		.buildContextEntries()
		.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({ message, entryId: entry.id })));
	const ids: Array<string | undefined> = Array.from({ length: messages.length }, () => undefined);
	let messageIndex = 0;
	for (const candidate of entries) {
		if (messageIndex >= messages.length) break;
		if (!contextMessagesMatch(messages[messageIndex], candidate.message)) continue;
		ids[messageIndex] = candidate.entryId;
		messageIndex++;
	}
	return ids;
}

function createContextUnits(messages: ContextMessage[], entryIds: Array<string | undefined>): ContextUnit[] {
	const units: ContextUnit[] = [];
	const latestToolUnits = new Map<string, ContextUnit>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const entry = { message, entryId: entryIds[index] };
		const callIds = contextToolCallIds(message);
		if (callIds.length > 0) {
			const unit = { entries: [entry] };
			units.push(unit);
			for (const id of callIds) latestToolUnits.set(id, unit);
			continue;
		}
		const resultId = contextToolResultId(message);
		const resultUnit = resultId ? latestToolUnits.get(resultId) : undefined;
		if (resultUnit && units.at(-1) === resultUnit) {
			resultUnit.entries.push(entry);
			continue;
		}
		units.push({ entries: [entry] });
	}
	return units;
}

function providerMessageTokens(messages: ContextMessage[]): number {
	return estimateMessageTokens(convertToLlm(messages));
}

function isContextSummaryUnit(unit: ContextUnit): boolean {
	return unit.entries.some(({ message }) => message.role === "compactionSummary" || message.role === "branchSummary");
}

function contextUnitTokens(unit: ContextUnit): number {
	return providerMessageTokens(unit.entries.map(({ message }) => message));
}

function retainedEntryIdsForCompaction(ctx: ExtensionContext): Set<string> {
	const branch = ctx.sessionManager.getBranch();
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction" && isLedgerCompactionDetails(entry.details)) {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex < 0) return new Set();
	const compaction = branch[compactionIndex];
	if (compaction.type !== "compaction") return new Set();
	const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) return new Set();
	return new Set(branch.slice(firstKeptIndex, compactionIndex).map((entry) => entry.id));
}

function distributeContextBudget(units: ContextUnit[], indexes: number[], budget: number): Map<number, number> {
	const targets = new Map<number, number>();
	if (indexes.length === 0) return targets;
	const total = indexes.reduce((sum, index) => sum + contextUnitTokens(units[index]), 0);
	let remainingBudget = Math.max(0, budget);
	let remainingWeight = Math.max(1, total);
	for (let position = 0; position < indexes.length; position++) {
		const index = indexes[position];
		const weight = contextUnitTokens(units[index]);
		const target = position === indexes.length - 1
			? remainingBudget
			: Math.min(remainingBudget, Math.max(1, Math.floor((remainingBudget * weight) / remainingWeight)));
		targets.set(index, Math.max(1, target));
		remainingBudget = Math.max(0, remainingBudget - target);
		remainingWeight = Math.max(1, remainingWeight - weight);
	}
	return targets;
}

function fitContextUnit(unit: ContextUnit, tokenLimit: number): ContextMessage[] {
	let budget = Math.max(1, tokenLimit);
	let candidate: ContextMessage[] = [];
	for (let attempt = 0; attempt < 12; attempt++) {
		const perMessage = Math.max(1, Math.floor(budget / Math.max(1, unit.entries.length)));
		candidate = unit.entries.map(({ message, entryId }) => clippedContextMessage(message, perMessage, entryId));
		if (providerMessageTokens(candidate) <= tokenLimit || budget === 1) return candidate;
		budget = Math.max(1, Math.floor(budget / 2));
	}
	return candidate;
}

function appendContextReference(message: ContextMessage, entryId: string): ContextMessage {
	const reference = `[complete entry: ${historyEntryReference(entryId)}]`;
	if (message.role !== "user" || JSON.stringify(message.content).includes(historyEntryReference(entryId))) return message;
	let candidate: ContextMessage | undefined;
	if (typeof message.content === "string") candidate = { ...message, content: `${message.content}\n${reference}` } as ContextMessage;
	if (Array.isArray(message.content)) {
		candidate = { ...message, content: [...message.content, { type: "text", text: reference }] } as ContextMessage;
	}
	if (!candidate || providerMessageTokens([candidate]) > providerMessageTokens([message])) return message;
	return candidate;
}

function clippedContextMessages(
	messages: ContextMessage[],
	ctx: ExtensionContext,
	availableTokens: number,
	itemTokenLimit: number,
): ContextMessage[] {
	const units = createContextUnits(messages, contextEntryIds(messages, ctx));
	const retainedEntryIds = retainedEntryIdsForCompaction(ctx);
	const retainedIndexes = units
		.map((_unit, index) => index)
		.filter((index) => units[index].entries.some(({ entryId }) => entryId !== undefined && retainedEntryIds.has(entryId)));
	const summaryIndexes = units.map((_unit, index) => index).filter((index) => isContextSummaryUnit(units[index]));
	const summaryIndexSet = new Set(summaryIndexes);
	const retainedIndexSet = new Set(retainedIndexes);
	const summaryTokens = summaryIndexes.reduce((total, index) => total + contextUnitTokens(units[index]), 0);
	const nonSummaryIndexes = units.map((_unit, index) => index).filter((index) => !summaryIndexSet.has(index));
	const activeIndexes = nonSummaryIndexes.filter((index) => !retainedIndexSet.has(index));
	const retainedTokens = retainedIndexes.reduce((total, index) => total + contextUnitTokens(units[index]), 0);
	const needsClipping =
		providerMessageTokens(messages) > availableTokens ||
		units.some((unit) => contextUnitTokens(unit) > itemTokenLimit) ||
		(retainedEntryIds.size > 0 && retainedTokens > itemTokenLimit);
	if (!needsClipping) return messages;
	const clippedIndexes = new Map<number, number>();
	let latestUserEntryId: string | undefined;
	let latestUserMessage: ContextMessage | undefined;
	for (let index = units.length - 1; index >= 0 && latestUserMessage === undefined; index--) {
		for (let position = units[index].entries.length - 1; position >= 0; position--) {
			const candidate = units[index].entries[position];
			if (candidate.message.role === "user") {
				latestUserEntryId = candidate.entryId;
				latestUserMessage = candidate.message;
				break;
			}
		}
	}
	const referencedLatest = latestUserEntryId && latestUserMessage
		? appendContextReference(latestUserMessage, latestUserEntryId)
		: undefined;
	const latestReferenceReserve = latestUserMessage
		? latestUserEntryId === undefined
			? 64
			: referencedLatest && referencedLatest !== latestUserMessage
				? Math.max(0, providerMessageTokens([referencedLatest]) - providerMessageTokens([latestUserMessage])) + 64
				: 64
		: 0;
	const remainingTokens = Math.max(1, availableTokens - summaryTokens - latestReferenceReserve);
	const retainedBudget = retainedEntryIds.size > 0 ? Math.min(itemTokenLimit, remainingTokens) : 0;
	const activeRawTokens = activeIndexes.reduce((total, index) => total + contextUnitTokens(units[index]), 0);
	const retainedRawBudget = retainedIndexes.reduce((total, index) => total + contextUnitTokens(units[index]), 0);
	const nonSummaryBudget = Math.max(1, remainingTokens);
	let retainedTarget = Math.min(retainedBudget, retainedRawBudget);
	let activeTarget = Math.min(activeRawTokens, nonSummaryBudget - retainedTarget);
	if (retainedTarget + activeRawTokens > nonSummaryBudget) {
		const totalRaw = Math.max(1, retainedRawBudget + activeRawTokens);
		retainedTarget = Math.min(retainedTarget, Math.floor((nonSummaryBudget * retainedRawBudget) / totalRaw));
		activeTarget = Math.max(1, nonSummaryBudget - retainedTarget);
	}
	for (const [index, target] of distributeContextBudget(units, retainedIndexes, retainedTarget)) clippedIndexes.set(index, target);
	for (const [index, target] of distributeContextBudget(units, activeIndexes, activeTarget)) clippedIndexes.set(index, target);
	let latestUserOutputIndex = -1;
	let latestUserOutputEntryId: string | undefined;
	let outputIndex = 0;
	const bounded = units.flatMap((unit, index) => {
		const boundedUnit = summaryIndexSet.has(index)
			? unit.entries.map(({ message }) => message)
			: (() => {
				const target = Math.max(1, Math.min(itemTokenLimit, clippedIndexes.get(index) ?? contextUnitTokens(unit)));
				const full = unit.entries.map(({ message }) => message);
				return providerMessageTokens(full) <= target ? full : fitContextUnit(unit, target);
			})();
		let latestUserPosition = -1;
		for (let position = unit.entries.length - 1; position >= 0; position--) {
			if (unit.entries[position].message.role === "user") {
				latestUserPosition = position;
				break;
			}
		}
		if (latestUserPosition >= 0) {
			latestUserOutputIndex = outputIndex + latestUserPosition;
			latestUserOutputEntryId = unit.entries[latestUserPosition].entryId;
		}
		outputIndex += boundedUnit.length;
		return boundedUnit;
	});
	if (latestUserOutputIndex >= 0 && latestUserOutputEntryId) {
		bounded[latestUserOutputIndex] = appendContextReference(bounded[latestUserOutputIndex], latestUserOutputEntryId);
	}
	return bounded;
}

const MINIMUM_RECOVERY_MARKER = "[ledger-context recovery marker; use history_search and history_read for complete entries]";

function contextRequestMessages(messages: ContextMessage[], pi: ExtensionAPI, ctx: ExtensionContext): ContextMessage[] {
	const contextWindow = ctx.model?.contextWindow ?? 0;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return messages;

	try {
		const budgets = contentBudgets(contextWindow);
		const fixedTokens = requestFixedTokens(pi, ctx);
		const availableTokens = contextWindow - fixedTokens - budgets.outputReserveTokens;
		const minimumRecoveryTokens = ledgerTokenEstimate(MINIMUM_RECOVERY_MARKER);
		if (availableTokens < minimumRecoveryTokens) {
			const message = `Ledger Context capacity error: fixed context uses ${fixedTokens} tokens, output reserve uses ${budgets.outputReserveTokens}, and the ${contextWindow}-token window cannot fit recovery metadata.`;
			notify(ctx, message, "error");
			try {
				ctx.abort();
			} catch {
				// The host may already be finishing the request.
			}
			return messages;
		}
		const units = createContextUnits(messages, contextEntryIds(messages, ctx));
		const summaryTokens = units
			.filter(isContextSummaryUnit)
			.reduce((total, unit) => total + providerMessageTokens(unit.entries.map(({ message }) => message)), 0);
		if (summaryTokens > availableTokens) {
			const message = `Ledger Context capacity error: the active compaction summary uses ${summaryTokens} tokens, above the ${availableTokens}-token recovery budget.`;
			notify(ctx, message, "error");
			try {
				ctx.abort();
			} catch {
				// The host may already be finishing the request.
			}
			return messages;
		}
		const bounded = clippedContextMessages(messages, ctx, availableTokens, budgets.tailTokens);
		if (providerMessageTokens(bounded) > availableTokens) {
			const message = `Ledger Context capacity error: the bounded context still uses ${providerMessageTokens(bounded)} tokens, above the ${availableTokens}-token recovery budget.`;
			notify(ctx, message, "error");
			try {
				ctx.abort();
			} catch {
				// The host may already be finishing the request.
			}
			return messages;
		}
		return bounded;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Ledger Context capacity error: ${message}`, "error");
		try {
			ctx.abort();
		} catch {
			// The host may already be finishing the request.
		}
		return messages;
	}
}

function renderEntry(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message as MessageLike;
		const role = message.role ?? "unknown";
		const body = contentText(message.content, entry.id);
		if (role === "toolResult") {
			const error = message.isError ? " error" : "";
			return `[entry ${entry.id}] ${role}${error} tool=${message.toolName ?? "unknown"} call=${message.toolCallId ?? "unknown"}\n${body}`;
		}
		return `[entry ${entry.id}] ${role}\n${body}`;
	}
	if (entry.type === "custom") {
		return `[entry ${entry.id}] custom:${entry.customType}\n${safeJson(entry.data)}`;
	}
	if (entry.type === "compaction") {
		return `[entry ${entry.id}] compaction firstKept=${entry.firstKeptEntryId}\n${entry.summary}`;
	}
	if (entry.type === "custom_message") {
		return `[entry ${entry.id}] custom-message:${entry.customType}\n${contentText(entry.content, entry.id)}`;
	}
	if (entry.type === "branch_summary") {
		return `[entry ${entry.id}] branch-summary\n${entry.summary}`;
	}
	if (entry.type === "model_change") {
		return `[entry ${entry.id}] model ${entry.provider}/${entry.modelId}`;
	}
	if (entry.type === "thinking_level_change") {
		return `[entry ${entry.id}] thinking ${entry.thinkingLevel}`;
	}
	if (entry.type === "label") {
		return `[entry ${entry.id}] label ${entry.targetId}=${entry.label ?? ""}`;
	}
	if (entry.type === "session_info") {
		return `[entry ${entry.id}] session ${entry.name ?? ""}`;
	}
	return "[entry unknown]";
}

function historyRole(entry: SessionEntry): string {
	if (entry.type === "message") return (entry.message as MessageLike).role ?? entry.type;
	return entry.type;
}

function historyExecutionStatus(entry: SessionEntry): HistoryExecutionStatus {
	if (entry.type === "message") {
		const message = entry.message as MessageLike;
		if (message.role === "user") return "received";
		if (message.role === "assistant") return messageToolCallIds(entry).length > 0 ? "requested" : "completed";
		if (message.role === "toolResult") return message.isError ? "failed" : "completed";
	}
	if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE) return "saved";
	if (entry.type === "compaction") return "committed";
	return "metadata";
}

function imagePayloads(entry: SessionEntry): HistoryPayloadReference[] {
	const content = entry.type === "message" || entry.type === "custom_message" ? entry.type === "message" ? (entry.message as MessageLike).content : entry.content : undefined;
	if (!Array.isArray(content)) return [];
	return content.flatMap((block: any, index: number) => {
		if (block?.type !== "image") return [];
		return [
			{
				kind: "image" as const,
				mimeType: typeof block.mimeType === "string" ? block.mimeType : "unknown",
				bytes: encodedPayloadBytes(block.data),
				reference: payloadReference(entry.id, index),
			},
		];
	});
}

function branchWindowIds(entries: SessionEntry[], ctx: ExtensionContext, endIndex = entries.length - 1): string[] {
	const windowIds = entries.map(() => initialWindowId(ctx));
	for (const compaction of entries) {
		if (compaction.type !== "compaction" || !isLedgerCompactionDetails(compaction.details)) continue;
		const compactionIndex = entries.findIndex((entry) => entry.id === compaction.id);
		if (compactionIndex > endIndex) continue;
		const firstKeptIndex = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
		const start = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex;
		if (start < 0) continue;
		for (let index = start; index <= endIndex && index < windowIds.length; index++) windowIds[index] = compaction.details.windowId;
	}
	return windowIds;
}

function historyViews(entries: SessionEntry[], ctx: ExtensionContext, endIndex = entries.length - 1): HistoryEntryView[] {
	const windowIds = branchWindowIds(entries, ctx, endIndex);
	return entries.slice(0, Math.max(0, endIndex + 1)).map((entry, index) => ({
		entry,
		text: renderEntry(entry),
		role: historyRole(entry),
		windowId: windowIds[index],
		executionStatus: historyExecutionStatus(entry),
		payloads: imagePayloads(entry),
	}));
}

function historyValidationError(message: string): Error {
	return new Error(`history validation failed: ${message}`);
}

function historyReadTokenLimit(): number {
	return positiveIntegerEnv("LEDGER_CONTEXT_READ_TOKENS", DEFAULT_HISTORY_READ_TOKEN_LIMIT);
}

function payloadSummary(payloads: HistoryPayloadReference[]): string {
	if (payloads.length === 0) return "";
	return [
		"payloads:",
		...payloads.map((payload) => `- ${payload.kind} mimeType=${payload.mimeType} bytes=${payload.bytes} ref=${payload.reference}`),
	].join("\n");
}

function historyEntryReference(entryId: string): string {
	return `pi://entry/${entryId}`;
}

function historyCapacityError(tool: "history_read" | "history_search", tokenLimit: number, metadataTokens: number): Error {
	return new Error(
		`history_output_capacity: ${JSON.stringify({
			code: "history_output_capacity",
			tool,
			tokenLimit,
			metadataTokens,
			message: "The configured history output budget cannot fit the required metadata.",
		})}`,
	);
}

const HISTORY_TRUNCATION_MARKER = "[truncated; use nextOffset to continue]";

function estimatedOutputTokens(text: string): number {
	return ledgerTokenEstimate(text);
}

interface HistoryCursor {
	version: 1;
	after: string;
	through: string | null;
}

function encodeHistoryCursor(after: string, through: string | null): string {
	return JSON.stringify({ version: 1, after, through });
}

function decodeHistoryCursor(value: string): HistoryCursor {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed.version !== 1 || typeof parsed.after !== "string" || parsed.after.length === 0) {
			throw new Error("invalid cursor shape");
		}
		if (parsed.through !== null && typeof parsed.through !== "string") throw new Error("invalid cursor snapshot");
		return { version: 1, after: parsed.after, through: parsed.through as string | null };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw historyValidationError(`cursor is invalid: ${reason}`);
	}
}

function historySnapshot(entries: SessionEntry[], toolCallId?: string): { through: string | null; endIndex: number } {
	if (toolCallId) {
		let invocationIndex = -1;
		for (let index = entries.length - 1; index >= 0; index--) {
			if (entries[index].type === "message" && messageToolCallIds(entries[index]).includes(toolCallId)) {
				invocationIndex = index;
				break;
			}
		}
		if (invocationIndex >= 0) {
			return { through: entries[invocationIndex - 1]?.id ?? null, endIndex: invocationIndex - 1 };
		}
	}
	return { through: entries.at(-1)?.id ?? null, endIndex: entries.length - 1 };
}

function historyReadResult(params: HistoryReadParameters, ctx: ExtensionContext): {
	content: [{ type: "text"; text: string }];
	details: Record<string, unknown>;
} {
	if (!params || typeof params.entryId !== "string" || params.entryId.length === 0) {
		throw historyValidationError("entryId must be a non-empty current-branch entry ID");
	}
	if (params.entryId.length > MAX_HISTORY_IDENTIFIER_LENGTH) throw historyValidationError("entryId is too long");
	if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) {
		throw historyValidationError("offset must be a non-negative safe integer");
	}
	if (params.length !== undefined && (!Number.isSafeInteger(params.length) || params.length < 1 || params.length > MAX_HISTORY_READ_LENGTH)) {
		throw historyValidationError(`length must be an integer between 1 and ${MAX_HISTORY_READ_LENGTH}`);
	}

	const views = historyViews(ctx.sessionManager.getBranch(), ctx);
	const view = views.find((candidate) => candidate.entry.id === params.entryId);
	if (!view) throw historyValidationError("entry is not on the current branch");

	const tokenLimit = historyReadTokenLimit();
	const offset = params.offset ?? 0;
	if (offset > view.text.length) throw historyValidationError("offset is beyond the rendered entry");
	const payloadText = payloadSummary(view.payloads);
	const header = [
		"History entry",
		`entryId: ${view.entry.id}`,
		`reference: ${historyEntryReference(view.entry.id)}`,
		`role: ${view.role}`,
		`windowId: ${view.windowId}`,
		`executionStatus: ${view.executionStatus}`,
		`offset: ${offset}`,
	].join("\n");
	const metadataOutput = [header, "nextOffset: 1000000", payloadText, "text:", "(empty)"].filter(Boolean).join("\n");
	const metadataTokens = estimatedOutputTokens(metadataOutput);
	if (metadataTokens > tokenLimit) throw historyCapacityError("history_read", tokenLimit, metadataTokens);

	const requestedLength = params.length ?? MAX_HISTORY_READ_LENGTH;
	const maxPageLength = Math.min(requestedLength, view.text.length - offset);
	let pageLength = maxPageLength;
	let selected: { output: string; body: string; nextOffset: number | null; truncated: boolean } | undefined;
	while (pageLength > 0) {
		const body = view.text.slice(offset, offset + pageLength);
		const endOffset = offset + body.length;
		const truncated = endOffset < view.text.length;
		const visibleBody = truncated ? `${body}\n${HISTORY_TRUNCATION_MARKER}` : body || "(empty)";
		const nextOffset = truncated ? endOffset : null;
		const output = [header, `nextOffset: ${nextOffset ?? "(none)"}`, payloadText, "text:", visibleBody].filter(Boolean).join("\n");
		if (estimatedOutputTokens(output) <= tokenLimit) {
			selected = { output, body, nextOffset, truncated };
			break;
		}
		pageLength = Math.floor(pageLength / 2);
	}
	if (!selected && maxPageLength === 0) {
		const output = [header, "nextOffset: (none)", payloadText, "text:", "(empty)"].filter(Boolean).join("\n");
		if (estimatedOutputTokens(output) <= tokenLimit) selected = { output, body: "", nextOffset: null, truncated: false };
	}
	if (!selected && maxPageLength > 0) {
		const body = view.text.slice(offset, offset + 1);
		const nextOffset = offset + body.length < view.text.length ? offset + body.length : null;
		const output = [header, `nextOffset: ${nextOffset ?? "(none)"}`, payloadText, "text:", body].filter(Boolean).join("\n");
		if (estimatedOutputTokens(output) <= tokenLimit) selected = { output, body, nextOffset, truncated: nextOffset !== null };
	}
	if (!selected) throw historyCapacityError("history_read", tokenLimit, metadataTokens);
	const { output, body, nextOffset, truncated } = selected;
	return {
		content: [{ type: "text", text: output }],
		details: {
			schemaVersion: LEDGER_SCHEMA_VERSION,
			entryId: view.entry.id,
			reference: historyEntryReference(view.entry.id),
			role: view.role,
			windowId: view.windowId,
			executionStatus: view.executionStatus,
			isError: view.entry.type === "message" && (view.entry.message as MessageLike).isError === true,
			offset,
			length: body.length,
			totalLength: view.text.length,
			nextOffset,
			text: body,
			truncated,
			payloads: view.payloads,
			readTokenLimit: tokenLimit,
		},
	};
}

function historySearchResult(params: HistorySearchParameters, ctx: ExtensionContext, toolCallId?: string): {
	content: [{ type: "text"; text: string }];
	details: Record<string, unknown>;
} {
	if (!params || typeof params.query !== "string" || params.query.length === 0) {
		throw historyValidationError("query must be a non-empty literal string");
	}
	if (params.query.length > MAX_HISTORY_SEARCH_QUERY_LENGTH || utf8Bytes(params.query) > MAX_HISTORY_SEARCH_QUERY_LENGTH) {
		throw historyValidationError(`query exceeds ${MAX_HISTORY_SEARCH_QUERY_LENGTH} bytes`);
	}
	if (params.windowId !== undefined && (typeof params.windowId !== "string" || params.windowId.length === 0)) {
		throw historyValidationError("windowId must be a non-empty string");
	}
	if (params.windowId !== undefined && params.windowId.length > MAX_HISTORY_IDENTIFIER_LENGTH) throw historyValidationError("windowId is too long");
	if (params.role !== undefined && (typeof params.role !== "string" || params.role.length === 0)) {
		throw historyValidationError("role must be a non-empty string");
	}
	if (params.role !== undefined && params.role.length > MAX_HISTORY_IDENTIFIER_LENGTH) throw historyValidationError("role is too long");
	if (params.cursor !== undefined && (typeof params.cursor !== "string" || params.cursor.length === 0)) {
		throw historyValidationError("cursor must be a non-empty snapshot cursor");
	}
	if (params.cursor !== undefined && params.cursor.length > MAX_HISTORY_IDENTIFIER_LENGTH) throw historyValidationError("cursor is too long");
	if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_HISTORY_PAGE_SIZE)) {
		throw historyValidationError(`limit must be an integer between 1 and ${MAX_HISTORY_PAGE_SIZE}`);
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const snapshot = historySnapshot(branchEntries, toolCallId);
	let snapshotThrough = snapshot.through;
	let snapshotEndIndex = snapshot.endIndex;
	let startIndex = 0;
	if (params.cursor !== undefined) {
		const cursor = decodeHistoryCursor(params.cursor);
		snapshotThrough = cursor.through;
		if (cursor.through === null) {
			snapshotEndIndex = -1;
		} else {
			snapshotEndIndex = branchEntries.findIndex((entry) => entry.id === cursor.through);
			if (snapshotEndIndex < 0) throw historyValidationError("cursor snapshot is not on the current branch");
		}
		const cursorIndex = branchEntries.findIndex((entry) => entry.id === cursor.after);
		if (cursorIndex < 0) throw historyValidationError("cursor entry is not on the current branch");
		startIndex = cursorIndex + 1;
		if (startIndex > snapshotEndIndex + 1) throw historyValidationError("cursor is outside its history snapshot");
	}
	const views = historyViews(branchEntries, ctx, snapshotEndIndex);
	if (params.windowId !== undefined && !views.slice(0, snapshotEndIndex + 1).some((view) => view.windowId === params.windowId)) {
		throw historyValidationError("window is not on the current branch snapshot");
	}

	const tokenLimit = historyReadTokenLimit();
	const limit = params.limit ?? 20;
	const candidates = views
		.map((view, index) => ({ view, index }))
		.filter(({ view, index }) => {
			if (index < startIndex || index > snapshotEndIndex || (params.windowId !== undefined && view.windowId !== params.windowId)) return false;
			if (params.role !== undefined && view.role !== params.role) return false;
			return view.text.indexOf(params.query) >= 0;
		});
	const hits: Array<Record<string, unknown>> = [];
	const blocks: string[] = [];
	const metadataOutput = [
		`History search: ${JSON.stringify(params.query)} (case-sensitive literal)`,
		"hits: 0",
		"nextCursor: (none)",
	].join("\n\n");
	const metadataTokens = estimatedOutputTokens(metadataOutput);
	if (metadataTokens > tokenLimit) throw historyCapacityError("history_search", tokenLimit, metadataTokens);
	for (let candidateIndex = 0; candidateIndex < Math.min(candidates.length, limit); candidateIndex++) {
		const { view } = candidates[candidateIndex];
		const matchOffset = view.text.indexOf(params.query);
		const potentialNextCursor = candidateIndex + 1 < candidates.length ? encodeHistoryCursor(view.entry.id, snapshotThrough) : null;
		const hitPrefix = [
			`entryId: ${view.entry.id}`,
			`reference: ${historyEntryReference(view.entry.id)}`,
			`role: ${view.role}`,
			`windowId: ${view.windowId}`,
			`executionStatus: ${view.executionStatus}`,
			`matchOffset: ${matchOffset}`,
			payloadSummary(view.payloads),
			"snippet:",
		].filter(Boolean).join("\n");
		let snippetLength = Math.min(view.text.length, MAX_HISTORY_READ_LENGTH);
		let selectedSnippet: string | undefined;
		while (snippetLength >= params.query.length) {
			const snippetStart = Math.max(0, Math.min(matchOffset - Math.floor((snippetLength - params.query.length) / 2), view.text.length - snippetLength));
			const rawSnippet = view.text.slice(snippetStart, snippetStart + snippetLength);
			const snippet = snippetLength < view.text.length ? `${rawSnippet}\n${HISTORY_TRUNCATION_MARKER}` : rawSnippet;
			const block = `${hitPrefix}\n${snippet}`;
			const proposedHits = hits.length + 1;
			const proposedBlocks = [...blocks, block];
			const proposedOutput = [
				`History search: ${JSON.stringify(params.query)} (case-sensitive literal)`,
				`hits: ${proposedHits}`,
				`nextCursor: ${potentialNextCursor ?? "(none)"}`,
				...proposedBlocks,
			].join("\n\n");
			if (estimatedOutputTokens(proposedOutput) <= tokenLimit) {
				selectedSnippet = rawSnippet;
				blocks.push(block);
				break;
			}
			if (snippetLength === params.query.length) break;
			snippetLength = Math.max(params.query.length, Math.floor(snippetLength / 2));
		}
		if (selectedSnippet === undefined) {
			if (hits.length === 0) throw historyCapacityError("history_search", tokenLimit, metadataTokens);
			break;
		}
		hits.push({
			entryId: view.entry.id,
			reference: historyEntryReference(view.entry.id),
			role: view.role,
			windowId: view.windowId,
			executionStatus: view.executionStatus,
			matchOffset,
			snippet: selectedSnippet,
			payloads: view.payloads,
		});
	}

	const lastHit = hits.at(-1);
	const lastHitIndex = lastHit ? views.findIndex((view) => view.entry.id === lastHit.entryId) : -1;
	const hasMore = lastHitIndex >= 0 && candidates.some(({ index }) => index > lastHitIndex);
	const nextCursor = hasMore && typeof lastHit?.entryId === "string" ? encodeHistoryCursor(lastHit.entryId, snapshotThrough) : null;
	const output = [
		`History search: ${JSON.stringify(params.query)} (case-sensitive literal)`,
		`hits: ${hits.length}`,
		`nextCursor: ${nextCursor ?? "(none)"}`,
		...blocks,
	].join("\n\n");
	if (estimatedOutputTokens(output) > tokenLimit) throw historyCapacityError("history_search", tokenLimit, metadataTokens);
	return {
		content: [{ type: "text", text: output }],
		details: {
			schemaVersion: LEDGER_SCHEMA_VERSION,
			query: params.query,
			caseSensitive: true,
			limit,
			snapshotThrough,
			hits,
			nextCursor,
			readTokenLimit: tokenLimit,
		},
	};
}

function createTailUnits(entries: SessionEntry[], startIndex: number): TailUnit[] {
	const units: TailUnit[] = [];
	const latestToolUnits = new Map<string, TailUnit>();

	for (let index = startIndex; index < entries.length; index++) {
		const entry = entries[index];
		const callIds = messageToolCallIds(entry);
		if (callIds.length > 0) {
			const unit = { entries: [{ entry, index }] };
			units.push(unit);
			for (const id of callIds) latestToolUnits.set(id, unit);
			continue;
		}
		const resultId = messageToolResultId(entry);
		const resultUnit = resultId ? latestToolUnits.get(resultId) : undefined;
		if (resultUnit && units.at(-1) === resultUnit) {
			resultUnit.entries.push({ entry, index });
			continue;
		}
		if (sessionEntryToContextMessages(entry).length === 0 && units.length > 0) {
			units.at(-1)!.entries.push({ entry, index });
			continue;
		}
		units.push({ entries: [{ entry, index }] });
	}

	return units;
}

function renderTailReference(entry: SessionEntry): string {
	const message = entryMessage(entry);
	if (message?.role === "assistant") {
		const calls = Array.isArray(message.content)
			? message.content
					.filter((block: any) => block?.type === "toolCall")
					.map((block: any) => `tool call ${block.name ?? "unknown"} id=${block.id ?? "unknown"}`)
			: [];
		return [
			`[entry ${entry.id}] assistant ${calls.length ? calls.join(", ") : "completed"}`,
			`status: ${historyExecutionStatus(entry)}`,
			`reference: ${historyEntryReference(entry.id)}`,
		].join("\n");
	}
	if (message?.role === "toolResult") {
		return [
			`[entry ${entry.id}] toolResult tool=${message.toolName ?? "unknown"} call=${message.toolCallId ?? "unknown"}`,
			`status: ${historyExecutionStatus(entry)}`,
			`reference: ${historyEntryReference(entry.id)}`,
		].join("\n");
	}
	return [
		`[entry ${entry.id}] ${historyRole(entry)}`,
		`status: ${historyExecutionStatus(entry)}`,
		`reference: ${historyEntryReference(entry.id)}`,
	].join("\n");
}

function renderRecentInteraction(entries: SessionEntry[], firstKeptIndex: number, tokenLimit: number): string {
	const units = createTailUnits(entries, firstKeptIndex);
	return renderTailReferences(units, tokenLimit);
}

function tailUnitMessages(unit: TailUnit): ContextMessage[] {
	return unit.entries.flatMap(({ entry }) => sessionEntryToContextMessages(entry));
}

function tailUnitTokens(unit: TailUnit): number {
	return providerMessageTokens(tailUnitMessages(unit));
}

function renderTailUnitReferences(unit: TailUnit): string {
	return unit.entries
		.slice()
		.sort((a, b) => a.index - b.index)
		.map(({ entry }) => renderTailReference(entry))
		.join("\n");
}

function renderTailReferences(units: TailUnit[], tokenLimit: number): string {
	if (units.length === 0 || tokenLimit <= 0) return "";
	const selected: string[] = [];
	for (let index = units.length - 1; index >= 0; index--) {
		const reference = renderTailUnitReferences(units[index]);
		if (!reference) continue;
		const candidate = [reference, ...selected].join("\n\n");
		if (ledgerTokenEstimate(candidate) <= tokenLimit) {
			selected.unshift(reference);
			continue;
		}
		if (selected.length === 0) return "";
		break;
	}
	return selected.join("\n\n");
}

interface TailSelection {
	firstKeptEntryId: string;
	display: string;
	needsMarker: boolean;
}

function selectCompactionTail(entries: SessionEntry[], firstKeptIndex: number, tokenLimit: number): TailSelection {
	const units = createTailUnits(entries, firstKeptIndex);
	if (units.length === 0) {
		return { firstKeptEntryId: entries[firstKeptIndex].id, display: "", needsMarker: false };
	}
	const contentBudget = tokenLimit;
	const rawTokens: number[] = units.map(tailUnitTokens);
	const suffixRawTokens = Array.from({ length: units.length + 1 }, () => 0);
	const suffixReferences = Array.from({ length: units.length + 1 }, () => "");
	for (let index = units.length - 1; index >= 0; index--) {
		suffixRawTokens[index] = rawTokens[index] + suffixRawTokens[index + 1];
		suffixReferences[index] = [renderTailUnitReferences(units[index]), suffixReferences[index + 1]].filter(Boolean).join("\n\n");
	}
	// ponytail: this compaction-only scan caches suffix assembly; tokenizing each bounded candidate is O(n²), acceptable for native tail sizes, and can use cached suffix token totals if that ceiling changes.
	for (let start = 0; start < units.length; start++) {
		const retainedRawTokens = suffixRawTokens[start];
		const retainedReferences = suffixReferences[start];
		const retainedReferenceTokens = retainedReferences ? ledgerTokenEstimate(retainedReferences) : 0;
		if (retainedRawTokens + retainedReferenceTokens > contentBudget) continue;
		return {
			firstKeptEntryId: units[start].entries[0].entry.id,
			display: retainedReferences,
			needsMarker: false,
		};
	}
	const display = renderTailReferences(units, contentBudget);
	if (!display) throw new Error("tail recovery references cannot fit the configured tail budget");
	return {
		firstKeptEntryId: entries[firstKeptIndex].id,
		display,
		needsMarker: true,
	};
}

function sameRequestPosition(a: RequestHistoryPosition, b: RequestHistoryPosition): boolean {
	return a.entryId === b.entryId && a.branchDepth === b.branchDepth;
}

function parseRequestPosition(value: unknown): RequestHistoryPosition | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if ((input.entryId !== null && typeof input.entryId !== "string") || !Number.isSafeInteger(input.branchDepth)) {
		return undefined;
	}
	if (typeof input.entryId === "string" && input.entryId.length === 0) return undefined;
	if ((input.branchDepth as number) < 0) return undefined;
	return { entryId: input.entryId as string | null, branchDepth: input.branchDepth as number };
}

function parseCheckpointData(value: unknown): CheckpointData | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (input.schemaVersion !== LEDGER_SCHEMA_VERSION || typeof input.ledger !== "string") return undefined;
	if (
		!Array.isArray(input.activeRequestEntryIds) ||
		input.activeRequestEntryIds.length > MAX_ACTIVE_REQUEST_IDS ||
		input.activeRequestEntryIds.some((id) => typeof id !== "string" || id.length === 0) ||
		new Set(input.activeRequestEntryIds).size !== input.activeRequestEntryIds.length
	) {
		return undefined;
	}
	if (typeof input.sourceWindowId !== "string" || input.sourceWindowId.length === 0) return undefined;
	const requestHistoryPosition = parseRequestPosition(input.requestHistoryPosition);
	if (!requestHistoryPosition) return undefined;
	return {
		schemaVersion: LEDGER_SCHEMA_VERSION,
		ledger: input.ledger,
		activeRequestEntryIds: [...input.activeRequestEntryIds],
		requestHistoryPosition,
		sourceWindowId: input.sourceWindowId,
	};
}

function isLedgerCompactionDetails(value: unknown): value is LedgerCompactionDetails {
	if (!value || typeof value !== "object") return false;
	const input = value as Record<string, unknown>;
	const position = input.requestHistoryPosition === null ? null : parseRequestPosition(input.requestHistoryPosition);
	const pending = input.pendingHistoryRange;
	if (input.schemaVersion !== LEDGER_SCHEMA_VERSION || input.kind !== COMPACTION_DETAILS_KIND) return false;
	if (typeof input.windowId !== "string" || typeof input.sourceWindowId !== "string") return false;
	if (input.checkpointEntryId !== null && typeof input.checkpointEntryId !== "string") return false;
	if (input.sourceBranchTip !== null && typeof input.sourceBranchTip !== "string") return false;
	if (typeof input.firstKeptEntryId !== "string" || position === undefined) return false;
	if (!pending || typeof pending !== "object") return false;
	const pendingRange = pending as Record<string, unknown>;
	if (pendingRange.fromEntryId !== null && typeof pendingRange.fromEntryId !== "string") return false;
	if (pendingRange.toEntryId !== null && typeof pendingRange.toEntryId !== "string") return false;
	return true;
}

function initialWindowId(ctx: ExtensionContext): string {
	return `window:${ctx.sessionManager.getSessionId()}:initial`;
}

function createState(ctx: ExtensionContext): SessionState {
	return { activeWindowId: initialWindowId(ctx), inferredActiveRequestEntryIds: [] };
}

function restoreReminderState(state: SessionState, entries: SessionEntry[]): void {
	state.softReminderWindowId = undefined;
	state.urgentReminderWindowId = undefined;
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "custom_message" || entry.customType !== REMINDER_MESSAGE_TYPE) continue;
		const details = entry.details;
		if (!isReminderDetails(details) || details.windowId !== state.activeWindowId) continue;
		if (details.level === "urgent") {
			state.urgentReminderWindowId = state.activeWindowId;
			state.softReminderWindowId = state.activeWindowId;
		} else if (details.level === "soft") {
			state.softReminderWindowId = state.activeWindowId;
		}
	}
}

function latestBranchCompaction(entries: SessionEntry[]): Extract<SessionEntry, { type: "compaction" }> | undefined {
	return [...entries].reverse().find((entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction");
}

function latestLedgerCompaction(entries: SessionEntry[]): Extract<SessionEntry, { type: "compaction" }> | undefined {
	const compaction = latestBranchCompaction(entries);
	return compaction && isLedgerCompactionDetails(compaction.details) ? compaction : undefined;
}

function durableBranchMismatch(ctx: ExtensionContext): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return undefined;
	try {
		const durableSession = SessionManager.open(sessionFile);
		const durableEntries = durableSession.getEntries();
		const durableIds = new Set(durableEntries.map((entry) => entry.id));
		const currentBranch = ctx.sessionManager.getBranch();
		if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant")) return undefined;
		const missingEntry = currentBranch.find((entry) => !durableIds.has(entry.id));
		if (missingEntry) {
			return `session memory entry ${missingEntry.id} is not present in the persisted log`;
		}
		const leafId = ctx.sessionManager.getLeafId();
		if (leafId !== null && !durableIds.has(leafId)) return `session memory leaf ${leafId} is not present in the persisted log`;
		return undefined;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `the persisted session log could not be reopened: ${reason}`;
	}
}

function invalidateUncertainState(state: SessionState, ctx: ExtensionContext, reason: string): void {
	state.persistenceUncertain ??= reason;
	state.checkpoint = undefined;
	state.checkpointCapacityError = undefined;
	state.requestHistoryPosition = undefined;
	state.inferredActiveRequestEntryIds = [];
	state.activeWindowId = initialWindowId(ctx);
	state.lastCompactionEntryId = undefined;
	state.softReminderWindowId = undefined;
	state.urgentReminderWindowId = undefined;
}

function blockIfPersistenceUncertain(state: SessionState, ctx: ExtensionContext): boolean {
	const mismatch = durableBranchMismatch(ctx);
	if (mismatch) {
		invalidateUncertainState(state, ctx, mismatch);
		try {
			ctx.abort();
		} catch {
			// The host may already be finishing the failed operation.
		}
		notify(ctx, `Ledger Context stopped: ${mismatch}. Reopen the persisted session before continuing.`, "error");
		return true;
	}
	if (!state.persistenceUncertain) return false;
	notify(
		ctx,
		`Ledger Context stopped: ${state.persistenceUncertain}. Reopen the persisted session before continuing.`,
		"error",
	);
	return true;
}

function hydrateState(state: SessionState, entries: SessionEntry[], ctx: ExtensionContext, restoreReminders = true): void {
	const previousWindowId = state.activeWindowId;
	const previousSoftReminderWindowId = state.softReminderWindowId;
	const previousUrgentReminderWindowId = state.urgentReminderWindowId;
	const checkpointEntries = entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE,
	);
	let checkpoint: StoredCheckpoint | undefined;
	state.checkpointCapacityError = undefined;
	for (let index = checkpointEntries.length - 1; index >= 0; index--) {
		const entry = checkpointEntries[index];
		const data = parseCheckpointData(entry.data);
		if (data) {
			try {
				const tokenLimit = positiveIntegerEnv("LEDGER_CONTEXT_LEDGER_TOKENS", DEFAULT_LEDGER_TOKEN_LIMIT);
				const capacityError = ledgerCapacityError(data.ledger, tokenLimit);
				if (capacityError) {
					state.checkpointCapacityError = capacityError;
					checkpoint = undefined;
					break;
				}
			} catch (error) {
				state.checkpointCapacityError = error instanceof Error ? error.message : String(error);
				checkpoint = undefined;
				break;
			}
			checkpoint = { entryId: entry.id, data };
			break;
		}
	}
	state.checkpoint = checkpoint;
	state.inferredActiveRequestEntryIds = checkpoint?.data.activeRequestEntryIds ?? userRequestEntryIds(entries);

	const latestWindow = latestLedgerCompaction(entries);
	if (latestWindow && isLedgerCompactionDetails(latestWindow.details)) {
		state.activeWindowId = latestWindow.details.windowId;
		state.lastCompactionEntryId = latestWindow.id;
	} else {
		state.activeWindowId = initialWindowId(ctx);
		state.lastCompactionEntryId = undefined;
	}
	state.requestHistoryPosition = state.checkpoint?.data.requestHistoryPosition;
	if (restoreReminders) restoreReminderState(state, entries);
	if (restoreReminders && previousWindowId === state.activeWindowId) {
		if (previousSoftReminderWindowId === state.activeWindowId) state.softReminderWindowId = state.activeWindowId;
		if (previousUrgentReminderWindowId === state.activeWindowId) state.urgentReminderWindowId = state.activeWindowId;
	}
}

function requestPositionForContext(entries: SessionEntry[]): RequestHistoryPosition {
	return { entryId: entries.at(-1)?.id ?? null, branchDepth: entries.length };
}

function findEntry(entries: SessionEntry[], id: string): SessionEntry | undefined {
	return entries.find((entry) => entry.id === id);
}

function pendingHistoryRange(entries: SessionEntry[], position: RequestHistoryPosition | null): PendingHistoryRange {
	if (!position?.entryId) return { fromEntryId: entries[0]?.id ?? null, toEntryId: entries.at(-1)?.id ?? null };
	const index = entries.findIndex((entry) => entry.id === position.entryId);
	return index >= 0 && index + 1 < entries.length
		? { fromEntryId: entries[index + 1].id, toEntryId: entries.at(-1)?.id ?? null }
		: { fromEntryId: null, toEntryId: null };
}

function completeUnitFirstKeptEntryId(entries: SessionEntry[], firstKeptEntryId: string): string {
	const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (firstKeptIndex < 0) return firstKeptEntryId;
	const resultId = messageToolResultId(entries[firstKeptIndex]);
	if (!resultId) return firstKeptEntryId;
	for (let index = firstKeptIndex - 1; index >= 0; index--) {
		if (messageToolCallIds(entries[index]).includes(resultId)) return entries[index].id;
	}
	return firstKeptEntryId;
}

function taskSectionText(active: string, latest: string, focus?: string): string {
	const sections = [
		`<active>\n${active || "(none recorded)"}\n</active>`,
		`<latest>\n${latest || "(none recorded)"}\n</latest>`,
	];
	if (focus) sections.push(`<focus>\n${focus}\n</focus>`);
	return sections.join("\n\n");
}

function renderTaskEntryReferences(entries: SessionEntry[], tokenLimit: number): string {
	if (entries.length === 0) return "(none recorded)";
	const selected: string[] = [];
	for (const entry of entries) {
		const full = renderEntry(entry);
		const fullCandidate = [...selected, full].join("\n\n");
		if (ledgerTokenEstimate(fullCandidate) <= tokenLimit) {
			selected.push(full);
			continue;
		}
		const reference = renderTailReference(entry);
		const referenceCandidate = [...selected, reference].join("\n\n");
		if (ledgerTokenEstimate(referenceCandidate) <= tokenLimit) selected.push(reference);
	}
	return selected.length > 0 ? selected.join("\n\n") : "(none recorded)";
}

function fitTaskText(
	value: string,
	entryId: string | undefined,
	compose: (candidate: string) => string,
	tokenLimit: number,
): string {
	if (ledgerTokenEstimate(compose(value)) <= tokenLimit) return value;
	const marker = entryId
		? `[truncated; complete entry: ${historyEntryReference(entryId)}]`
		: "[truncated; complete text remains in the session log]";
	const markerCandidate = `\n${marker}`;
	if (ledgerTokenEstimate(compose(markerCandidate)) > tokenLimit) {
		throw new Error("task recovery requires more than the configured task budget for its complete-entry reference");
	}
	let low = 0;
	let high = value.length;
	let best = markerCandidate;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = `${value.slice(0, middle)}${markerCandidate}`;
		if (ledgerTokenEstimate(compose(candidate)) <= tokenLimit) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function fitFocusText(value: string, compose: (candidate: string) => string, tokenLimit: number): string {
	if (ledgerTokenEstimate(compose(value)) <= tokenLimit) return value;
	if (value.length === 0 || ledgerTokenEstimate(compose(value.slice(0, 1))) > tokenLimit) {
		throw new Error("compact instructions cannot fit the configured task budget");
	}
	let low = 1;
	let high = value.length;
	let best = value.slice(0, 1);
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = value.slice(0, middle);
		if (ledgerTokenEstimate(compose(candidate)) <= tokenLimit) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function renderTaskSection(
	entries: SessionEntry[],
	activeRequestEntryIds: string[],
	customInstructions: string | undefined,
	taskTokenLimit: number,
): string {
	const taskBudget = Math.max(1, taskTokenLimit - 4);
	const activeEntries = activeRequestEntryIds
		.map((id) => findEntry(entries, id))
		.filter((entry): entry is SessionEntry => entry !== undefined);
	const latest = latestUserEntry(entries);
	const activeWithoutLatest = activeEntries.filter((entry) => entry.id !== latest?.id);
	const fullActive = renderTaskEntryReferences(activeWithoutLatest, taskBudget);
	const fullLatest = latest ? renderEntry(latest) : "(none recorded)";
	const fullFocus = customInstructions?.trim() ? customInstructions.trim() : "";
	const compose = (active: string, latestText: string, focus?: string): string => taskSectionText(active, latestText, focus);
	let active = fullActive;
	let latestText = fullLatest;
	let focus = fullFocus;
	let output = compose(active, latestText, focus);
	if (ledgerTokenEstimate(output) > taskBudget) {
		let activeBudget = Math.max(1, Math.floor(taskBudget / 2));
		active = renderTaskEntryReferences(activeWithoutLatest, activeBudget);
		output = compose(active, latestText, focus);
		while (ledgerTokenEstimate(output) > taskBudget && activeBudget > 1) {
			activeBudget = Math.max(1, Math.floor(activeBudget / 2));
			active = renderTaskEntryReferences(activeWithoutLatest, activeBudget);
			output = compose(active, latestText, focus);
		}
		if (ledgerTokenEstimate(output) > taskBudget) {
			if (focus) {
				let focusBudget = Math.max(1, Math.floor(taskBudget / 4));
				for (let attempt = 0; attempt < 8; attempt++) {
					try {
						focus = fitFocusText(fullFocus, (candidate) => candidate, focusBudget);
					} catch {
						focusBudget = Math.max(1, Math.floor(focusBudget / 2));
						continue;
					}
					try {
						latestText = fitTaskText(fullLatest, latest?.id, (candidate) => compose(active, candidate, focus), taskBudget);
						output = compose(active, latestText, focus);
						if (ledgerTokenEstimate(output) <= taskBudget) break;
					} catch {
						// Reduce optional focus until the latest request reference can fit.
					}
					focusBudget = Math.max(1, Math.floor(focusBudget / 2));
				}
			} else {
				latestText = fitTaskText(fullLatest, latest?.id, (candidate) => compose(active, candidate), taskBudget);
				output = compose(active, latestText);
			}
		}
	}
	if (ledgerTokenEstimate(output) > taskBudget) {
		throw new Error("task recovery content exceeds the configured task budget");
	}
	return output;
}

function renderBootstrap(
	entries: SessionEntry[],
	firstKeptIndex: number,
	state: SessionState,
	details: LedgerCompactionDetails,
	customInstructions: string | undefined,
	budgets: ContentBudgets,
	tailOverride?: string,
): string {
	const ledger = state.checkpoint?.data.ledger ?? "(checkpoint missing; inspect the complete session history before acting)";
	const ledgerError = ledgerCapacityError(ledger, budgets.ledgerTokens);
	if (ledgerError) throw new Error(`stored checkpoint cannot fit the current ledger budget: ${ledgerError}`);
	const task = renderTaskSection(
		entries,
		state.checkpoint?.data.activeRequestEntryIds ?? state.inferredActiveRequestEntryIds,
		customInstructions,
		budgets.taskTokens,
	);
	const tail = tailOverride ?? renderRecentInteraction(entries, firstKeptIndex, budgets.tailTokens);
	return [
		"# Ledger Context Recovery",
		`schemaVersion: ${LEDGER_SCHEMA_VERSION}`,
		`windowId: ${details.windowId}`,
		`checkpointEntryId: ${details.checkpointEntryId ?? "(missing)"}`,
		`sourceWindowId: ${details.sourceWindowId}`,
		`sourceBranchTip: ${details.sourceBranchTip ?? "(empty)"}`,
		`firstKeptEntryId: ${details.firstKeptEntryId}`,
		`pendingHistory: ${details.pendingHistoryRange.fromEntryId ?? "(none)"}..${details.pendingHistoryRange.toEntryId ?? "(none)"}`,
		"",
		"<active-ledger>",
		ledger,
		"</active-ledger>",
		"",
		task,
		"",
		"<recent-interaction>",
		tail || "(none retained; complete branch remains in the pi session log)",
		"</recent-interaction>",
		"",
		"<recovery-guidance>",
		"The checkpoint is the latest saved working state. Verify recent execution facts and distinguish planned, executed, and verified work before repeating side effects.",
		"Use history_search for case-sensitive literal evidence lookup on this branch, then history_read with entryId and nextOffset for bounded source text.",
		"History results identify the source role, committed window, execution status, and stable entry or payload references. Image payloads are reported with metadata and stable references.",
		"Complete session entries remain in the pi session log for later recovery; a pending range identifies entries after the checkpoint request position.",
		"</recovery-guidance>",
	].join("\n");
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// Reporting must never turn a handled checkpoint/compaction failure into a host fallback.
	}
}

function sendBudgetReminder(
	pi: ExtensionAPI,
	state: SessionState,
	ctx: ExtensionContext,
	delivery: "steer" | "nextTurn",
): void {
	if (state.persistenceUncertain) return;
	const usage = reminderUsage(ctx);
	if (!usage) return;
	const thresholds = reminderThresholds(usage.contextWindow);
	const remaining = usage.contextWindow - usage.tokens;
	const level: ReminderLevel | undefined =
		remaining <= thresholds.urgent ? "urgent" : remaining <= thresholds.soft ? "soft" : undefined;
	if (!level) return;
	if (level === "urgent") {
		if (state.urgentReminderWindowId === state.activeWindowId) return;
		state.urgentReminderWindowId = state.activeWindowId;
		state.softReminderWindowId = state.activeWindowId;
	} else {
		if (state.softReminderWindowId === state.activeWindowId) return;
		state.softReminderWindowId = state.activeWindowId;
	}

	const details = reminderDetails(level, state.activeWindowId, usage);
	const deliveryOptions = delivery === "steer" ? { deliverAs: "steer" as const } : { triggerTurn: false as const };
	pi.sendMessage(
		{
			customType: REMINDER_MESSAGE_TYPE,
			content: reminderText(level, state.activeWindowId, usage),
			display: false,
			details,
		},
		deliveryOptions,
	);
}

function validationError(message: string): Error {
	return new Error(`checkpoint validation failed: ${message}`);
}

function validateCheckpoint(
	params: CheckpointParameters,
	state: SessionState,
	entries: SessionEntry[],
): { data: CheckpointData; estimatedLedgerTokens: number; ledgerBytes: number; ledgerTokenLimit: number } {
	if (!params || typeof params.ledger !== "string" || params.ledger.trim().length === 0) {
		throw validationError("ledger must be a non-empty string");
	}
	const ledgerTokenLimit = positiveIntegerEnv("LEDGER_CONTEXT_LEDGER_TOKENS", DEFAULT_LEDGER_TOKEN_LIMIT);
	const ledgerBytes = utf8Bytes(params.ledger);
	const estimatedLedgerTokens = ledgerTokenEstimate(params.ledger);
	const capacityError = ledgerCapacityError(params.ledger, ledgerTokenLimit);
	if (capacityError) throw validationError(capacityError);

	if (params.activeRequestEntryIds !== undefined && !Array.isArray(params.activeRequestEntryIds)) {
		throw validationError("activeRequestEntryIds must be an array of strings");
	}
	const requestedIds = params.activeRequestEntryIds ?? state.checkpoint?.data.activeRequestEntryIds ?? state.inferredActiveRequestEntryIds;
	if (!Array.isArray(requestedIds)) throw validationError("activeRequestEntryIds must be an array of strings");
	if (requestedIds.length > MAX_ACTIVE_REQUEST_IDS) {
		throw validationError(`at most ${MAX_ACTIVE_REQUEST_IDS} active request IDs are allowed`);
	}
	const ids = [...requestedIds];
	if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
		throw validationError("activeRequestEntryIds must contain non-empty strings");
	}
	if (new Set(ids).size !== ids.length) throw validationError("activeRequestEntryIds must not contain duplicates");
	const branchIds = new Set(entries.map((entry) => entry.id));
	for (const id of ids) {
		const entry = findEntry(entries, id);
		if (!entry) throw validationError(`active request entry ${id} is not on the current branch`);
		if (!isUserEntry(entry)) throw validationError(`active request entry ${id} must reference a user message`);
	}

	const requestHistoryPosition = state.requestHistoryPosition ?? requestPositionForContext(entries);
	if (requestHistoryPosition.entryId !== null && !branchIds.has(requestHistoryPosition.entryId)) {
		throw validationError("the request history position is not on the current branch");
	}
	return {
		data: {
			schemaVersion: LEDGER_SCHEMA_VERSION,
			ledger: params.ledger,
			activeRequestEntryIds: ids,
			requestHistoryPosition,
			sourceWindowId: state.activeWindowId,
		},
		estimatedLedgerTokens,
		ledgerBytes,
		ledgerTokenLimit,
	};
}

function matchesCheckpointEntry(entry: SessionEntry, data: CheckpointData): boolean {
	if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) return false;
	const parsed = parseCheckpointData(entry.data);
	return (
		parsed !== undefined &&
		parsed.ledger === data.ledger &&
		parsed.sourceWindowId === data.sourceWindowId &&
		JSON.stringify(parsed.activeRequestEntryIds) === JSON.stringify(data.activeRequestEntryIds) &&
		sameRequestPosition(parsed.requestHistoryPosition, data.requestHistoryPosition)
	);
}

function appendCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: SessionState,
	data: CheckpointData,
): { entryId: string; saveScope: CheckpointReceiptDetails["saveScope"] } {
	const previousLeafId = ctx.sessionManager.getLeafId();
	try {
		pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
		const entry = ctx.sessionManager.getLeafEntry();
		if (!entry || entry.id === previousLeafId || !matchesCheckpointEntry(entry, data)) {
			throw new Error("pi did not expose the newly appended checkpoint entry");
		}
		const saveScope = ctx.sessionManager.getSessionFile() ? "persistent" : "process-memory";
		return { entryId: entry.id, saveScope };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		state.persistenceUncertain = reason;
		try {
			ctx.abort();
		} catch {
			// The host may already be finishing the failed tool operation.
		}
		const recoveryMessage =
			`checkpoint persistence is uncertain after a log error: ${reason}. Reopen the persisted session before saving or compacting again.`;
		notify(ctx, recoveryMessage, "error");
		throw new Error(recoveryMessage);
	}
}

function appendTailMarker(pi: ExtensionAPI, ctx: ExtensionContext, state: SessionState, sourceEntryId: string): string {
	const previousLeafId = ctx.sessionManager.getLeafId();
	const data: RawTailMarkerData = { schemaVersion: LEDGER_SCHEMA_VERSION, sourceEntryId, reason: "tail-budget" };
	try {
		pi.appendEntry(RAW_TAIL_MARKER_ENTRY_TYPE, data);
		const entry = ctx.sessionManager.getLeafEntry();
		if (
			!entry ||
			entry.id === previousLeafId ||
			entry.type !== "custom" ||
			entry.customType !== RAW_TAIL_MARKER_ENTRY_TYPE ||
			JSON.stringify(entry.data) !== JSON.stringify(data)
		) {
			throw new Error("pi did not expose the newly appended tail marker entry");
		}
		return entry.id;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		state.persistenceUncertain = reason;
		try {
			ctx.abort();
		} catch {
			// The host may already be finishing the failed compaction.
		}
		const recoveryMessage =
			`tail marker persistence is uncertain after a log error: ${reason}. Reopen the persisted session before saving or compacting again.`;
		notify(ctx, recoveryMessage, "error");
		throw new Error(recoveryMessage);
	}
}

function compactionDetails(
	ctx: ExtensionContext,
	state: SessionState,
	entries: SessionEntry[],
	firstKeptEntryId: string,
): LedgerCompactionDetails {
	const checkpointEntryId = state.checkpoint?.entryId ?? null;
	const sourceBranchTip = entries.at(-1)?.id ?? null;
	const windowId = `window:${ctx.sessionManager.getSessionId()}:${randomUUID()}`;
	const requestHistoryPosition = state.checkpoint?.data.requestHistoryPosition ?? null;
	return {
		schemaVersion: LEDGER_SCHEMA_VERSION,
		kind: COMPACTION_DETAILS_KIND,
		windowId,
		sourceWindowId: state.activeWindowId,
		checkpointEntryId,
		sourceBranchTip,
		firstKeptEntryId,
		requestHistoryPosition,
		pendingHistoryRange: requestHistoryPosition
			? pendingHistoryRange(entries, requestHistoryPosition)
			: { fromEntryId: entries[0]?.id ?? null, toEntryId: entries.at(-1)?.id ?? null },
	};
}

export default function ledgerContext(pi: ExtensionAPI): void {
	const states = new Map<string, SessionState>();

	const getState = (ctx: ExtensionContext): SessionState => {
		const key = ctx.sessionManager.getSessionId();
		let state = states.get(key);
		if (!state) {
			state = createState(ctx);
			states.set(key, state);
		} else if (state.boundSessionManager !== ctx.sessionManager) {
			state.persistenceUncertain = undefined;
		}
		state.boundSessionManager = ctx.sessionManager;
		return state;
	};

	pi.on("session_start", async (_event, ctx) => {
		const state = getState(ctx);
		if (blockIfPersistenceUncertain(state, ctx)) return;
		hydrateState(state, ctx.sessionManager.getBranch(), ctx);
	});

	pi.on("context", async (event, ctx) => {
		const state = getState(ctx);
		if (blockIfPersistenceUncertain(state, ctx)) return { messages: [] };
		const entries = ctx.sessionManager.getBranch();
		state.requestHistoryPosition = requestPositionForContext(entries);
		if (!state.checkpoint) state.inferredActiveRequestEntryIds = userRequestEntryIds(entries);
		return { messages: contextRequestMessages(event.messages, pi, ctx) };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (event.message.role !== "assistant" || event.toolResults.length === 0) return;
		try {
			const state = getState(ctx);
			if (blockIfPersistenceUncertain(state, ctx)) return;
			sendBudgetReminder(pi, state, ctx, "steer");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Ledger Context budget reminders disabled: ${message}`, "error");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const state = getState(ctx);
			if (blockIfPersistenceUncertain(state, ctx)) return;
			sendBudgetReminder(pi, state, ctx, "nextTurn");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Ledger Context budget reminders disabled: ${message}`, "error");
		}
	});

	pi.on("input", async (_event, ctx) => {
		const state = getState(ctx);
		return blockIfPersistenceUncertain(state, ctx) ? { action: "handled" } : undefined;
	});

	pi.on("session_tree", async (_event, ctx) => {
		const state = getState(ctx);
		if (blockIfPersistenceUncertain(state, ctx)) return;
		hydrateState(state, ctx.sessionManager.getBranch(), ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		const state = getState(ctx);
		if (blockIfPersistenceUncertain(state, ctx)) return;
		hydrateState(state, ctx.sessionManager.getBranch(), ctx);
	});

	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description: "Save the complete active working ledger for recovery at the next native context compaction.",
		promptSnippet: "save working state for context recovery",
		promptGuidelines: [
			"After important decisions, user corrections, or execution state changes, save a complete ledger covering goals, constraints, completed and verified work, current work, decisions, next steps, and evidence references.",
		],
		parameters: checkpointParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = getState(ctx);
			if (blockIfPersistenceUncertain(state, ctx)) {
				throw new Error(
					`session persistence is uncertain: ${state.persistenceUncertain}. Reopen the persisted session before retrying.`,
				);
			}
			const entries = ctx.sessionManager.getBranch();
			const validated = validateCheckpoint(params, state, entries);
			const saved = appendCheckpoint(pi, ctx, state, validated.data);
			state.checkpoint = { entryId: saved.entryId, data: validated.data };
			state.inferredActiveRequestEntryIds = validated.data.activeRequestEntryIds;
			state.requestHistoryPosition = validated.data.requestHistoryPosition;
			const details: CheckpointReceiptDetails = {
				...validated.data,
				checkpointEntryId: saved.entryId,
				windowId: validated.data.sourceWindowId,
				saveScope: saved.saveScope,
				estimatedLedgerTokens: validated.estimatedLedgerTokens,
				ledgerBytes: validated.ledgerBytes,
				ledgerTokenLimit: validated.ledgerTokenLimit,
				ledgerByteLimit: LEDGER_BYTE_LIMIT,
				handoff: "awaiting-native-compaction-threshold",
				historyTools: "history_search then history_read; continue with nextCursor/nextOffset on this branch",
			};
			const scopeText = saved.saveScope === "persistent" ? "persistent session log" : "current process memory only (in-memory session)";
			return {
				content: [
					{
						type: "text",
						text: [
							"Checkpoint saved.",
							`entry: ${saved.entryId}`,
							`window: ${validated.data.sourceWindowId}`,
							`scope: ${scopeText}`,
							`history position: ${validated.data.requestHistoryPosition.entryId ?? "empty branch"}`,
							`ledger: ${validated.estimatedLedgerTokens} estimated tokens / ${validated.ledgerBytes} UTF-8 bytes`,
							"handoff: saved; waiting for pi's native compaction threshold.",
						].join("\n"),
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "history_read",
		label: "History Read",
		description: "Read a bounded rendered entry from the current session branch by entry ID; use nextOffset for more text.",
		promptSnippet: "read a bounded current-branch history entry",
		promptGuidelines: [
			"Use the entryId returned by history_search or a checkpoint/history reference.",
			"Use nextOffset to read later text; results include the source role, committed window, execution status, and payload references.",
		],
		parameters: historyReadParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return historyReadResult(params, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw message.startsWith("history validation failed:") || message.startsWith("history_output_capacity:")
					? error
					: historyValidationError(message);
			}
		},
	});

	pi.registerTool({
		name: "history_search",
		label: "History Search",
		description: "Search the current session branch with a bounded, case-sensitive literal query; use nextCursor for more matches.",
		promptSnippet: "search current-branch history with a literal query",
		promptGuidelines: [
			"Search is literal and case-sensitive; use the returned entryId with history_read to inspect the source text.",
			"Results are limited to the current branch and include committed window, source role, execution status, and nextCursor.",
		],
		parameters: historySearchParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return historySearchResult(params, ctx, _toolCallId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw message.startsWith("history validation failed:") || message.startsWith("history_output_capacity:")
					? error
					: historyValidationError(message);
			}
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const state = getState(ctx);
		try {
			if (blockIfPersistenceUncertain(state, ctx)) return { cancel: true };
			if (event.signal.aborted) return { cancel: true };
			let entries = event.branchEntries;
			const budgets = contentBudgets(ctx.model?.contextWindow ?? 0);
			hydrateState(state, entries, ctx, false);
			if (state.checkpointCapacityError) {
				throw new Error(`stored checkpoint cannot fit the current ledger budget: ${state.checkpointCapacityError}`);
			}
			let firstKeptEntryId = completeUnitFirstKeptEntryId(entries, event.preparation.firstKeptEntryId);
			let firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
			if (firstKeptIndex < 0) {
				throw new Error(`first kept entry ${firstKeptEntryId} is not on the current branch`);
			}
			const tailSelection = selectCompactionTail(entries, firstKeptIndex, budgets.tailTokens);
			let tailDisplay = tailSelection.display;
			if (tailSelection.needsMarker) {
				firstKeptEntryId = appendTailMarker(pi, ctx, state, firstKeptEntryId);
				entries = ctx.sessionManager.getBranch();
				firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
				if (firstKeptIndex < 0) {
					throw new Error(`tail marker ${firstKeptEntryId} is not on the current branch`);
				}
			} else {
				firstKeptEntryId = tailSelection.firstKeptEntryId;
				firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
			}
			const details = compactionDetails(ctx, state, entries, firstKeptEntryId);
			const summary = renderBootstrap(entries, firstKeptIndex, state, details, event.customInstructions, budgets, tailDisplay);
			const availableTokens = (ctx.model?.contextWindow ?? 0) - requestFixedTokens(pi, ctx) - budgets.outputReserveTokens;
			const summaryTokens = ledgerTokenEstimate(summary);
			if (summaryTokens > availableTokens) {
				throw new Error(`recovery bootstrap requires ${summaryTokens} tokens, above the ${availableTokens}-token budget`);
			}
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!event.signal.aborted) notify(ctx, `Ledger Context compaction cancelled: ${message}`, "error");
			return { cancel: true };
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const latestCompaction = latestBranchCompaction(branch);
		if (!latestCompaction || latestCompaction.id !== event.compactionEntry.id) return;
		const details = latestCompaction.details;
		if (!isLedgerCompactionDetails(details)) return;
		const state = getState(ctx);
		if (blockIfPersistenceUncertain(state, ctx)) return;
		if (state.lastCompactionEntryId === latestCompaction.id) return;
		state.activeWindowId = details.windowId;
		state.lastCompactionEntryId = latestCompaction.id;
		state.softReminderWindowId = undefined;
		state.urgentReminderWindowId = undefined;
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		const state = getState(ctx);
		if (event.fromExtension && event.errorMessage && !event.aborted) {
			state.persistenceUncertain = event.errorMessage;
			try {
				ctx.abort();
			} catch {
				// The host may already have stopped the failed compaction.
			}
			notify(
				ctx,
				`Ledger Context stopped after a session log error: ${event.errorMessage}. Reopen the persisted session before continuing.`,
				"error",
			);
		}
	});
}
