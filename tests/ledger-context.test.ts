import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	DefaultPackageManager,
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	convertToLlm,
	estimateTokens,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionError,
	type SessionEntry,
	type ToolDefinition,
	type CreateAgentSessionRuntimeFactory,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import {
	Type,
	fauxAssistantMessage,
	fauxProvider,
	fauxThinking,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Context,
	type JsonObject,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY_TYPE, MAX_HISTORY_IMAGE_BASE64_BYTES, REMINDER_MESSAGE_TYPE, createLedgerContext, type LedgerContextSettingsReader, type LedgerCompactionDetails } from "../src/ledger-context.ts";

const TEST_TIMEOUT_MS = 5_000;
const extensionErrors: ExtensionError[] = [];
const RED_2X2_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const BLUE_3X2_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEElEQVR4nGNgYPj/H4GROACPigv118uacgAAAABJRU5ErkJggg==";
const UNMEASURED_INPUT_RECORD = { measurement: "unmeasured", source: "agent-context", snapshotThrough: null, recoveryBasis: null };

function generatedDelta(entry: Extract<SessionEntry, { type: "compaction" }>) {
	const details = entry.details as LedgerCompactionDetails;
	assert.equal(details.schemaVersion, 4);
	assert.equal(details.delta.status, "generated");
	assert.ok(details.delta.status === "generated");
	return details.delta.record;
}

test("agent checkpoint ownership survives cumulative deltas and updates the next request", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { compactionEnabled: false });
	try {
		const ledger = "Only staging. Preserve checkpoint-sentinel. Next: verify migration.";
		faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger })), fauxAssistantMessage("Saved the working state.")]);
		await session.prompt("Preserve the staging constraint and track the migration.");
		const checkpoint = checkpointEntries(sessionManager.getBranch()).at(-1)!;
		const original = structuredClone(checkpoint.data);
		ledgerFaux.setResponses([fauxAssistantMessage("Migration completed; delta-one-sentinel.")]);
		await session.compact();
		const first = latestCompaction(sessionManager.getBranch());
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 1);
		assert.deepEqual(checkpoint.data, original);
		assert.match(first.summary, /checkpoint-sentinel/);
		assert.match(first.summary, /delta-one-sentinel/);
		faux.setResponses([fauxAssistantMessage("Verification finished.")]);
		await session.prompt("Verify the completed migration.");
		ledgerFaux.setResponses([(context) => {
			assert.match(JSON.stringify(context.messages), /delta-one-sentinel/);
			assert.match(JSON.stringify(context.messages), /checkpoint-sentinel/);
			return fauxAssistantMessage("Migration and verification completed; delta-two-sentinel.");
		}]);
		await session.compact();
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 1);
		const persistedSummary = latestCompaction(sessionManager.getBranch()).summary;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Only staging. Completed and verified; checkpoint-two-sentinel." })),
			(context) => {
				const recovery = context.messages.flatMap((message) => message.role === "user" && Array.isArray(message.content) ? message.content.filter((block) => block.type === "text").map((block) => block.text) : []).find((text) => text.includes("# Ledger Context Recovery"))!;
				assert.ok(recovery);
				assert.match(recovery, /checkpoint-two-sentinel/);
				assert.doesNotMatch(recovery, /delta-two-sentinel/);
				assert.doesNotMatch(recovery, /checkpoint-sentinel/);
				return fauxAssistantMessage("Using the new working state.");
			},
		]);
		await session.prompt("Save the complete current working state.");
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 2);
		assert.equal(latestCompaction(sessionManager.getBranch()).summary, persistedSummary);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

function use4kRecoveryBudgets(t: TestContext): void {
	for (const name of ["LEDGER_CONTEXT_TASK_TOKENS", "LEDGER_CONTEXT_TAIL_TOKENS"]) {
		const previous = process.env[name];
		process.env[name] = "4096";
		t.after(() => {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		});
	}
}

function highEntropyPng(width: number, height: number): string {
	const rowBytes = width * 4 + 1;
	const raw = Buffer.alloc(rowBytes * height);
	let state = 0x12345678;
	for (let index = 0; index < raw.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		raw[index] = state & 0xff;
	}
	for (let row = 0; row < height; row++) raw[row * rowBytes] = 0;
	const chunk = (name: string, data: Buffer): Buffer => {
		const type = Buffer.from(name, "ascii");
		const output = Buffer.alloc(12 + data.length);
		output.writeUInt32BE(data.length, 0);
		type.copy(output, 4);
		data.copy(output, 8);
		output.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
		return output;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function collectExtensionError(error: ExtensionError): void {
	extensionErrors.push(error);
}

function messageEntries(entries: SessionEntry[]): Array<Extract<SessionEntry, { type: "message" }>> {
	return entries.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message");
}

function checkpointEntries(entries: SessionEntry[]): Array<Extract<SessionEntry, { type: "custom" }>> {
	return entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" && entry.customType === "ledger-context/checkpoint",
	);
}

function toolResultText(entry: Extract<SessionEntry, { type: "message" }>): string {
	const content = (entry.message as { content: unknown }).content;
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.filter((block): block is { type: "text"; text: string } => Boolean(block && typeof block === "object" && block.type === "text"))
		.map((block) => block.text)
		.join("\n");
}

function assertHistoryOutputWithinTokens(entry: Extract<SessionEntry, { type: "message" }>, limit = 2_048): void {
	const text = toolResultText(entry);
	assert.ok(
		estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) <= limit,
		`${(entry.message as { toolName?: string }).toolName ?? "history"} output exceeds ${limit} tokens`,
	);
}

function textTokenEstimate(value: unknown): number {
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
	return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
}

function conservativeContextTokens(context: Context | TranscriptContext, session: AgentSession, outputReserve: number): number {
	const activeNames = new Set(session.getActiveToolNames());
	const activeToolSchemas = session
		.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }));
	const model = session.model;
	assert.ok(model);
	const modelMetadata = {
		provider: model.provider,
		id: model.id,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		input: model.input,
	};
	return (
		convertToLlm(context.messages).reduce((total, message) => total + estimateTokens(message), 0) +
		textTokenEstimate("systemPrompt" in context ? context.systemPrompt ?? "" : getCurrentSystemPrompt(context.messages)) +
		textTokenEstimate(activeToolSchemas) +
		textTokenEstimate(modelMetadata) +
		outputReserve
	);
}

function registerFixtureProvider(modelRuntime: ModelRuntime, faux: ReturnType<typeof fauxProvider>) {
	// Separate scripts for maintenance generation keep ordinary run assertions meaningful.
	const ledgerFaux = fauxProvider({ provider: faux.provider.id, models: faux.models, tokenSize: { min: 1_024, max: 1_024 } });
	const providerFor = (context: TranscriptContext) => getCurrentSystemPrompt(context.messages).startsWith("Write the cumulative changes since the main agent's checkpoint.")
		? ledgerFaux.provider : faux.provider;
	modelRuntime.registerNativeProvider({
		...faux.provider,
		stream: (model, context, options) => providerFor(context).stream(model, context, options),
		streamSimple: (model, context, options) => providerFor(context).streamSimple(model, context, options),
	});
	return ledgerFaux;
}

async function createFixture(
	persistent: boolean,
	extraExtensions: Array<(pi: ExtensionAPI) => void> = [],
	keepRecentTokens = 70,
	options: {
		contextWindow?: number;
		maxTokens?: number;
		reserveTokens?: number;
		compactionEnabled?: boolean;
		extraToolNames?: string[];
		customTools?: ToolDefinition[];
		settingsReader?: LedgerContextSettingsReader | null;
		modelInput?: ("text" | "image")[];
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-ledger-context-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const faux = fauxProvider({
		provider: "ledger-test",
		models: [
			{
				id: "ledger-test-model",
				contextWindow: options.contextWindow ?? 128_000,
				maxTokens: options.maxTokens ?? 4_096,
				input: options.modelInput ?? ["text", "image"],
			},
		],
		tokenSize: { min: 1_024, max: 1_024 },
	});
	mkdirSync(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const ledgerFaux = registerFixtureProvider(modelRuntime, faux);
	const model = faux.getModel();
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: {
				keepRecentTokens,
				...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
				...(options.compactionEnabled === undefined ? {} : { enabled: options.compactionEnabled }),
			},
		}),
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const settingsReader = options.settingsReader === null
		? undefined
		: options.settingsReader ?? ((ctx) => ({ source: "fixture SettingsManager", compaction: settingsManager.getCompactionSettings(ctx.model ?? undefined) }));
	const ledgerExtension = createLedgerContext({ settingsReader });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [ledgerExtension, ...extraExtensions],
	});
	await resourceLoader.reload();

	const sessionManager = persistent ? SessionManager.create(cwd, sessionDir) : SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		model,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
			tools: ["checkpoint", "history_read", "history_search", ...(options.extraToolNames ?? [])],
			customTools: options.customTools,
	});
	await session.bindExtensions({ mode: "print", onError: collectExtensionError });
	return { root, cwd, agentDir, faux, ledgerFaux, modelRuntime, settingsManager, session, sessionManager };
}

async function createRuntimeFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-ledger-runtime-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const faux = fauxProvider({
		provider: "ledger-runtime-test",
		models: [
			{ id: "ledger-runtime-model", contextWindow: 32_000, maxTokens: 512 },
			{ id: "ledger-runtime-small", contextWindow: 8_000, maxTokens: 256 },
		],
		tokenSize: { min: 1_024, max: 1_024 },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	registerFixtureProvider(modelRuntime, faux);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { keepRecentTokens: 16, reserveTokens: 0, enabled: false } }),
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				extensionFactories: [createLedgerContext({
					settingsReader: () => ({ source: "runtime SettingsManager", compaction: settingsManager.getCompactionSettings() }),
				})],
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			model: faux.getModel(),
			tools: ["checkpoint", "history_read", "history_search"],
			sessionStartEvent: options.sessionStartEvent,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	await runtime.session.bindExtensions({ mode: "print", onError: collectExtensionError });
	runtime.setRebindSession(async (session) => {
		await session.bindExtensions({ mode: "print", onError: collectExtensionError });
	});
	return { root, cwd, agentDir, sessionDir, faux, modelRuntime, settingsManager, runtime };
}

function latestCompaction(entries: SessionEntry[]): Extract<SessionEntry, { type: "compaction" }> {
	const entry = [...entries].reverse().find((candidate): candidate is Extract<SessionEntry, { type: "compaction" }> => candidate.type === "compaction");
	assert.ok(entry);
	return entry;
}

test("packed package installs and loads through the public pi package manager", { timeout: 20_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ledger-package-smoke-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const packDir = join(root, "packed");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(packDir, { recursive: true });
	const faux = fauxProvider({
		provider: "ledger-package-test",
		models: [{ id: "ledger-package-model", contextWindow: 32_000, maxTokens: 512 }],
		tokenSize: { min: 1_024, max: 1_024 },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	registerFixtureProvider(modelRuntime, faux);
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	let session: AgentSession | undefined;
	try {
		const packOutput = execFileSync(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", packDir],
			{ cwd: process.cwd(), encoding: "utf8" },
		).trim();
		assert.ok(packOutput.length > 0);
		const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
		assert.ok(tarball);
		execFileSync("tar", ["-xzf", join(packDir, tarball), "-C", packDir]);
		const packageDir = join(packDir, "package");
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			pi?: { extensions?: string[] };
		};
		assert.deepEqual(manifest.pi?.extensions, ["./src/ledger-context.ts"]);

		const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		await packageManager.installAndPersist(packageDir, { local: true });
		const configured = packageManager.listConfiguredPackages();
		assert.equal(configured.length, 1);
		assert.equal(configured[0].scope, "project");
		assert.equal(configured[0].filtered, false);
		assert.equal(configured[0].installedPath, packageDir);
		assert.equal(resolve(join(cwd, ".pi", configured[0].source)), packageDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const loaded = resourceLoader.getExtensions();
		assert.equal(loaded.errors.length, 0);
		assert.equal(loaded.extensions.length, 1);
		assert.equal(loaded.extensions[0].path, join(packageDir, "src", "ledger-context.ts"));

		const sessionManager = SessionManager.inMemory(cwd);
		({ session } = await createAgentSession({
			model: faux.getModel(),
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["checkpoint", "history_read", "history_search"],
		}));
		await session.bindExtensions({ mode: "print", onError: collectExtensionError });
		assert.deepEqual(new Set(session.getActiveToolNames()), new Set(["checkpoint", "history_read", "history_search"]));
		const checkpointTool = session.getAllTools().find((tool) => tool.name === "checkpoint");
		assert.ok(checkpointTool);
		const checkpointGuidance = JSON.stringify(checkpointTool.promptGuidelines);
		for (const phrase of ["important decisions", "current working state", "goal/status", "constraints and decisions", "verification evidence", "next step/wait", "recovery references", "skills (or none)", "complete baseline", "subsequent delta", "plans from facts", "redact secrets"]) {
			assert.ok(checkpointGuidance.includes(phrase), `checkpoint guidance must include ${phrase}`);
		}
		let historySearchResult: Extract<SessionEntry, { type: "message" }> | undefined;
		faux.setResponses([
			(context) => fauxAssistantMessage(
				fauxToolCall("checkpoint", { ledger: "packaged smoke ledger" }),
				{ stopReason: "toolUse" },
			),
			(context) => fauxAssistantMessage(
				fauxToolCall("history_search", { query: "packaged smoke", limit: 5, filter: { kinds: ["user_input","assistant_text"] } }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				historySearchResult = messageEntries(sessionManager.getBranch()).find(
					(entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search",
				);
				assert.ok(historySearchResult);
				const details = (historySearchResult.message as { details?: unknown }).details as { items?: Array<{ entryId?: string }> } | undefined;
				assert.ok(details?.items?.[0]?.entryId);
				return fauxAssistantMessage(
					fauxToolCall("history_read", { entryId: details.items[0].entryId, offset: 0, length: 128 }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => fauxAssistantMessage("packaged smoke complete"),
		]);
		await session.prompt("packaged smoke");
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 1);
		assert.ok(historySearchResult);
		const historyReadResult = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read",
		);
		assert.ok(historyReadResult);
		assert.match(toolResultText(historySearchResult), /packaged smoke/);
		assert.match(toolResultText(historyReadResult), /packaged smoke/);
		assert.equal(faux.getPendingResponseCount(), 0);
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime lifecycle restores forked, switched, tree, and model state", { timeout: 10_000 }, async () => {
	const fixture = await createRuntimeFixture();
	const { root, runtime, faux } = fixture;
	const previousLedgerLimit = process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
	const previousSoftReminder = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgentReminder = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	try {
		faux.setResponses([fauxAssistantMessage("main seed complete")]);
		await runtime.session.prompt("main seed request");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "main-ledger" })),
			fauxAssistantMessage("main checkpoint complete"),
		]);
		await runtime.session.prompt("main request");
		let mainManager = runtime.session.sessionManager;
		const mainFile = mainManager.getSessionFile();
		assert.ok(mainFile);
		const mainUser = messageEntries(mainManager.getBranch()).find(
			(entry) => entry.message.role === "user" && JSON.stringify(entry.message.content).includes("main request"),
		);
		assert.ok(mainUser);
		await runtime.session.compact();
		const mainCompaction = latestCompaction(mainManager.getBranch());
		assert.match(mainCompaction.summary, /main-ledger/);
		const mainManagerBeforeReload = runtime.session.sessionManager;
		const compactionsBeforeReload = mainManager.getBranch().filter((entry) => entry.type === "compaction").length;
		await runtime.session.reload();
		assert.equal(runtime.session.sessionManager, mainManagerBeforeReload);
		let reloadedMainContext: Context | undefined;
		faux.setResponses([
			(context) => {
				reloadedMainContext = context;
				return fauxAssistantMessage("main reload complete");
			},
		]);
		await runtime.session.prompt("verify main after reload");
		assert.ok(reloadedMainContext);
		assert.match(JSON.stringify(reloadedMainContext.messages), /main-ledger/);
		assert.equal(mainManager.getBranch().filter((entry) => entry.type === "compaction").length, compactionsBeforeReload);

		const forked = await runtime.fork(mainUser.id, { position: "at" });
		assert.equal(forked.cancelled, false);
		const forkFile = runtime.session.sessionManager.getSessionFile();
		assert.ok(forkFile);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "fork-ledger" })),
			fauxAssistantMessage("fork checkpoint complete"),
		]);
		await runtime.session.prompt("fork request");
		await runtime.session.compact();
		const forkCompaction = latestCompaction(runtime.session.sessionManager.getBranch());
		assert.match(forkCompaction.summary, /fork-ledger/);
		assert.notEqual(forkCompaction.details, mainCompaction.details);

		await runtime.switchSession(mainFile);
		assert.equal(runtime.session.sessionManager.getSessionFile(), mainFile);
		mainManager = runtime.session.sessionManager;
		let resumedMainContext: Context | undefined;
		faux.setResponses([
			(context) => {
				resumedMainContext = context;
				return fauxAssistantMessage("main resume complete");
			},
		]);
		await runtime.session.prompt("verify main after resume");
		assert.ok(resumedMainContext);
		assert.match(JSON.stringify(resumedMainContext.messages), /main-ledger/);
		assert.doesNotMatch(JSON.stringify(resumedMainContext.messages), /fork-ledger/);

		process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "7000";
		const largeModelLedger = `large-model-budget-ledger:${"l".repeat(24_000)}`;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: largeModelLedger })),
			fauxAssistantMessage("large model budget checkpoint complete"),
		]);
		await runtime.session.prompt("save the large model budget ledger");
		await runtime.session.compact();
		const largeModelCompaction = latestCompaction(mainManager.getBranch());
		assert.match(largeModelCompaction.summary, /large-model-budget-ledger/);

		const smallModel = faux.getModel("ledger-runtime-small");
		assert.ok(smallModel);
		await runtime.session.setModel(smallModel);
		assert.equal(runtime.session.model?.id, "ledger-runtime-small");
		process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "8000";
		process.env.LEDGER_CONTEXT_URGENT_TOKENS = "7999";
		let capacityProviderCalled = false;
		let capacityProviderAborted = false;
		faux.setResponses([
			(_context, options) => {
				capacityProviderCalled = true;
				capacityProviderAborted = options?.signal?.aborted ?? false;
				return fauxAssistantMessage("unused small model capacity response");
			},
		]);
		const callsBeforeCapacity = faux.state.callCount;
		await runtime.session.prompt("trigger conservative small model capacity");
		assert.equal(faux.state.callCount, callsBeforeCapacity);
		assert.equal(capacityProviderCalled ? capacityProviderAborted : true, true);
		await runtime.session.navigateTree(mainCompaction.id, { summarize: false });
		let smallModelContext: Context | undefined;
		faux.setResponses([
			(context) => {
				smallModelContext = context;
				return fauxAssistantMessage("small model complete");
			},
		]);
		await runtime.session.prompt("verify small model budget");
		assert.ok(smallModelContext);
		assert.match(JSON.stringify(smallModelContext.messages), /main-ledger/);
		assert.ok(
			smallModelContext.messages.reduce((total, message) => total + estimateTokens(message as never), 0) <= smallModel.contextWindow,
		);
		const settledReminders = () =>
			mainManager.getBranch().filter(
				(entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
			);
		const initialReminderCount = settledReminders().length;
		assert.ok(initialReminderCount >= 1);
		assert.equal(new Set(settledReminders().map((entry) => ((entry as Extract<SessionEntry, { type: "custom_message" }>).details as { reminderKey: string }).reminderKey)).size, initialReminderCount);
		const initialBudgetKeys = new Set(settledReminders().flatMap((entry) =>
			((entry as Extract<SessionEntry, { type: "custom_message" }>).details as { reasonKeys?: string[] }).reasonKeys ?? [],
		).filter((key) => key.includes(":budget:")));
		faux.setResponses([fauxAssistantMessage("small model reminder deduplicated")]);
		await runtime.session.prompt("verify settled reminder deduplication");
		const afterBudgetKeys = settledReminders().flatMap((entry) =>
			((entry as Extract<SessionEntry, { type: "custom_message" }>).details as { reasonKeys?: string[] }).reasonKeys ?? [],
		).filter((key) => key.includes(":budget:"));
		assert.deepEqual(new Set(afterBudgetKeys), initialBudgetKeys);
		if (previousLedgerLimit === undefined) delete process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
		else process.env.LEDGER_CONTEXT_LEDGER_TOKENS = previousLedgerLimit;
		if (previousSoftReminder === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoftReminder;
		if (previousUrgentReminder === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgentReminder;

		await runtime.session.navigateTree(mainUser.id, { summarize: false });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "tree-ledger" })),
			fauxAssistantMessage("tree checkpoint complete"),
		]);
		await runtime.session.prompt("tree request");
		await runtime.session.compact();
		const treeCompaction = latestCompaction(runtime.session.sessionManager.getBranch());
		assert.match(treeCompaction.summary, /tree-ledger/);

		await runtime.session.navigateTree(mainCompaction.id, { summarize: false });
		let treeMainContext: Context | undefined;
		faux.setResponses([
			(context) => {
				treeMainContext = context;
				return fauxAssistantMessage("tree returned to main");
			},
		]);
		await runtime.session.prompt("verify main tree state");
		assert.ok(treeMainContext);
		assert.match(JSON.stringify(treeMainContext.messages), /main-ledger/);

		await runtime.session.navigateTree(treeCompaction.id, { summarize: false });
		let treeContext: Context | undefined;
		faux.setResponses([
			(context) => {
				treeContext = context;
				return fauxAssistantMessage("tree state restored");
			},
		]);
		await runtime.session.prompt("verify tree ledger");
		assert.ok(treeContext);
		assert.match(JSON.stringify(treeContext.messages), /tree-ledger/);
		assert.doesNotMatch(JSON.stringify(treeContext.messages), /main-ledger/);
		assert.notEqual(forkFile, mainFile);

		const managerBeforeNewSession = runtime.session.sessionManager;
		const newSessionResult = await runtime.newSession();
		assert.equal(newSessionResult.cancelled, false);
		const newManager = runtime.session.sessionManager;
		assert.notEqual(newManager, managerBeforeNewSession);
		assert.equal(messageEntries(newManager.getBranch()).length, 0);
		let newSessionContext: Context | undefined;
		faux.setResponses([
			(context) => {
				newSessionContext = context;
				return fauxAssistantMessage("new session complete");
			},
		]);
		await runtime.session.prompt("new session request");
		assert.ok(newSessionContext);
		assert.doesNotMatch(JSON.stringify(newSessionContext.messages), /main-ledger|fork-ledger|tree-ledger/);
		const newSessionFile = newManager.getSessionFile();
		assert.ok(newSessionFile);
		const newBranchBeforeReload = newManager.getBranch().map((entry) => entry.id);
		await runtime.session.reload();
		assert.equal(runtime.session.sessionManager, newManager);
		const reloadHandoffs = newManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === "ledger-context/reminder-handoff",
		);
		assert.equal(reloadHandoffs.length, 0);
		assert.deepEqual(newManager.getBranch().map((entry) => entry.id), newBranchBeforeReload);
		await runtime.switchSession(mainFile);
		assert.equal(runtime.session.sessionManager.getSessionFile(), mainFile);
	} finally {
		if (previousLedgerLimit === undefined) delete process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
		else process.env.LEDGER_CONTEXT_LEDGER_TOKENS = previousLedgerLimit;
		if (previousSoftReminder === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoftReminder;
		if (previousUrgentReminder === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgentReminder;
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("stale and repeated compaction events do not move the active window backwards", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(true, [], 64, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		faux.setResponses([fauxAssistantMessage("first compaction prefix")]);
		await session.prompt("first compaction prefix request");
		sessionManager.appendMessage({ role: "user", content: `first compaction tail ${"a".repeat(3_000)}`, timestamp: Date.now() });
		await session.compact();
		const firstCompaction = latestCompaction(sessionManager.getBranch());

		sessionManager.appendMessage({ role: "user", content: `second compaction request ${"b".repeat(1_000)}`, timestamp: Date.now() });
		sessionManager.appendMessage(fauxAssistantMessage("second compaction result"));
		await session.compact();
		const secondCompaction = latestCompaction(sessionManager.getBranch());
		assert.notEqual(firstCompaction.id, secondCompaction.id);

		await session.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: firstCompaction,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});
		await session.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: secondCompaction,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});
		await session.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: secondCompaction,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "window remains second" })),
			fauxAssistantMessage("window verification complete"),
		]);
		await session.prompt("verify the active window after event replay");
		const receipt = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint")
			.at(-1);
		assert.ok(receipt);
		assert.equal((receipt.message as { details: { windowId: string } }).details.windowId, (secondCompaction.details as { windowId: string }).windowId);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function largeResultExtension(result: string): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: "large_result",
			label: "Large result",
			description: "Returns a large result for native compaction coverage.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => ({ content: [{ type: "text", text: result }], details: {} }),
		});
	};
}

async function reopenFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
	const sessionFile = fixture.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	const resourceLoader = new DefaultResourceLoader({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		settingsManager: fixture.settingsManager,
		noExtensions: true,
		extensionFactories: [createLedgerContext({
			settingsReader: () => ({ source: "reopen SettingsManager", compaction: fixture.settingsManager.getCompactionSettings() }),
		})],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.open(sessionFile);
	const { session } = await createAgentSession({
		model: fixture.faux.getModel(),
		modelRuntime: fixture.modelRuntime,
		settingsManager: fixture.settingsManager,
		sessionManager,
		resourceLoader,
		tools: ["checkpoint", "history_read", "history_search"],
	});
	await session.bindExtensions({ mode: "print", onError: collectExtensionError });
	return { session, sessionManager };
}

test("checkpoint and manual compaction use the public SDK seam", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager, settingsManager } = await createFixture(true);
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("checkpoint", {
					ledger: "Goal: preserve the task across compaction.\nNext: verify the restored request.",
				}),
			),
			fauxAssistantMessage("checkpoint saved"),
		]);
		await session.prompt("Continue the ledger integration task");

		const checkpoint = sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "ledger-context/checkpoint");
		assert.ok(checkpoint);
		assert.equal(checkpoint.type, "custom");
		const checkpointData = checkpoint.data as {
			activeRequestEntryIds?: string[];
			requestHistoryPosition?: { entryId: string | null };
			sourceWindowId?: string;
		};
		assert.match(JSON.stringify(checkpoint.data), /preserve the task/);
		const userEntryId = messageEntries(sessionManager.getBranch()).find((entry) => entry.message.role === "user")!.id;
		assert.ok(
			checkpointData.activeRequestEntryIds?.includes(userEntryId),
		);
		assert.equal(checkpointData.requestHistoryPosition?.entryId, userEntryId);
		const toolReceipt = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint",
		);
		assert.ok(toolReceipt);
		const toolReceiptMessage = toolReceipt.message as { content: unknown; details?: unknown };
		assert.match(JSON.stringify(toolReceiptMessage.content), /persistent session log/);
		assert.match(JSON.stringify(toolReceiptMessage.content), /active recovery baseline; pi controls compaction/);
		assert.equal((toolReceiptMessage.details as { checkpointEntryId: string }).checkpointEntryId, checkpoint.id);
		assert.equal((toolReceiptMessage.details as { windowId: string }).windowId, checkpointData.sourceWindowId);
		assert.equal(faux.state.callCount, 2);
		assert.equal(sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);

		const nativeSettings = settingsManager.getCompactionSettings();
		const lastMessage = messageEntries(sessionManager.getBranch()).at(-1)!.message;
		settingsManager.getCompactionSettings = () => ({ ...nativeSettings, keepRecentTokens: estimateTokens(toolReceipt.message as never) + estimateTokens(lastMessage as never) + 1 });
		await session.compact("keep the task request visible");
		const branch = sessionManager.getBranch();
		const compaction = branch.filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.ok(branch.some((entry) => entry.id === compaction.firstKeptEntryId));
		assert.equal((compaction.details as { schemaVersion: number; kind: string }).schemaVersion, 4);
		assert.equal((compaction.details as { schemaVersion: number; kind: string }).kind, "ledger-context");
		const provenance = compaction.details as {
			checkpointEntryId: string | null;
			previousCheckpointEntryId: string | null;
			snapshotPosition: { entryId: string | null; branchDepth: number };
			lastUserEntryId: string | null;
			lastAssistantEntryId: string | null;
		};
		const lastAssistant = messageEntries(branch).filter((entry) => entry.message.role === "assistant").at(-1);
		assert.ok(lastAssistant);
		assert.equal(provenance.checkpointEntryId, checkpoint.id);
		assert.equal(provenance.previousCheckpointEntryId, null);
		assert.equal(provenance.snapshotPosition.entryId, lastAssistant.id);
		assert.equal(provenance.lastUserEntryId, userEntryId);
		assert.equal(provenance.lastAssistantEntryId, lastAssistant.id);
		assert.match(compaction.summary, /preserve the task across compaction/);
		assert.match(compaction.summary, /previousCheckpointEntryId: \(none\)/);
		assert.match(compaction.summary, new RegExp(`"requestHistoryPosition":\\{"entryId":"${userEntryId}"`));
		assert.match(compaction.summary, /Continue the ledger integration task/);
		const pending = JSON.parse(compaction.summary.match(/^eventsAfterDeltaInput: (.+)$/m)![1]);
		assert.equal(pending.fromEntryId, messageEntries(branch).find((entry) => entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall"))!.id);
		assert.equal(pending.toEntryId, lastAssistant.id);
		assert.equal(faux.state.callCount, 2, "manual compaction must not call the working agent");
		assert.match(readFileSync(sessionManager.getSessionFile()!, "utf8"), /ledger-context\/checkpoint/);
		const assistantEntry = messageEntries(sessionManager.getBranch()).find((entry) => entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall"));
		assert.ok(assistantEntry);
		const toolCallId = ((assistantEntry.message as { content: unknown }).content as Array<{ type?: string; id?: string }>).find(
			(block) => block.type === "toolCall",
		)?.id;
		assert.ok(toolCallId);

		let resumedRequest = "";
		let resumedContext: Context | undefined;
		faux.appendResponses([
			(context) => {
				resumedContext = context;
				resumedRequest = JSON.stringify(context);
				return fauxAssistantMessage("resumed");
			},
		]);
		await session.prompt("Resume after compaction");
		assert.equal(faux.state.callCount, 3, "the two work requests plus the resumed request must be the only provider calls");
		assert.match(resumedRequest, /# Ledger Context Recovery/);
		assert.match(resumedRequest, /windowId: window:/);
		assert.match(resumedRequest, /Continue the ledger integration task/);
		assert.match(resumedRequest, /preserve the task across compaction/);
		assert.ok(resumedContext);
		const providerMessages = resumedContext.messages;
		const actualToolCallIndex = providerMessages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
		assert.ok(actualToolCallIndex >= 0, "the resumed provider context must contain the original assistant tool call");
		const actualToolResultIndex = providerMessages.findIndex(
			(message, index) => index > actualToolCallIndex && message.role === "toolResult" && message.toolCallId === toolCallId,
		);
		assert.ok(actualToolResultIndex > actualToolCallIndex, "the matching tool result must follow the assistant tool call");
		for (let index = 0; index < providerMessages.length; index++) {
			const message = providerMessages[index];
			if (message.role !== "toolResult") continue;
			const hasPriorCall = providerMessages.slice(0, index).some(
				(prior) =>
					prior.role === "assistant" &&
					prior.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId),
			);
			assert.ok(hasPriorCall, `tool result ${message.toolCallId} must have a prior assistant tool call`);
		}
		assert.match(resumedRequest, /Resume after compaction/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recovery provenance preserves prior checkpoint and direct recovery IDs", { timeout: TEST_TIMEOUT_MS }, async () => {
	const fixture = await createFixture(true);
	const { root, faux, session, sessionManager } = fixture;
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "provenance-first-ledger" })),
			fauxAssistantMessage("provenance first answer"),
		]);
		await session.prompt("provenance first user request");
		const firstCheckpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		const firstUser = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "user" && JSON.stringify(entry.message.content).includes("provenance first user request"),
		);
		assert.ok(firstCheckpoint);
		assert.ok(firstUser);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "provenance-second-ledger" })),
			fauxAssistantMessage("provenance second answer"),
		]);
		await session.prompt("provenance second user request");
		const secondCheckpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		const secondUser = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "user" && JSON.stringify(entry.message.content).includes("provenance second user request"),
		);
		const secondAnswer = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes("provenance second answer"),
		);
		assert.ok(secondCheckpoint);
		assert.ok(secondUser);
		assert.ok(secondAnswer);
		for (const stopReason of ["length", "error", "aborted"] as const) {
			sessionManager.appendMessage(fauxAssistantMessage(`provenance partial ${stopReason}`, { stopReason }));
		}
		sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("ordinary_tool", { value: "provenance tool request" }), { stopReason: "toolUse" }));

		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		const details = compaction.details as {
			checkpointEntryId: string | null;
			previousCheckpointEntryId: string | null;
			snapshotPosition: { entryId: string | null; branchDepth: number };
			lastUserEntryId: string | null;
			lastAssistantEntryId: string | null;
		};
		assert.equal(details.checkpointEntryId, secondCheckpoint.id);
		assert.equal(details.previousCheckpointEntryId, firstCheckpoint.id);
		assert.ok(details.snapshotPosition.branchDepth > (secondCheckpoint.data as { requestHistoryPosition: { branchDepth: number } }).requestHistoryPosition.branchDepth);
		assert.equal(details.lastUserEntryId, secondUser.id);
		assert.equal(details.lastAssistantEntryId, secondAnswer.id);
		assert.match(compaction.summary, new RegExp(`previousCheckpointEntryId: ${firstCheckpoint.id}`));
		assert.match(compaction.summary, new RegExp(`lastUserEntryId: ${secondUser.id}`));
		assert.match(compaction.summary, new RegExp(`lastAssistantEntryId: ${secondAnswer.id}`));
		assert.match(compaction.summary, /Read known entry IDs with history_read first/);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: firstCheckpoint.id, offset: 0, length: 256 })),
			fauxAssistantMessage("previous checkpoint read"),
		]);
		await session.prompt("read prior checkpoint from provenance");
		const previousRead = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(previousRead);
		assert.equal((previousRead.message as { details: { entryId: string } }).details.entryId, firstCheckpoint.id);
		assert.match(JSON.stringify((previousRead.message as { content: unknown }).content), /provenance-first-ledger/);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: "provenance partial", limit: 10, filter: { includeMaintenance: true } })),
			fauxAssistantMessage("partial provenance search complete"),
		]);
		await session.prompt("check partial provenance statuses");
		const partialSearch = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(partialSearch);
		const partialHits = (partialSearch.message as { details: { items: Array<{ executionStatus: string }> } }).details.items;
		assert.equal(partialHits.length, 3);
		assert.ok(partialHits.every((hit) => hit.executionStatus === "failed"));

		const reopened = await reopenFixture(fixture);
		try {
			let resumedContext: Context | undefined;
			faux.setResponses([(context) => {
				resumedContext = context;
				return fauxAssistantMessage("reopened provenance");
			}]);
			await reopened.session.prompt("resume provenance after reload");
			assert.ok(resumedContext);
			const providerText = JSON.stringify(resumedContext.messages);
			assert.match(providerText, new RegExp(`previousCheckpointEntryId: ${firstCheckpoint.id}`));
			assert.match(providerText, new RegExp(`lastAssistantEntryId: ${secondAnswer.id}`));
		} finally {
			reopened.session.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("native threshold compacts before the next request in the same run", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	use4kRecoveryBudgets(t);
	const toolResults = {
		first: `first-large-tool-result:${"x".repeat(3_400)}`,
		second: `second-large-tool-result:${"x".repeat(3_400)}`,
	};
	const order: string[] = [];
	const observeCompactionExtension = (pi: ExtensionAPI): void => {
		for (const [name, text] of Object.entries({ large_result_first: toolResults.first, large_result_second: toolResults.second })) {
			pi.registerTool({
				name,
				label: name,
				description: "Returns a large result for native threshold coverage.",
				parameters: Type.Object({}),
				executionMode: "parallel",
				execute: async () => ({ content: [{ type: "text", text }], details: {} }),
			});
		}
		pi.on("session_before_compact", (event) => {
			order.push(event.reason);
		});
	};
	const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [observeCompactionExtension], 1_750, {
		contextWindow: 6_000,
		maxTokens: 100,
		reserveTokens: 2_500,
		extraToolNames: ["large_result_first", "large_result_second"],
	});
	try {
		let resumedContext: Context | undefined;
		const toolCallIds = ["same-run-large-tool-first", "same-run-large-tool-second"];
		ledgerFaux.setResponses([
			fauxAssistantMessage("native-generated-ledger: Large operations returned; verify evidence before repeating. Skills: none."),
			(context) => {
				assert.match(JSON.stringify(context.messages), /Previous cumulative delta.*native-generated-ledger/);
				return fauxAssistantMessage("native-refreshed-ledger: Same-run work completed. Skills: none.");
			},
		]);
		faux.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(
				[
					fauxToolCall("large_result_first", {}, { id: toolCallIds[0] }),
					fauxToolCall("large_result_second", {}, { id: toolCallIds[1] }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				order.push("provider");
				resumedContext = context;
				return fauxAssistantMessage("same-run complete");
			},
		]);
		let agentStarts = 0;
		session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts++;
		});
		await session.prompt("seed old history");
		await session.prompt("seed recent history");
		await session.prompt("run the large tool in one native run");

		assert.equal(order[0], "threshold");
		assert.equal(order[1], "provider");
		assert.equal(agentStarts, 3, "native compaction must stay within the same agent run");
		assert.equal(faux.state.callCount, 4, "native compaction must resume without an extra agent run");
		assert.ok(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length >= 1);
		assert.ok(resumedContext);
		const messages = resumedContext.messages;
		const assistantIndex = messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				toolCallIds.every((id) => message.content.some((block) => block.type === "toolCall" && block.id === id)),
		);
		assert.ok(assistantIndex >= 0, "resumed provider context must contain both assistant tool calls");
		for (const toolCallId of toolCallIds) {
			const resultIndex = messages.findIndex(
				(message, index) => index > assistantIndex && message.role === "toolResult" && message.toolCallId === toolCallId,
			);
			assert.ok(resultIndex > assistantIndex, `the matching tool result must follow ${toolCallId}`);
		}
		assert.match(JSON.stringify(messages), /first-large-tool-result/);
		assert.match(JSON.stringify(messages), /second-large-tool-result/);
		assert.match(JSON.stringify(messages), /# Ledger Context Recovery/);
		assert.match(JSON.stringify(messages), /native-generated-ledger/);
		assert.equal(ledgerFaux.state.callCount, sessionManager.getBranch().filter((entry) => entry.type === "compaction").length);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
		assert.match(latestCompaction(sessionManager.getBranch()).summary, /native-refreshed-ledger/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("long native run recovers twenty windows and reads its earliest operation", { timeout: 60_000 }, async (t) => {
	use4kRecoveryBudgets(t);
	const previousOutputReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "256";
	const operationIds = Array.from({ length: 40 }, (_value, index) => `long-operation-${String(index + 1).padStart(2, "0")}`);
	const executedOperations = new Map<string, number>();
	const operationTool: ToolDefinition = {
		name: "long_operation",
		label: "Long operation",
		description: "Execute one planned long-run operation exactly once and return its durable operation ID.",
		promptSnippet: "execute one planned long-run operation",
		promptGuidelines: ["Preserve each operation ID and verify the returned result before continuing."],
		parameters: Type.Object({ operationId: Type.String({ minLength: 1 }) }),
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const operationId = (params as { operationId: string }).operationId;
			const count = (executedOperations.get(operationId) ?? 0) + 1;
			executedOperations.set(operationId, count);
			return {
				content: [{ type: "text", text: `long-operation-result:${operationId}:${"x".repeat(3_400)}` }],
				details: { operationId, count },
			};
		},
	};
	const fixture = await createFixture(true, [], 1_750, {
		contextWindow: 6_000,
		maxTokens: 128,
		reserveTokens: 2_500,
		compactionEnabled: true,
		extraToolNames: ["long_operation"],
		customTools: [operationTool],
	});
	const { root, faux, session, sessionManager } = fixture;
	const providerContexts: Context[] = [];
	const compactionReasons: string[] = [];
	let agentStarts = 0;
	let firstCompactionResolve = () => {};
	const firstCompactionStarted = new Promise<void>((resolve) => {
		firstCompactionResolve = resolve;
	});
	let firstCompactionObserved = false;
	let steeringPromise: Promise<void> | undefined;
	let historySearchContext: Context | undefined;
	let historyReadContext: Context | undefined;
	let finalContext: Context | undefined;
	let extraContext: Context | undefined;
	const budgetViolations: string[] = [];
	let maxRequestBudget = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_start") agentStarts++;
		if (event.type === "compaction_start") {
			compactionReasons.push(`${event.reason}:${executedOperations.size}`);
			if (!firstCompactionObserved) {
				firstCompactionObserved = true;
				steeringPromise = session.steer("long-run user correction");
				firstCompactionResolve();
			}
		}
	});
	const wrapResponse = (response: (context: Context) => ReturnType<typeof fauxAssistantMessage>): ((context: Context) => ReturnType<typeof fauxAssistantMessage>) => {
		return (context) => {
			providerContexts.push(context);
			const budget = conservativeContextTokens(context, session, 256);
			const model = session.model;
			assert.ok(model);
			maxRequestBudget = Math.max(maxRequestBudget, budget);
			if (budget > model.contextWindow) budgetViolations.push(`${budget}/${model.contextWindow}`);
			return response(context);
		};
	};
	try {
		const responses: Array<(context: Context) => ReturnType<typeof fauxAssistantMessage>> = [
			wrapResponse(() => fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "long-run ledger: execute and verify every planned operation" }), { stopReason: "toolUse" })),
			...Array.from({ length: operationIds.length / 2 }, (_value, index) =>
				wrapResponse(() =>
					fauxAssistantMessage(
						[
							fauxToolCall("long_operation", { operationId: operationIds[index * 2] }, { id: `call-${operationIds[index * 2]}` }),
							fauxToolCall("long_operation", { operationId: operationIds[index * 2 + 1] }, { id: `call-${operationIds[index * 2 + 1]}` }),
						],
						{ stopReason: "toolUse" },
					),
				),
			),
			wrapResponse(() => fauxAssistantMessage(fauxToolCall("history_search", { query: "long-operation-result:long-operation-01", limit: 5, filter: { kinds: ["tool_call","tool_result"] } }), { stopReason: "toolUse" })),
			wrapResponse((context) => {
				historySearchContext = context;
				const searchResult = sessionManager.getBranch().find(
					(entry): entry is Extract<SessionEntry, { type: "message" }> =>
						entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "history_search",
				);
				assert.ok(searchResult);
				const searchDetails = (searchResult.message as { details?: unknown }).details as { items?: Array<{ entryId?: string; snippet?: string }> } | undefined;
				const hit = searchDetails?.items?.find((candidate) => candidate.snippet?.includes("long-operation-result:long-operation-01"));
				assert.ok(hit?.entryId);
				return fauxAssistantMessage(
					fauxToolCall("history_read", { entryId: hit.entryId, offset: 0, length: 512 }, { id: "long-history-read" }),
					{ stopReason: "toolUse" },
				);
			}),
			wrapResponse((context) => {
				historyReadContext = context;
				finalContext = context;
				return fauxAssistantMessage("long-run history recovery complete");
			}),
			wrapResponse((context) => {
				extraContext = context;
				return fauxAssistantMessage("long-run reminder acknowledgement");
			}),
		];
		faux.setResponses(responses);
		const runPromise = session.prompt("run the 40 operation ledger recovery task");
		await firstCompactionStarted;
		await steeringPromise;
		await runPromise;

		assert.equal(agentStarts, 1);
		assert.ok(compactionReasons.length >= 20, `expected at least 20 native compactions, got ${compactionReasons.length}`);
		assert.ok(compactionReasons.every((reason) => reason.startsWith("threshold:") || reason.startsWith("overflow:")));
		assert.equal(executedOperations.size, operationIds.length);
		assert.ok([...executedOperations.values()].every((count) => count === 1));
		// 1 checkpoint + 20 operation batches + history search/read + final response + one queued reminder turn.
		assert.equal(faux.state.callCount, operationIds.length / 2 + 5);
		assert.equal(providerContexts.length, faux.state.callCount);
		assert.deepEqual(budgetViolations, []);
		assert.ok(maxRequestBudget > 0);
		assert.ok(extraContext);
		assert.ok(providerContexts.some((context) => /Ledger Context urgent budget reminder/.test(JSON.stringify(context.messages))), "urgent reminder must reach a provider request before later compactions can replace it with a reference");
		assert.equal(faux.getPendingResponseCount(), 0);
		assert.equal(session.getLastAssistantText(), "long-run reminder acknowledgement");
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, compactionReasons.length);
		const compactions = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction",
		);
		assert.ok(compactions.length >= 20);
		assert.ok(compactions.every((entry) => entry.fromHook === true && (entry.details as { kind?: string }).kind === "ledger-context"));
		assert.equal(new Set(compactions.map((entry) => (entry.details as { windowId: string }).windowId)).size, compactions.length);
		const correctionEntries = messageEntries(sessionManager.getBranch()).filter(
			(entry) => entry.message.role === "user" && JSON.stringify(entry.message).includes("long-run user correction"),
		);
		assert.equal(correctionEntries.length, 1);
		const hasDirectCorrection = (message: Context["messages"][number]): boolean =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "text" && block.text.startsWith("long-run user correction"));
		const correctionContexts = providerContexts.filter((context) => context.messages.some(hasDirectCorrection));
		assert.ok(correctionContexts.length >= 1);
		const correctionContext = correctionContexts[0];
		assert.equal(correctionContext.messages.filter(hasDirectCorrection).length, 1);
		const correctionIndex = correctionContext.messages.findIndex(hasDirectCorrection);
		const correctionToolResultIndex = correctionContext.messages.findIndex(
			(message, index) => index < correctionIndex && message.role === "toolResult",
		);
		assert.ok(correctionToolResultIndex >= 0);
		assert.ok(correctionIndex > correctionToolResultIndex);
		const historySearch = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search",
		);
		assert.ok(historySearch);
		assert.match(toolResultText(historySearch), /long-operation-result:long-operation-01/);
		const historyRead = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read",
		);
		assert.ok(historyRead);
		assert.match(toolResultText(historyRead), /long-operation-result:long-operation-01/);
		assert.ok(historySearchContext);
		assert.ok(historyReadContext);
		assert.ok(finalContext);
		assert.match(JSON.stringify(finalContext.messages), /run the 40 operation ledger recovery task/);
		assert.match(JSON.stringify(finalContext.messages), /long-run ledger: execute and verify every planned operation/);
		assert.match(JSON.stringify(finalContext.messages), /long-operation-result:long-operation-01/);
		for (const context of providerContexts) {
			for (let index = 0; index < context.messages.length; index++) {
				const message = context.messages[index];
				if (message.role === "toolResult") {
					const hasPriorCall = context.messages.slice(0, index).some(
						(prior) =>
							prior.role === "assistant" &&
							prior.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId),
					);
					assert.ok(hasPriorCall, `tool result ${message.toolCallId} lacks its prior assistant call`);
				}
				if (message.role !== "assistant") continue;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const resultIndex = context.messages.findIndex(
						(candidate, candidateIndex) =>
							candidateIndex > index &&
							candidate.role === "toolResult" &&
							candidate.toolCallId === block.id &&
							candidate.toolName === block.name,
					);
					assert.ok(resultIndex > index, `assistant tool call ${block.id} lacks its later matching result`);
				}
			}
		}
		assert.equal(session.isStreaming, false);
	} finally {
		unsubscribe();
		rmSync(root, { recursive: true, force: true });
		if (previousOutputReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousOutputReserve;
	}
});

test("tool-batch reminders reach the next same-run provider request", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "7000";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "6000";
	const noopExtension = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "noop",
			label: "Noop",
			description: "Returns a small result so the run can continue.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => ({ content: [{ type: "text", text: "noop-result" }], details: {} }),
		});
	};
	const { root, faux, session } = await createFixture(false, [noopExtension], 2_000, {
		contextWindow: 8_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
		extraToolNames: ["noop"],
	});
	try {
		let resumedContext: Context | undefined;
		const toolCallId = "same-run-reminder-noop";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}, { id: toolCallId }), { stopReason: "toolUse" }),
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("same-run reminder received");
			},
		]);
		let agentStarts = 0;
		session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts++;
		});
		await session.prompt("run the noop tool and continue");

		assert.equal(agentStarts, 1);
		assert.equal(faux.state.callCount, 2);
		assert.ok(resumedContext);
		const messages = resumedContext.messages;
		const assistantIndex = messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
		const resultIndex = messages.findIndex(
			(message, index) => index > assistantIndex && message.role === "toolResult" && message.toolCallId === toolCallId,
		);
		const reminderIndex = messages.findIndex(
			(message, index) =>
				index > resultIndex &&
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "text" && block.text.includes("Ledger Context")),
		);
		assert.ok(assistantIndex >= 0);
		assert.ok(resultIndex > assistantIndex);
		assert.ok(reminderIndex > resultIndex, "the reminder must follow the complete tool batch");
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("budget reminders are bounded, deduplicated per window, and explicit about unknown usage", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	use4kRecoveryBudgets(t);
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "6500";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "3000";
	const fixture = await createFixture(true, [], 2_000, {
		contextWindow: 10_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	const { root, faux, session, sessionManager } = fixture;
	try {
		const providerContexts: Context[] = [];
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("first reminder checkpoint");
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("second reminder checkpoint");
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("third reminder checkpoint");
			},
		]);
		await session.prompt("small first turn");
		await session.prompt("medium second turn " + "m".repeat(2_000));
		await session.prompt("large third turn " + "l".repeat(8_000));
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("urgent reminder delivered");
			},
		]);
		await session.prompt("deliver the urgent reminder");
		assert.ok(providerContexts.some((context) => /Ledger Context soft budget reminder/.test(JSON.stringify(context.messages))));
		assert.ok(providerContexts.some((context) => /Ledger Context urgent budget reminder/.test(JSON.stringify(context.messages))));

		const reminders = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === "ledger-context/reminder",
		);
		assert.ok(reminders.length >= 2);
		const budgetReminders = reminders.filter((entry) => (entry.details as { reasonKinds?: string[] }).reasonKinds?.includes("budget"));
		assert.ok(budgetReminders.some((entry) => (entry.details as { level: string }).level === "soft"));
		assert.ok(budgetReminders.some((entry) => (entry.details as { level: string }).level === "urgent"));
		const budgetKeys = budgetReminders.flatMap((entry) => (entry.details as { reasonKeys?: string[] }).reasonKeys ?? []).filter((key) => key.includes(":budget:"));
		assert.equal(new Set(budgetKeys).size, 2);
		assert.equal(new Set(reminders.map((entry) => (entry.details as { windowId: string }).windowId)).size, 1);
		assert.ok(reminders.every((entry) => typeof entry.content === "string" && textTokenEstimate(entry.content) <= 256));

		await session.compact();
		const firstWindowId = (reminders[0].details as { windowId: string }).windowId;
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("provider usage is unavailable", { stopReason: "error" });
			},
		]);
		await session.prompt("unknown usage after compaction " + "u".repeat(8_000));
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("deliver the new window reminder");
			},
		]);
		await session.prompt("deliver the new window reminder");
		assert.match(JSON.stringify(providerContexts.at(-1)?.messages), /Ledger Context urgent budget reminder/);

		const afterCompaction = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === "ledger-context/reminder",
		);
		assert.ok(afterCompaction.length >= 3);
		const currentCompaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		const currentWindowId = currentCompaction?.type === "compaction" ? (currentCompaction.details as { windowId?: string }).windowId : undefined;
		const latest = afterCompaction.find((entry) => {
			const details = entry.details as { level?: string; windowId?: string; usageKnown?: boolean; reasonKinds?: string[] };
			return details.level === "urgent" && details.usageKnown === false && details.reasonKinds?.includes("budget") &&
				(currentWindowId === undefined || details.windowId === currentWindowId);
		});
		assert.ok(latest);
		const latestDetails = latest.details as { level: string; windowId: string; usageKnown: boolean; reasonKinds?: string[] };
		assert.equal(latestDetails.level, "urgent");
		assert.equal(latestDetails.usageKnown, false);
		assert.ok(latestDetails.reasonKinds?.includes("budget"));
		assert.equal(latestDetails.windowId === firstWindowId, false);
		assert.match(String(latest.content), /bounded content estimate/);

		const reopened = await reopenFixture(fixture);
		try {
			const reopenContexts: Context[] = [];
			const readCallId = "reopen-reminder-history-read";
			faux.setResponses([
				(context) => {
					reopenContexts.push(context);
					return fauxAssistantMessage(
						fauxToolCall("history_read", { entryId: latest.id, offset: 0, length: 1 }, { id: readCallId }),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					reopenContexts.push(context);
					return fauxAssistantMessage("reopened window remains deduplicated");
				},
			]);
			await reopened.session.prompt("check the restored reminder state with a tool turn");
			const remindersAfterReopen = reopened.sessionManager.getBranch().filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
			);
			const persistedReasonKeys = remindersAfterReopen.flatMap((entry) => (entry.details as { reasonKeys?: string[] }).reasonKeys ?? []);
			assert.equal(new Set(persistedReasonKeys).size, persistedReasonKeys.length);
			const persistedBudgetKeys = persistedReasonKeys.filter((key) => key.includes(":budget:"));
			assert.equal(new Set(persistedBudgetKeys).size, persistedBudgetKeys.length);
			assert.equal(reopenContexts.length, 2);
			const currentWindowReminderMessages = reopenContexts.flatMap((context) => context.messages).filter(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(
						(block) =>
							block.type === "text" &&
							(block.text.includes(`window: ${latestDetails.windowId}`) || block.text.includes(`pi://entry/${latest.id}`)),
					),
			);
			assert.ok(currentWindowReminderMessages.length >= 1);
		} finally {
			reopened.session.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("saturated unknown usage still persists a settled urgent reminder", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	use4kRecoveryBudgets(t);
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "3000";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "1000";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 2_000, {
		contextWindow: 8_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		faux.setResponses([fauxAssistantMessage("committed reminder seed")]);
		await session.prompt("seed the committed reminder window");
		sessionManager.appendMessage({ role: "user", content: `committed reminder history ${"h".repeat(8_000)}`, timestamp: Date.now() });
		await session.compact();
		const committedWindowCount = sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
		assert.equal(committedWindowCount, 1);
		let unknownContext: Context | undefined;
		faux.setResponses([(context) => {
			unknownContext = context;
			return fauxAssistantMessage("unknown usage response", { stopReason: "error" });
		}]);
		await session.prompt("saturate unknown usage " + "u".repeat(100_000));
		faux.setResponses([fauxAssistantMessage("deliver the saturated unknown reminder")]);
		await session.prompt("deliver the saturated unknown reminder");
		const reminders = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.ok(reminders.length >= 1);
		const details = reminders.at(-1)!.details as {
			level: string;
			estimatedTokens: number;
			remainingTokens: number;
			contextWindow: number;
			effectiveBoundaryRemaining: number;
			usageKnown: boolean;
		};
		assert.ok(reminders.some((entry) => (entry.details as { level: string; usageKnown: boolean }).level === "urgent" && (entry.details as { usageKnown: boolean }).usageKnown === false));
		assert.ok(unknownContext);
		assert.equal(details.estimatedTokens, conservativeContextTokens(unknownContext, session, 0));
		assert.equal(details.remainingTokens, details.contextWindow - details.estimatedTokens);
		assert.equal(details.effectiveBoundaryRemaining, 0);
		assert.equal(details.usageKnown, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("malformed persisted reminder details do not suppress a valid level", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	use4kRecoveryBudgets(t);
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "6500";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "3000";
	const fixture = await createFixture(true, [], 2_000, {
		contextWindow: 8_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		const { faux, session, sessionManager } = fixture;
		faux.setResponses([fauxAssistantMessage("soft reminder queued")]);
		await session.prompt("record a soft reminder");
		faux.setResponses([fauxAssistantMessage("soft reminder delivered")]);
		await session.prompt("deliver the soft reminder");
		const windowId = `window:${sessionManager.getSessionId()}:initial`;
		sessionManager.appendCustomMessageEntry(REMINDER_MESSAGE_TYPE, "malformed reminder", false, {
			schemaVersion: 4,
			reminderKey: `${windowId}:urgent`,
			level: "urgent",
			windowId,
			contextWindow: "bad",
			estimatedTokens: 0,
			remainingTokens: 0,
			usageKnown: true,
		});

		const reopened = await reopenFixture(fixture);
		try {
			faux.setResponses([fauxAssistantMessage("urgent reminder queued")]);
			await reopened.session.prompt("cross the urgent reminder threshold " + "u".repeat(8_000));
			faux.setResponses([fauxAssistantMessage("urgent reminder delivered")]);
			await reopened.session.prompt("deliver the valid urgent reminder");
			const reminders = reopened.sessionManager.getBranch().filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
			);
			assert.ok(reminders.length >= 3);
			assert.equal((reminders[1].details as { contextWindow: string }).contextWindow, "bad");
			const validReminders = reminders.filter(
				(entry) => typeof (entry.details as { contextWindow?: unknown }).contextWindow === "number",
			);
			assert.ok(validReminders.length >= 2);
			const validBudgetUrgent = [...validReminders].reverse().find((entry) => {
				const details = entry.details as { level?: string; reasonKinds?: string[] };
				return details.level === "urgent" && details.reasonKinds?.includes("budget");
			});
			assert.ok(validBudgetUrgent);
		} finally {
			reopened.session.dispose();
		}
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("stale volume counts ordinary work while excluding maintenance entries", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "3000";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "1000";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 2_000, {
		contextWindow: 16_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "volume checkpoint" })),
			fauxAssistantMessage("volume checkpoint completed"),
		]);
		await session.prompt("save the volume checkpoint");
		const checkpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		assert.ok(checkpoint);
		const ordinaryCallId = "ordinary-volume-call";
		const mixedAssistantId = sessionManager.appendMessage(
			fauxAssistantMessage([
				fauxToolCall("ordinary_tool", { value: "ordinary volume" }, { id: ordinaryCallId }),
				fauxToolCall("history_read", { entryId: checkpoint.id }, { id: "maintenance-volume-call" }),
			]),
		);
		const ordinaryResultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: ordinaryCallId,
			toolName: "ordinary_tool",
			content: [{ type: "text", text: `ordinary-volume-result:${"o".repeat(7_000)}` }],
			isError: false,
			timestamp: Date.now(),
		});
		const maintenanceResultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "maintenance-volume-call",
			toolName: "history_read",
			content: [{ type: "text", text: `maintenance-result:${"m".repeat(20_000)}` }],
			isError: false,
			timestamp: Date.now(),
		});
		for (const name of ["history_list_items", "history_list_windows", "get_context_remaining"]) {
			sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall(name, {}, { id: `maintenance-${name}` })));
			sessionManager.appendMessage({ role: "toolResult", toolCallId: `maintenance-${name}`, toolName: name,
				content: [{ type: "text", text: "m".repeat(4_000) }], isError: false, timestamp: Date.now() });
		}
		sessionManager.appendCustomEntry("test/non-context-volume-metadata", { ignored: true });
		let resumedContext: Context | undefined;
		faux.setResponses([(context) => {
			resumedContext = context;
			return fauxAssistantMessage("volume boundary completed");
		}]);
		await session.prompt("cross the ordinary volume boundary");
		assert.ok(resumedContext);
		const reminders = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.equal(reminders.length, 1);
		const details = reminders[0].details as { causes?: string[]; fromEntryId?: string | null; toEntryId?: string | null; reasonKeys?: string[] };
		assert.ok(details.reasonKeys?.some((key) => key.includes("stale-volume")));
		assert.ok(details.causes?.some((cause) => cause.includes("nonmaintenance volume")));
		assert.ok(details.fromEntryId);
		const fromIndex = sessionManager.getBranch().findIndex((entry) => entry.id === details.fromEntryId);
		const mixedIndex = sessionManager.getBranch().findIndex((entry) => entry.id === mixedAssistantId);
		assert.ok(fromIndex >= 0 && fromIndex <= mixedIndex);
		assert.equal(details.toEntryId, ordinaryResultId);
		assert.equal(details.toEntryId === maintenanceResultId, false);
		assert.match(JSON.stringify(resumedContext.messages), /cross the ordinary volume boundary/);
		sessionManager.appendMessage({ role: "user", content: "another ordinary batch after the crossing", timestamp: Date.now() });
		faux.setResponses([fauxAssistantMessage("ordinary batch settled without another stale notice")]);
		await session.prompt("settle another ordinary batch");
		const remindersAfterSecondBatch = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		const staleReminders = remindersAfterSecondBatch.filter((entry) =>
			(entry.details as { reasonKinds?: string[] }).reasonKinds?.includes("stale-volume"),
		);
		assert.equal(staleReminders.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("volume reminders follow ten-percent marks across jumps, reload, model changes and checkpoints", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTail = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 2_000, {
		contextWindow: 20_000, maxTokens: 512, reserveTokens: 0, compactionEnabled: false,
	});
	const notices = () => sessionManager.getBranch().filter((entry) => entry.type === "custom_message" &&
		entry.customType === REMINDER_MESSAGE_TYPE &&
		(entry.details as { reasonKinds?: string[] }).reasonKinds?.includes("stale-volume"));
	const fillTo = (tokens: number) => {
		const entries = sessionManager.getBranch();
		const checkpoint = checkpointEntries(entries).at(-1)!;
		const origin = (checkpoint.data as { requestHistoryPosition: { entryId: string } }).requestHistoryPosition.entryId;
		const messages = messageEntries(entries.slice(entries.findIndex((entry) => entry.id === origin) + 1));
		let used = 0;
		for (const { message } of messages) {
			if (message.role === "user") used += estimateTokens(message);
			if (message.role === "assistant") {
				const content = message.content.filter((block) => block.type === "text");
				if (content.length > 0) used += estimateTokens({ ...message, content });
			}
		}
		assert.ok(tokens > used, `${tokens} must exceed accumulated volume ${used}`);
		const message = { role: "user" as const, content: "x".repeat((tokens - used) * 4), timestamp: Date.now() };
		assert.equal(estimateTokens(message), tokens - used);
		sessionManager.appendMessage(message);
	};
	const tick = async () => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("tick");
	};
	try {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "volume origin" })), fauxAssistantMessage("saved")]);
		await session.prompt("save origin");
		fillTo(1_990);
		await tick();
		assert.equal(notices().length, 0, "tail=64 must not lower the 2000-token interval");
		fillTo(2_000);
		await tick();
		assert.equal(notices().length, 1, "the exact ten-percent boundary triggers");
		fillTo(4_000);
		await tick();
		assert.equal(notices().length, 2, "a new interval reminds even without a checkpoint update");
		fillTo(11_000);
		await tick();
		assert.equal(notices().length, 3, "a jump across several intervals produces one notice");
		await session.reload();
		await tick();
		assert.equal(notices().length, 3, "reload preserves delivered marks");
		await session.setModel({ ...faux.getModel(), contextWindow: 40_000 });
		await tick();
		assert.equal(notices().length, 3, "a larger model does not replay lower marks");
		fillTo(12_000);
		await tick();
		assert.equal(notices().length, 4, "the current model now uses a 4000-token interval");
		process.env.LEDGER_CONTEXT_TAIL_TOKENS = "8192";
		faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "new volume origin" })), fauxAssistantMessage("saved")]);
		await session.prompt("save new origin");
		await tick();
		assert.equal(notices().length, 4);
		fillTo(4_000);
		await tick();
		assert.equal(notices().length, 5, "saving resets the origin and tail changes do not change the interval");
		const latest = notices().at(-1)!;
		assert.equal(latest.type, "custom_message");
		if (latest.type === "custom_message") assert.match(String(latest.content), /10%.*4000 tokens/);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
		if (previousTail === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTail;
	}
});

test("ordinary thinking volume includes mixed work and excludes maintenance-only thinking", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "100";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "50";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 2_000, {
		contextWindow: 16_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "thinking volume checkpoint" })),
			fauxAssistantMessage("thinking volume checkpoint complete"),
		]);
		await session.prompt("save thinking volume checkpoint");
		const mixedCallId = "thinking-mixed-ordinary-call";
		const mixedAssistantId = sessionManager.appendMessage(fauxAssistantMessage([
			fauxThinking("ordinary mixed reasoning " + "r".repeat(7_000)),
			fauxToolCall("ordinary_tool", { marker: "ordinary mixed call" }, { id: mixedCallId }),
			fauxToolCall("history_read", { entryId: "checkpoint" }, { id: "thinking-maintenance-call" }),
		]));
		const ordinaryResultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: mixedCallId,
			toolName: "ordinary_tool",
			content: [{ type: "text", text: "ordinary mixed result" }],
			isError: false,
			timestamp: Date.now(),
		});
		const maintenanceAssistantId = sessionManager.appendMessage(fauxAssistantMessage([
			fauxThinking("maintenance-only reasoning " + "m".repeat(20_000)),
			fauxToolCall("history_read", { entryId: "checkpoint" }, { id: "thinking-maintenance-only-call" }),
		]));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "thinking-maintenance-only-call",
			toolName: "history_read",
			content: [{ type: "text", text: "maintenance-only result " + "x".repeat(20_000) }],
			isError: false,
			timestamp: Date.now(),
		});
		let resumedContext: Context | undefined;
		faux.setResponses([(context) => {
			resumedContext = context;
			return fauxAssistantMessage("thinking volume boundary complete");
		}]);
		await session.prompt("deliver thinking volume reminder");
		assert.ok(resumedContext);
		const reminders = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		const staleReminder = reminders.find((entry) =>
			(entry.details as { reasonKinds?: string[] }).reasonKinds?.includes("stale-volume"),
		);
		assert.ok(staleReminder);
		const details = staleReminder.details as { fromEntryId?: string | null; toEntryId?: string | null; reasonDetails?: Array<{ fromEntryId: string | null; toEntryId: string | null }> };
		const fromIndex = sessionManager.getBranch().findIndex((entry) => entry.id === details.fromEntryId);
		const mixedIndex = sessionManager.getBranch().findIndex((entry) => entry.id === mixedAssistantId);
		assert.ok(fromIndex >= 0 && fromIndex <= mixedIndex);
		assert.equal(details.toEntryId, ordinaryResultId);
		assert.ok(details.reasonDetails?.some((reason) => reason.fromEntryId === details.fromEntryId && reason.toEntryId === ordinaryResultId));
		assert.equal(details.fromEntryId === maintenanceAssistantId, false);
		assert.match(String(staleReminder.content), /stale-volume/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("short prompts stay silent and deferred volume reminders reach the next normal request", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "4096";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "3000";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "1000";
	const extensionTool = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "extension_probe",
			label: "Extension probe",
			description: "Completes an extension-origin tool run.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => ({ content: [{ type: "text", text: "extension probe result" }], details: {} }),
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [extensionTool], 2_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
		extraToolNames: ["extension_probe"],
	});
	try {
		faux.setResponses([fauxAssistantMessage("first external run completed")]);
		await session.prompt("first external request");
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE).length, 0);
		let secondContext: Context | undefined;
		faux.setResponses([(context) => {
			secondContext = context;
			return fauxAssistantMessage("second external run completed");
		}]);
		await session.prompt("second external request");
		assert.ok(secondContext);
		const remindersAfterSecond = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.equal(remindersAfterSecond.length, 0);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("extension_probe", {}, { id: "extension-probe-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("extension initiated work completed"),
		]);
		await session.sendUserMessage("extension initiated work");
		const remindersAfterExtension = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.equal(remindersAfterExtension.length, 0);
		faux.setResponses([fauxAssistantMessage("Evidence: " + "v".repeat(13_000))]);
		await session.prompt("Produce substantial evidence.");
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE).length, 0);
		await session.reload();
		let nextContext: Context | undefined;
		faux.setResponses([(context) => { nextContext = context; return fauxAssistantMessage("continued"); }]);
		await session.prompt("Continue after the evidence.");
		assert.ok(nextContext);
		assert.match(JSON.stringify(nextContext.messages), /stale-volume/);
		const notices = sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE);
		assert.equal(notices.length, 1);
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ledger-context/external-run").length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("short runs remain below reminder thresholds across compaction and reopen", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "100";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "50";
	const fixture = await createFixture(true, [], 2_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		const { faux, session, sessionManager } = fixture;
		faux.setResponses([fauxAssistantMessage("extension-only run")]);
		await session.sendUserMessage("extension-only input");
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ledger-context/external-run").length, 0);
		const oldWindowId = "window:" + sessionManager.getSessionId() + ":initial";
		faux.setResponses([fauxAssistantMessage("real external run")]);
		await session.prompt("real external input");
		const runRecords = sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ledger-context/external-run");
		assert.equal(runRecords.length, 0);
		sessionManager.appendMessage({ role: "user", content: "manual compaction payload " + "m".repeat(8_000), timestamp: Date.now() });
		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.notEqual((compaction.details as { windowId: string }).windowId, oldWindowId);
		const reopened = await reopenFixture(fixture);
		try {
			let resumedContext: Context | undefined;
			faux.setResponses([(context) => {
				resumedContext = context;
				return fauxAssistantMessage("reopened below reminder thresholds");
			}]);
			await reopened.session.prompt("next external input after reload");
			assert.ok(resumedContext);
			const providerText = JSON.stringify(resumedContext.messages);
			assert.doesNotMatch(providerText, /completed external run has nonmaintenance work/);
			const reminders = reopened.sessionManager.getBranch().filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
			);
			assert.equal(reminders.length, 0);
		} finally {
			reopened.session.dispose();
		}
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("reload handoff preserves pending volume reminders during active tool work", { timeout: 10_000 }, async () => {
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "100";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "50";
	let toolStarted = () => {};
	const toolStartedPromise = new Promise<void>((resolve) => {
		toolStarted = resolve;
	});
	let releaseTool = () => {};
	const toolReleased = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	const gatedTool = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "reload_gate",
			label: "Reload gate",
			description: "Waits while the extension runtime reloads.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				toolStarted();
				await toolReleased;
				return { content: [{ type: "text", text: "reload gate result" }], details: {} };
			},
		});
	};
	const fixture = await createFixture(true, [gatedTool], 2_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
		extraToolNames: ["reload_gate"],
	});
	try {
		const { faux, session, sessionManager } = fixture;
		faux.setResponses([fauxAssistantMessage("Evidence: " + "v".repeat(13_000))]);
		await session.prompt("Produce substantial evidence before background work.");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_gate", {}, { id: "reload-gate-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("active run settled after reload"),
		]);
		const runPromise = session.sendUserMessage("reload while background tool work is active");
		await toolStartedPromise;
		await session.reload();
		const handoffs = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === "ledger-context/reminder-handoff",
		);
		assert.equal(handoffs.length, 1);
		releaseTool();
		await runPromise;
		const records = sessionManager.getBranch().filter(
			(entry) => entry.type === "custom" && entry.customType === "ledger-context/external-run",
		);
		assert.equal(records.length, 0);
		const handoff = handoffs[0].data as { pendingReminderReasons: Array<{ kind: string }> };
		assert.ok(handoff.pendingReminderReasons.some((reason) => reason.kind === "stale-volume"));
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE).length, 1);
		await session.reload();
		const pendingHandoffs = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === "ledger-context/reminder-handoff",
		);
		assert.equal(pendingHandoffs.length, 1);
		await session.setModel(faux.getModel());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_gate", {}, { id: "extension-after-model-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("extension-origin work after model selection"),
		]);
		await session.sendUserMessage("extension-origin work after model selection");
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ledger-context/external-run").length, 0);
		let nextExternalContext: Context | undefined;
		faux.setResponses([(context) => {
			nextExternalContext = context;
			return fauxAssistantMessage("next external run after reload handoff");
		}]);
		await session.prompt("next external run after reload handoff");
		assert.ok(nextExternalContext);
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE).length, 1);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("default settings reader reports malformed native configuration as unknown", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "3000";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "1000";
	const fixture = await createFixture(false, [], 2_000, {
		contextWindow: 16_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
		settingsReader: null,
	});
	const { root, faux, session, agentDir, sessionManager } = fixture;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "settings.json"), "{malformed settings");
		faux.setResponses([fauxAssistantMessage(`malformed-settings-volume:${"x".repeat(8_000)}`), fauxAssistantMessage("malformed settings second run")]);
		await session.prompt("exercise malformed settings fallback");
		await session.prompt("deliver malformed settings reminder");
		const reminders = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.ok(reminders.length >= 1);
		const latestDetails = reminders.at(-1)!.details as { nativeBoundaryKnown?: boolean; configSource?: string };
		assert.equal(latestDetails.nativeBoundaryKnown, false);
		assert.match(latestDetails.configSource ?? "", /unknown/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("default settings reader resolves the active model's compaction override", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fixture = await createFixture(false, [], 2_000, {
		contextWindow: 16_000,
		maxTokens: 512,
		reserveTokens: 1_000,
		compactionEnabled: true,
		settingsReader: null,
		extraToolNames: ["get_context_remaining"],
	});
	const { root, faux, session, agentDir, sessionManager } = fixture;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			compaction: {
				enabled: true,
				reserveTokens: 1_000,
				keepRecentTokens: 2_000,
				modelOverrides: {
					"ledger-test/ledger-test-model": { reserveTokens: 6_000 },
				},
			},
		}));
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("get_context_remaining", {})),
			fauxAssistantMessage("model override inspected"),
		]);
		await session.prompt("inspect the active model compaction boundary");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "get_context_remaining")
			.at(-1);
		assert.ok(result);
		const details = (result.message as { details: { effectiveBoundaryTokens: number; nativeCompactionMode: string; configSource: string } }).details;
		assert.equal(details.effectiveBoundaryTokens, 10_000);
		assert.equal(details.nativeCompactionMode, "native");
		assert.equal(details.configSource, "settings-manager");
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("known native boundary uses actual provider usage and lead times", { timeout: 60_000 }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousOutputReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "500000";
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "16384";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "32768";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "16384";
	const createBoundaryFixture = () => createFixture(true, [], 64_000, {
		contextWindow: 500_000,
		maxTokens: 100,
		reserveTokens: 27_200,
	});
	const measureBody = async (bodyTokens: number): Promise<number> => {
		const fixture = await createBoundaryFixture();
		try {
			fixture.faux.setResponses([fauxAssistantMessage("calibration complete")]);
			await fixture.session.prompt("q".repeat(bodyTokens * 4));
			const assistant = messageEntries(fixture.sessionManager.getBranch()).filter((entry) => entry.message.role === "assistant").at(-1);
			assert.ok(assistant);
			return (assistant.message as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0;
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	};
	const calibrationA = await measureBody(1_000);
	const calibrationB = await measureBody(1_001);
	const slope = calibrationB - calibrationA;
	assert.ok(slope > 0);
	const intercept = calibrationA - slope * 1_000;
	const runCase = async (target: number, expectedLevel: string): Promise<void> => {
		const fixture = await createBoundaryFixture();
		try {
			const bodyTokens = Math.max(1, Math.floor((target - intercept) / slope));
			const body = "q".repeat(bodyTokens * 4);
			fixture.faux.setResponses([fauxAssistantMessage("calibration complete")]);
			await fixture.session.prompt(body);
			const assistant = messageEntries(fixture.sessionManager.getBranch()).filter((entry) => entry.message.role === "assistant").at(-1);
			assert.ok(assistant);
			const usage = (assistant.message as { usage?: { totalTokens?: number } }).usage?.totalTokens;
			assert.ok(typeof usage === "number");
			assert.ok(usage < 472_800);
			let resumedContext: Context | undefined;
			fixture.faux.setResponses([(context) => {
				resumedContext = context;
				return fauxAssistantMessage("boundary reminder delivered");
			}]);
			await fixture.session.prompt(`deliver ${expectedLevel} boundary reminder`);
			assert.ok(resumedContext);
			const reminder = fixture.sessionManager.getBranch().filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
			).at(-1);
			assert.ok(reminder);
			const details = reminder.details as { level: string; effectiveBoundaryTokens?: number; nativeBoundaryMode?: string; usageKnown: boolean };
			assert.equal(details.level, expectedLevel);
			assert.equal(details.effectiveBoundaryTokens, 472_800);
			assert.equal(details.nativeBoundaryMode, "native");
			assert.equal(details.usageKnown, true);
			assert.match(String(reminder.content), /effective boundary: 472800/);
			assert.match(JSON.stringify(resumedContext.messages), /model remaining:/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	};
	try {
		await runCase(440_033, "soft");
		await runCase(456_417, "urgent");
	} finally {
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousOutputReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousOutputReserve;
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("checkpoint below threshold continues and disabled auto compaction stays off", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false, [], 2_000, {
		contextWindow: 16_000,
		maxTokens: 512,
		reserveTokens: 1_000,
	});
	try {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("checkpoint", { ledger: "Goal: continue below the native threshold, save one." }),
					fauxToolCall("checkpoint", { ledger: "Goal: continue below the native threshold, save two." }),
				],
			),
			fauxAssistantMessage("checkpoints completed without a window change"),
		]);
		const sessionEvents: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") sessionEvents.push(event.reason);
		});
		await session.prompt("save a checkpoint and continue");

		assert.equal(faux.state.callCount, 2);
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
		assert.deepEqual(sessionEvents, []);
		assert.equal(
			sessionManager.getBranch().filter(
				(entry) => entry.type === "custom" && entry.customType === "ledger-context/checkpoint",
			).length,
			2,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const disabled = await createFixture(false, [largeResultExtension(`disabled-large-result:${"x".repeat(20_000)}`)], 1_750, {
		contextWindow: 8_000,
		maxTokens: 100,
		reserveTokens: 1_000,
		compactionEnabled: false,
		extraToolNames: ["large_result"],
	});
	try {
		let finalContext: Context | undefined;
		disabled.faux.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				finalContext = context;
				return fauxAssistantMessage("disabled auto compaction completed");
			},
		]);
		await disabled.session.prompt("seed old history");
		await disabled.session.prompt("seed recent history");
		await disabled.session.prompt("run a result beyond the configured threshold");

		assert.equal(disabled.faux.state.callCount, 4);
		assert.equal(disabled.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
		assert.ok(finalContext);
		assert.match(JSON.stringify(finalContext.messages), /disabled-large-result/);
	} finally {
		rmSync(disabled.root, { recursive: true, force: true });
	}
});

test("native overflow retries once through the ledger compaction hook", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(true, [], 1_000, {
		contextWindow: 16_000,
		maxTokens: 100,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([
			fauxAssistantMessage("seed history"),
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			(context) => {
				assert.ok(context.messages.some((message) => JSON.stringify(message).includes("# Ledger Context Recovery")));
				return fauxAssistantMessage("completed after overflow recovery");
			},
		]);
		await session.prompt("seed the recoverable overflow run");
		const compactionEvents: Array<{ reason: string; willRetry: boolean; aborted: boolean }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end" && event.result) {
				compactionEvents.push({ reason: event.reason, willRetry: event.willRetry, aborted: event.aborted });
			}
		});
		await session.prompt("x".repeat(5_000));

		assert.equal(faux.state.callCount, 3);
		assert.deepEqual(compactionEvents, [{ reason: "overflow", willRetry: true, aborted: false }]);
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
		assert.equal(session.getLastAssistantText(), "completed after overflow recovery");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("native overflow cancellation leaves retry responses unconsumed", { timeout: TEST_TIMEOUT_MS }, async () => {
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	const cancelableCompaction = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", async (event) => {
			markCompactionStarted();
			await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
			return { cancel: true };
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [cancelableCompaction], 1_000, {
		contextWindow: 16_000,
		maxTokens: 100,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([
			fauxAssistantMessage("seed history"),
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("must remain queued after cancellation"),
		]);
		await session.prompt("seed the cancellable overflow run");
		let failedEvent: { reason: string; aborted: boolean; willRetry: boolean } | undefined;
		session.subscribe((event) => {
			if (event.type === "compaction_end" && !event.result) {
				failedEvent = { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry };
			}
		});
		const promptPromise = session.prompt("x".repeat(5_000));
		await compactionStarted;
		session.abortCompaction();
		await promptPromise;

		assert.equal(faux.state.callCount, 2);
		assert.equal(faux.getPendingResponseCount(), 1);
		assert.deepEqual(failedEvent, { reason: "overflow", aborted: true, willRetry: false });
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
		assert.equal(session.isStreaming, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("steering queued during native compaction is delivered once in order", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	use4kRecoveryBudgets(t);
	const previousSoft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "100";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "50";
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	let releaseCompaction = () => {};
	const compactionReleased = new Promise<void>((resolve) => {
		releaseCompaction = resolve;
	});
	const toolResult = `large-tool-result:${"x".repeat(6_200)}`;
	const delayedCompaction = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "large_result",
			label: "Large result",
			description: "Returns a large result for steering-order coverage.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
		});
		pi.on("session_before_compact", async () => {
			markCompactionStarted();
			await compactionReleased;
			return;
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [delayedCompaction], 1_750, {
		contextWindow: 6_500,
		maxTokens: 100,
		reserveTokens: 3_000,
		extraToolNames: ["large_result"],
	});
	try {
		let reminderContext: Context | undefined;
		let steeringContext: Context | undefined;
		let followUpContext: Context | undefined;
		const toolCallId = "steering-order-tool";
		faux.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}, { id: toolCallId }), { stopReason: "toolUse" }),
			(context) => {
				reminderContext = context;
				return fauxAssistantMessage("finished after budget reminder");
			},
			(context) => {
				steeringContext = context;
				return fauxAssistantMessage("finished after steering");
			},
			(context) => {
				followUpContext = context;
				return fauxAssistantMessage("finished after follow up");
			},
		]);
		let agentStarts = 0;
		session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts++;
		});
		await session.sendUserMessage("seed old history");
		await session.sendUserMessage("seed recent history");
		const promptPromise = session.prompt("run the large tool");
		await compactionStarted;
		await session.steer("change direction");
		await session.followUp("follow up direction");
		releaseCompaction();
		await promptPromise;

		assert.equal(agentStarts, 3);
		assert.equal(faux.state.callCount, 6);
		const compactions = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction",
		);
		assert.ok(compactions.length >= 1);
		assert.ok(compactions.every((entry) => entry.fromHook === true && (entry.details as { schemaVersion?: number; kind?: string }).schemaVersion === 4));
		assert.equal(new Set(compactions.map((entry) => (entry.details as { windowId: string }).windowId)).size, compactions.length);
		assert.ok(reminderContext);
		assert.ok(steeringContext);
		assert.ok(followUpContext);
		const steeringMessages = steeringContext.messages.filter(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "text" && block.text === "change direction"),
		);
		assert.equal(steeringMessages.length, 1);
		const branchMessages = messageEntries(sessionManager.getBranch());
		const assistantIndex = branchMessages.findIndex(
			(entry) =>
				entry.message.role === "assistant" &&
				Array.isArray(entry.message.content) &&
				entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
		const resultIndex = branchMessages.findIndex(
			(entry, index) => index > assistantIndex && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
		);
		assert.ok(assistantIndex >= 0);
		assert.ok(resultIndex > assistantIndex);
		assert.match(JSON.stringify(branchMessages[resultIndex].message), /large-tool-result/);
		assert.match(JSON.stringify(reminderContext.messages), /Ledger Context urgent budget reminder/);
		const refreshedNotice = reminderContext.messages.flatMap((message) => message.role === "user" && Array.isArray(message.content)
			? message.content.flatMap((block) => block.type === "text" && block.text.startsWith("Ledger Context urgent budget reminder.") ? [block.text] : []) : [])[0];
		assert.ok(refreshedNotice);
		assert.ok(refreshedNotice.includes(`usage window: ${(compactions[0].details as LedgerCompactionDetails).windowId}`), "pressure that persists after compaction must be reported for the new window");
		assert.doesNotMatch(refreshedNotice, /stale-volume/);
		const branchUserMessages = messageEntries(sessionManager.getBranch()).filter((entry) => entry.message.role === "user");
		assert.equal(branchUserMessages.filter((entry) => JSON.stringify(entry.message).includes("change direction")).length, 1);
		assert.equal(branchUserMessages.filter((entry) => JSON.stringify(entry.message).includes("follow up direction")).length, 1);
		assert.match(JSON.stringify(followUpContext.messages), /change direction/);
		assert.match(JSON.stringify(followUpContext.messages), /follow up direction/);
		assert.ok(
			followUpContext.messages.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("change direction")) <
				followUpContext.messages.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("follow up direction")),
		);
		const reminders = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.ok(reminders.length >= 1);
		assert.equal(new Set(reminders.map((entry) => (entry.details as { reminderKey: string }).reminderKey)).size, reminders.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousSoft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoft;
		if (previousUrgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgent;
	}
});

test("rejects invalid checkpoint input while retaining the previous version", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousLimit = process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
	process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "4096";
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const oversizedLedger = "x".repeat(16_388);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("checkpoint", { ledger: "Goal: keep this version." }),
				fauxToolCall("checkpoint", { ledger: oversizedLedger }),
			]),
			fauxAssistantMessage("validation complete"),
		]);
		await session.prompt("Save the first in-memory checkpoint");

		const checkpoints = checkpointEntries(sessionManager.getBranch());
		assert.equal(checkpoints.length, 1);
		const firstReceipt = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint",
		);
		assert.ok(firstReceipt);
		const firstReceiptMessage = firstReceipt.message as { content: unknown; details?: unknown };
		assert.match(JSON.stringify(firstReceiptMessage.content), /current process memory only/);
		assert.equal((firstReceiptMessage.details as { checkpointEntryId: string }).checkpointEntryId, checkpoints[0].id);
		const oversizedReceipt = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint")
			.at(-1);
		assert.ok(oversizedReceipt);
		assert.match(JSON.stringify((oversizedReceipt.message as { content: unknown }).content), /exceeds/);

		const assistantEntry = messageEntries(sessionManager.getBranch()).find((entry) => entry.message.role === "assistant");
		assert.ok(assistantEntry);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("checkpoint", {
					ledger: "Goal: keep the previous version.",
					activeRequestEntryIds: [assistantEntry.id],
				}),
			),
			fauxAssistantMessage("reference validation complete"),
		]);
		await session.prompt("Try an invalid active request reference");
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 1);
		const invalidReceipt = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint")
			.at(-1);
		assert.ok(invalidReceipt);
		assert.match(JSON.stringify((invalidReceipt.message as { content: unknown }).content), /must reference a user message/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousLimit === undefined) delete process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
		else process.env.LEDGER_CONTEXT_LEDGER_TOKENS = previousLimit;
	}
});

test("uses pi token estimates and renders every saved ledger within its configured limit", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousLimit = process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
	process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "8192";
	const { root, faux, session, sessionManager } = await createFixture(true);
	try {
		const asciiLedger = `${"a".repeat(19_996)}ASCII-LEDGER-END`;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: asciiLedger })),
			fauxAssistantMessage("ascii checkpoint saved"),
		]);
		await session.prompt("Save the large ASCII ledger");
		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.match(compaction.summary, /ASCII-LEDGER-END/);

		process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "4096";
		faux.setResponses([fauxAssistantMessage("work after the large checkpoint")]);
		await session.prompt("Add work after the large checkpoint");
		await assert.rejects(session.compact(), /Compaction cancelled/);
		assert.equal(latestCompaction(sessionManager.getBranch()).id, compaction.id);
		assert.equal((checkpointEntries(sessionManager.getBranch()).at(-1)!.data as { ledger: string }).ledger, asciiLedger);
		process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "8192";

		const cjkLedger = `${"界".repeat(6_000)}CJK-LEDGER-END`;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: cjkLedger })),
			fauxAssistantMessage("cjk checkpoint saved"),
		]);
		await session.prompt("Save the CJK ledger");
		const latestCheckpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		assert.ok(latestCheckpoint);
		assert.equal((latestCheckpoint.data as { ledger: string }).ledger, cjkLedger);
		const cjkReceipt = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint")
			.at(-1);
		assert.ok(cjkReceipt);
		assert.equal(
			(cjkReceipt.message as { details: { estimatedLedgerTokens: number } }).details.estimatedLedgerTokens,
			estimateTokens({ role: "user", content: [{ type: "text", text: cjkLedger }], timestamp: 0 }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousLimit === undefined) delete process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
		else process.env.LEDGER_CONTEXT_LEDGER_TOKENS = previousLimit;
	}
});

test("UTF-8 byte caps and bounded history recovery preserve Unicode originals", { timeout: 15_000 }, async () => {
	const previousLimit = process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
	process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "65536";
	const { root, faux, session, sessionManager } = await createFixture(true);
	try {
		const overByteLedger = "界🚀".repeat(10_000);
		assert.ok(Buffer.byteLength(overByteLedger, "utf8") > 65_536);
		assert.ok(estimateTokens({ role: "user", content: [{ type: "text", text: overByteLedger }], timestamp: 0 }) < 65_536);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: overByteLedger })),
			fauxAssistantMessage("Unicode byte-cap validation complete"),
		]);
		await session.prompt("save a Unicode ledger over the byte cap");
		const rejectedCheckpoint = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint")
			.at(-1);
		assert.ok(rejectedCheckpoint);
		assert.match(JSON.stringify((rejectedCheckpoint.message as { content: unknown }).content), /65,536|65536/);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);

		const unicodeText = "任务🚀已验证\n".repeat(600);
		const unicodeEntryId = sessionManager.appendMessage({ role: "user", content: unicodeText, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: unicodeEntryId, offset: 0, length: 256 })),
			fauxAssistantMessage("bounded Unicode history read complete"),
		]);
		await session.prompt("read bounded Unicode history");
		const readResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(readResult);
		const readDetails = (readResult.message as { details: { text: string; entryId: string } }).details;
		assert.equal(readDetails.entryId, unicodeEntryId);
		assert.match(readDetails.text, /任务🚀/);
		assertHistoryOutputWithinTokens(readResult);
		const sourceEntry = sessionManager.getEntry(unicodeEntryId);
		assert.ok(sourceEntry?.type === "message");
		assert.equal((sourceEntry.message as { content: string }).content, unicodeText);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousLimit === undefined) delete process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
		else process.env.LEDGER_CONTEXT_LEDGER_TOKENS = previousLimit;
	}
});

test("normal compaction cancellation leaves the branch and provider state unchanged", { timeout: TEST_TIMEOUT_MS }, async () => {
	const cancelCompaction = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", async () => ({ cancel: true }));
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [cancelCompaction]);
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Goal: cancellation keeps the previous window." })),
			fauxAssistantMessage("checkpoint saved"),
		]);
		await session.prompt("Prepare a cancellable compaction");
		const branchBefore = sessionManager.getBranch().map((entry) => entry.id);
		const providerCallsBefore = faux.state.callCount;

		await assert.rejects(session.compact("cancel this window"), /Compaction cancelled/);
		assert.deepEqual(sessionManager.getBranch().map((entry) => entry.id), branchBefore);
		assert.equal(faux.state.callCount, providerCallsBefore, "cancellation must not call a fallback summarizer");
		assert.equal(session.isStreaming, false);
		assert.equal(sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stops after a transcript write failure and reopens the last durable checkpoint", { timeout: TEST_TIMEOUT_MS }, async () => {
	let faultNextCheckpoint = false;
	let transcriptPath: string | undefined;
	let backupPath: string | undefined;
	const faultingTranscript = (pi: ExtensionAPI): void => {
		pi.on("tool_call", async (event, ctx) => {
			if (!faultNextCheckpoint || event.toolName !== "checkpoint") return;
			faultNextCheckpoint = false;
			transcriptPath = ctx.sessionManager.getSessionFile();
			if (!transcriptPath) throw new Error("test fixture did not create a persisted transcript");
			backupPath = `${transcriptPath}.before-write-failure`;
			renameSync(transcriptPath, backupPath);
			mkdirSync(transcriptPath);
		});
	};
	const fixture = await createFixture(true, [faultingTranscript]);
	const { root, faux, session, sessionManager } = fixture;
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Goal: last durable checkpoint." })),
			fauxAssistantMessage("durable checkpoint saved"),
		]);
		await session.prompt("Create the durable checkpoint before the fault");
		transcriptPath = sessionManager.getSessionFile();
		assert.ok(transcriptPath && existsSync(transcriptPath));
		const providerCallsBeforeFault = faux.state.callCount;

		faultNextCheckpoint = true;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Goal: this save must fail." })),
			fauxAssistantMessage("unreachable after write failure"),
		]);
		try {
			await session.prompt("Trigger the transcript write failure");
		} catch {
			// A host persistence exception may reject the current prompt after the tool fails.
		}
		assert.equal(session.isStreaming, false);
		assert.equal(faux.state.callCount, providerCallsBeforeFault + 1, "the aborted run must not consume the unreachable response");
		assert.ok(backupPath && existsSync(backupPath));
		const durableBeforeRestore = readFileSync(backupPath!, "utf8");
		assert.match(durableBeforeRestore, /last durable checkpoint/);
		assert.doesNotMatch(
			durableBeforeRestore,
			/"customType":"ledger-context\/checkpoint","data":\{"schemaVersion":1,"ledger":"Goal: this save must fail\."/,
		);
		const failedMemoryCheckpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		if (failedMemoryCheckpoint && JSON.stringify(failedMemoryCheckpoint.data).includes("this save must fail")) {
			assert.match(JSON.stringify(failedMemoryCheckpoint.data), /this save must fail/);
		}
		const failedMemoryReceipt = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint")
			.at(-1);
		const failedSuccessReceipt = messageEntries(sessionManager.getBranch()).find((entry) => {
			if (entry.message.role !== "toolResult" || entry.message.toolName !== "checkpoint") return false;
			const result = entry.message as { content: unknown; details?: unknown };
			return JSON.stringify(result.content).includes("Checkpoint saved.") && JSON.stringify(result.details).includes("this save must fail");
		});
		assert.equal(failedSuccessReceipt, undefined);
		if (failedMemoryReceipt) {
			const result = failedMemoryReceipt.message as { content: unknown; isError?: boolean };
			assert.equal(result.isError, true);
			assert.doesNotMatch(JSON.stringify(result.content), /Checkpoint saved/);
		}

		rmSync(transcriptPath!, { recursive: true, force: true });
		renameSync(backupPath!, transcriptPath!);
		backupPath = undefined;
		const reopened = SessionManager.open(transcriptPath!);
		const durableCheckpoints = checkpointEntries(reopened.getBranch());
		assert.equal(durableCheckpoints.length, 1);
		assert.match(JSON.stringify(durableCheckpoints[0].data), /last durable checkpoint/);

		await session.reload();
		const providerCallsBeforeRetry = faux.state.callCount;
		const branchBeforeRetry = sessionManager.getBranch().map((entry) => entry.id);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Goal: retry must remain blocked." })),
			fauxAssistantMessage("blocked save handled"),
		]);
		await session.prompt("Try to save after the write failure");
		assert.equal(session.isStreaming, false);
		assert.equal(faux.state.callCount, providerCallsBeforeRetry);
		assert.deepEqual(sessionManager.getBranch().map((entry) => entry.id), branchBeforeRetry);

		const providerCallsBeforeCompact = faux.state.callCount;
		await assert.rejects(session.compact(), /Compaction cancelled/);
		assert.equal(faux.state.callCount, providerCallsBeforeCompact);

		const recovered = await reopenFixture(fixture);
		try {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "reopened durable recovery" })),
				fauxAssistantMessage("reopened checkpoint saved"),
			]);
			await recovered.session.prompt("save after reopening the durable session");
			assert.match(JSON.stringify(recovered.sessionManager.getBranch()), /reopened durable recovery/);
		} finally {
			recovered.session.dispose();
		}
	} finally {
		if (backupPath && existsSync(backupPath) && transcriptPath) {
			rmSync(transcriptPath, { recursive: true, force: true });
			renameSync(backupPath, transcriptPath);
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("stops before prompt or manual compact after a model transcript append failure", { timeout: TEST_TIMEOUT_MS }, async () => {
	for (const entryPoint of ["compact-first", "prompt-first"] as const) {
		const fixture = await createFixture(true, [], 64);
		const { root, faux, session, sessionManager } = fixture;
		let sessionFile: string | undefined;
		let backupPath: string | undefined;
		try {
			faux.setResponses([fauxAssistantMessage("durable model seed"), fauxAssistantMessage("durable model second turn")]);
			await session.prompt("create the durable model seed");
			await session.prompt(`create a durable second turn ${"x".repeat(2_000)}`);
			sessionFile = sessionManager.getSessionFile();
			assert.ok(sessionFile && existsSync(sessionFile));
			const durableBeforeFailure = SessionManager.open(sessionFile).getBranch().map((entry) => entry.id);
			const mutableSessionManager = sessionManager as unknown as {
				appendModelChange: (provider: string, modelId: string) => string;
			};
			const appendModelChange = mutableSessionManager.appendModelChange.bind(sessionManager);
			backupPath = `${sessionFile}.before-model-write-failure`;
			mutableSessionManager.appendModelChange = (provider, modelId) => {
				renameSync(sessionFile!, backupPath!);
				mkdirSync(sessionFile!);
				return appendModelChange(provider, modelId);
			};

			await assert.rejects(session.setModel(faux.getModel()), /EISDIR|directory|is not a file/i);
			rmSync(sessionFile, { recursive: true, force: true });
			renameSync(backupPath, sessionFile);
			backupPath = undefined;

			const providerCallsBeforeGuard = faux.state.callCount;
			if (entryPoint === "compact-first") {
				await assert.rejects(session.compact(), /Compaction cancelled/);
			} else {
				faux.setResponses([fauxAssistantMessage("must remain unused after model write failure")]);
				await session.prompt("retry after the model transcript write failure");
			}
			assert.equal(faux.state.callCount, providerCallsBeforeGuard);
			const reopened = SessionManager.open(sessionFile);
			assert.deepEqual(reopened.getBranch().map((entry) => entry.id), durableBeforeFailure);
			assert.equal(reopened.getLeafId(), durableBeforeFailure.at(-1));
		} finally {
			if (backupPath && sessionFile && existsSync(backupPath)) {
				rmSync(sessionFile, { recursive: true, force: true });
				renameSync(backupPath, sessionFile);
			}
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("history tools recover old entries with stable windows and finite pagination", { timeout: TEST_TIMEOUT_MS }, async () => {
	const preparations: string[] = [];
	const preparationObserver = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => {
			preparations.push(event.preparation.firstKeptEntryId);
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [preparationObserver]);
	try {
		const query = "history-sentinel";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("checkpoint", {
					ledger: "Goal: old-checkpoint-sentinel remains evidence after repeated compaction.",
				}),
			),
			fauxAssistantMessage(`${query} execution recorded`),
		]);
		await session.prompt(`${query} original request`);

		const oldUser = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "user" && JSON.stringify(entry.message.content).includes(query),
		);
		assert.ok(oldUser);
		const oldCheckpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		assert.ok(oldCheckpoint);

		const filler = "completed execution fact ".repeat(24);
		faux.setResponses([fauxAssistantMessage(filler)]);
		await session.prompt("continue the first window");
		const firstRetainedText = "first-retained-sentinel ".repeat(40);
		const firstRetainedEntryId = sessionManager.appendMessage({ role: "user", content: firstRetainedText, timestamp: Date.now() });
		await session.compact();
		const firstCompaction = sessionManager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(firstCompaction);
		assert.equal(preparations.length, 1);
		assert.equal(firstCompaction.firstKeptEntryId, preparations[0]);
		const firstRetainedIndex = sessionManager.getBranch().findIndex((entry) => entry.id === firstRetainedEntryId);
		const firstCompactionIndex = sessionManager.getBranch().findIndex((entry) => entry.id === firstCompaction.id);
		const firstKeptIndex = sessionManager.getBranch().findIndex((entry) => entry.id === firstCompaction.firstKeptEntryId);
		assert.ok(firstRetainedIndex >= firstKeptIndex && firstRetainedIndex < firstCompactionIndex);

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("checkpoint", {
					ledger: "Goal: new-checkpoint-sentinel is the current active ledger after the first window.",
				}),
			),
			fauxAssistantMessage("second checkpoint recorded"),
		]);
		await session.prompt("save the second window checkpoint");
		faux.setResponses([fauxAssistantMessage(filler)]);
		await session.prompt("continue the second window");
		await session.compact();

		const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
		assert.equal(compactions.length, 2);
		const committedWindowIds = compactions.map((entry) => (entry.details as { windowId: string }).windowId);
		assert.equal(new Set(committedWindowIds).size, 2, "each committed compaction must receive a fresh window ID");
		const searchQuery = "old-checkpoint-sentinel";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: searchQuery, limit: 5, filter: { includeMaintenance: true } })),
			fauxAssistantMessage("history lookup complete"),
		]);
		await session.prompt("look up the old checkpoint");
		const searchResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(searchResult);
		const searchDetails = (searchResult.message as { details: { items: Array<{ entryId: string; windowId: string; role: string; executionStatus: string }>; nextCursor: string | null } }).details;
		assert.ok(searchDetails.items.some((hit) => hit.entryId === oldCheckpoint.id));
		assert.ok(searchDetails.items.every((hit) => hit.windowId.startsWith("window:")));
		assert.ok(searchDetails.items.some((hit) => hit.role === "assistant" && hit.executionStatus === "requested"));
		assert.ok(searchDetails.items.some((hit) => hit.entryId === oldCheckpoint.id && hit.role === "custom" && hit.executionStatus === "saved"));
		assertHistoryOutputWithinTokens(searchResult);
		for (const compaction of compactions) {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("history_read", { entryId: compaction.id, offset: 0, length: 64 })),
				fauxAssistantMessage("compaction history read complete"),
			]);
			await session.prompt("read a committed compaction entry");
			const compactionRead = messageEntries(sessionManager.getBranch())
				.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
				.at(-1);
			assert.ok(compactionRead);
			const compactionReadDetails = (compactionRead.message as { details: { windowId: string; role: string; executionStatus: string } }).details;
			assert.equal(compactionReadDetails.windowId, (compaction.details as { windowId: string }).windowId);
			assert.equal(compactionReadDetails.role, "compaction");
			assert.equal(compactionReadDetails.executionStatus, "committed");
			assertHistoryOutputWithinTokens(compactionRead);
		}

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: oldCheckpoint.id, offset: 0, length: 512 })),
			fauxAssistantMessage("history read complete"),
		]);
		await session.prompt("read the old checkpoint evidence");
		const readResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(readResult);
		const readMessage = readResult.message as { content: unknown; details: { entryId: string; windowId: string; role: string; executionStatus: string; nextOffset: number | null } };
		assert.equal(readMessage.details.entryId, oldCheckpoint.id);
		assert.ok(readMessage.details.windowId.startsWith("window:"));
		assert.equal(readMessage.details.role, "custom");
		assert.equal(readMessage.details.executionStatus, "saved");
		assert.match(JSON.stringify(readMessage.content), /old-checkpoint-sentinel/);
		assertHistoryOutputWithinTokens(readResult);
		const currentCheckpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		assert.ok(currentCheckpoint);
		assert.match(JSON.stringify(currentCheckpoint.data), /new-checkpoint-sentinel/);
		const checkpointResult = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "checkpoint" && !entry.message.isError,
		);
		assert.ok(checkpointResult);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: checkpointResult.id, offset: 0, length: 128 })),
			fauxAssistantMessage("tool result history read complete"),
		]);
		await session.prompt("read a successful tool result");
		const successfulToolRead = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(successfulToolRead);
		const successfulToolDetails = (successfulToolRead.message as { details: { role: string; executionStatus: string } }).details;
		assert.equal(successfulToolDetails.role, "toolResult");
		assert.equal(successfulToolDetails.executionStatus, "completed");
		assertHistoryOutputWithinTokens(successfulToolRead);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: "first-retained-sentinel", limit: 5, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("retained sentinel lookup complete"),
		]);
		await session.prompt("find the first retained sentinel");
		const retainedSearch = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(retainedSearch);
		const retainedSearchDetails = (retainedSearch.message as { details: { items: Array<{ entryId: string; role: string; executionStatus: string }> } }).details;
		const retainedHit = retainedSearchDetails.items.find((hit) => hit.entryId === firstRetainedEntryId);
		assert.ok(retainedHit);
		assert.equal(retainedHit.role, "user");
		assert.equal(retainedHit.executionStatus, "received");
		assertHistoryOutputWithinTokens(retainedSearch);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: firstRetainedEntryId, offset: 0, length: firstRetainedText.length + 64 })),
			fauxAssistantMessage("retained sentinel read complete"),
		]);
		await session.prompt("read the retained sentinel");
		const retainedRead = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(retainedRead);
		const retainedReadMessage = retainedRead.message as { content: unknown; details: { role: string; executionStatus: string; text: string } };
		assert.equal(retainedReadMessage.details.role, "user");
		assert.equal(retainedReadMessage.details.executionStatus, "received");
		assert.match(retainedReadMessage.details.text, /first-retained-sentinel/);
		assertHistoryOutputWithinTokens(retainedRead);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query, limit: 1, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("first history page complete"),
		]);
		await session.prompt("find the first sentinel page");
		let page = 1;
		let cursor = (
			messageEntries(sessionManager.getBranch())
				.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
				.at(-1)!.message as { details: { nextCursor: string | null } }
		).details.nextCursor;
		const cursors = new Set<string>();
		while (cursor) {
			assert.equal(cursors.has(cursor), false);
			cursors.add(cursor);
			assert.ok(page < 20, `history pagination must terminate within the captured snapshot: page=${page} cursor=${cursor}`);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("history_search", { query, cursor, limit: 1, filter: { kinds: ["user_input","assistant_text"] } })),
				fauxAssistantMessage(`history page ${page + 1} complete`),
			]);
			await session.prompt(`read history page ${page + 1}`);
			const pageResult = (
				messageEntries(sessionManager.getBranch())
					.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
					.at(-1)!.message as { details: { nextCursor: string | null } }
			);
			cursor = pageResult.details.nextCursor;
			page++;
		}
		assert.ok(page >= 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history tools isolate branches and expose bounded input errors", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousReadLimit = process.env.LEDGER_CONTEXT_READ_TOKENS;
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const mainText = "branch-main-sentinel";
		faux.setResponses([fauxAssistantMessage("main branch recorded")]);
		await session.prompt(mainText);
		const mainUser = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "user" && JSON.stringify(entry.message.content).includes(mainText),
		);
		assert.ok(mainUser);

		sessionManager.resetLeaf();
		faux.setResponses([fauxAssistantMessage("sibling branch recorded")]);
		await session.prompt("sibling branch only");

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: mainText, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("branch search complete"),
		]);
		await session.prompt("search this branch");
		const branchSearch = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(branchSearch);
		assert.deepEqual((branchSearch.message as { details: { items: unknown[] } }).details.items, []);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: mainUser.id })),
			fauxAssistantMessage("cross branch read complete"),
		]);
		await session.prompt("read the unavailable branch entry");
		const crossBranchRead = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(crossBranchRead);
		assert.equal((crossBranchRead.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((crossBranchRead.message as { content: unknown }).content), /current branch/);
		assertHistoryOutputWithinTokens(crossBranchRead);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: crossBranchRead.id, offset: 0, length: 128 })),
			fauxAssistantMessage("failed tool result history read complete"),
		]);
		await session.prompt("read the failed tool result");
		const failedToolRead = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(failedToolRead);
		const failedToolDetails = (failedToolRead.message as { details: { role: string; executionStatus: string } }).details;
		assert.equal(failedToolDetails.role, "toolResult");
		assert.equal(failedToolDetails.executionStatus, "failed");
		assertHistoryOutputWithinTokens(failedToolRead);

		const hugeIdentifier = "z".repeat(100_000);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("history_search", { query: "x", limit: 101, filter: { kinds: ["user_input","assistant_text"] } }),
				fauxToolCall("history_read", { entryId: sessionManager.getLeafId(), offset: -1 }),
				fauxToolCall("history_search", { query: hugeIdentifier, filter: { kinds: ["user_input","assistant_text"] } }),
				fauxToolCall("history_read", { entryId: hugeIdentifier }),
				fauxToolCall("history_search", { query: "x", filter: { kinds: ["user_input","assistant_text"], windowIds: [hugeIdentifier] } }),
				fauxToolCall("history_search", { query: "x", cursor: hugeIdentifier, filter: { kinds: ["user_input","assistant_text"] } }),
			]),
			fauxAssistantMessage("input validation complete"),
		]);
		await session.prompt("exercise history input caps");
		const capErrors = messageEntries(sessionManager.getBranch()).filter(
			(entry) => entry.message.role === "toolResult" && (entry.message.toolName === "history_search" || entry.message.toolName === "history_read"),
		);
		const latestCapErrors = capErrors.slice(-6);
		assert.equal(latestCapErrors.length, 6);
		assert.ok(latestCapErrors.every((entry) => (entry.message as { isError: boolean }).isError));
		assert.match(JSON.stringify(latestCapErrors), /limit|offset|query|entryId|windowId|cursor/);
		for (const error of latestCapErrors) assertHistoryOutputWithinTokens(error);

		process.env.LEDGER_CONTEXT_READ_TOKENS = "1";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sessionManager.getLeafId() })),
			fauxAssistantMessage("capacity check complete"),
		]);
		await session.prompt("check the tiny history output budget");
		const capacityError = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(capacityError);
		assert.equal((capacityError.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((capacityError.message as { content: unknown }).content), /history_output_capacity/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousReadLimit === undefined) delete process.env.LEDGER_CONTEXT_READ_TOKENS;
		else process.env.LEDGER_CONTEXT_READ_TOKENS = previousReadLimit;
	}
});

test("fresh history searches use the latest repeated tool call ID", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const repeatedId = "review-repeated-id";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: "absent-first", filter: { kinds: ["user_input","assistant_text"] } }, { id: repeatedId })),
			fauxAssistantMessage("first search complete"),
		]);
		await session.prompt("run the first search");

		const laterText = "later-duplicate-id-sentinel";
		faux.setResponses([fauxAssistantMessage(laterText)]);
		await session.prompt("record later evidence");
		const later = messageEntries(sessionManager.getBranch()).find(
			(entry) => entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes(laterText),
		);
		assert.ok(later);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: laterText, filter: { kinds: ["user_input","assistant_text"] } }, { id: repeatedId })),
			fauxAssistantMessage("fresh search complete"),
		]);
		await session.prompt("run a fresh search");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(result);
		const details = (result.message as { details: { items: Array<{ entryId: string; role: string; executionStatus: string }>; nextCursor: string | null } }).details;
		assert.ok(details.items.some((hit) => hit.entryId === later.id));
		assert.ok(details.items.some((hit) => hit.role === "assistant" && hit.executionStatus === "completed"));
		assertHistoryOutputWithinTokens(result);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_search ignores case by default, preserves literal offsets and binds cursor case mode", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const originals = ["İ Timeout [A+B].", "second TIMEOUT [A+B].", "third timeout [a+b]."];
		const ids = originals.map((content) => sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() }));
		sessionManager.appendMessage({ role: "user", content: "AABx is not the bracketed literal.", timestamp: Date.now() });
		const search = async (params: Record<string, unknown>) => {
			faux.setResponses([fauxAssistantMessage(fauxToolCall("history_search", { ...params, filter: { kinds: ["user_input"] } })), fauxAssistantMessage("done")]);
			await session.prompt("Run the history lookup.");
			const result = messageEntries(sessionManager.getBranch()).filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search").at(-1)!;
			assert.ok(result);
			assertHistoryOutputWithinTokens(result);
			return {
				text: toolResultText(result),
				isError: result.message.role === "toolResult" && result.message.isError,
				details: (result.message as { details: { caseSensitive: boolean; items: Array<{ entryId: string; matchOffset: number; snippet: string }>; nextCursor: string | null } }).details,
			};
		};
		const first = await search({ query: "timeout", limit: 1 });
		assert.equal(first.isError, false);
		assert.equal(first.details.caseSensitive, false);
		assert.deepEqual(first.details.items.map((hit) => hit.entryId), [ids[2]]);
		assert.ok(first.details.nextCursor);
		assert.match(first.text, /case-insensitive literal/);
		sessionManager.appendMessage({ role: "user", content: "late TIMEOUT", timestamp: Date.now() });
		const next = await search({ query: "timeout", caseSensitive: false, limit: 1, cursor: first.details.nextCursor });
		assert.deepEqual(next.details.items.map((hit) => hit.entryId), [ids[1]]);
		const mismatch = await search({ query: "timeout", caseSensitive: true, cursor: first.details.nextCursor });
		assert.equal(mismatch.isError, true);
		assert.match(mismatch.text, /history_cursor_invalid/);
		const strict = await search({ query: "Timeout", caseSensitive: true });
		assert.equal(strict.details.caseSensitive, true);
		assert.deepEqual(strict.details.items.map((hit) => hit.entryId), [ids[0]]);
		assert.match(strict.text, /case-sensitive literal/);
		const literal = await search({ query: "[A+B]." });
		assert.deepEqual(literal.details.items.map((hit) => hit.entryId), [...ids].reverse());
		assert.equal((await search({ query: ".*" })).details.items.length, 0);
		const unicode = await search({ query: "TIMEOUT" });
		const originalHit = unicode.details.items.find((hit) => hit.entryId === ids[0]);
		assert.ok(originalHit);
		assert.equal(originalHit.matchOffset, originals[0].indexOf("Timeout"));
		assert.match(originalHit.snippet, /İ Timeout/);
		assert.equal((await search({ query: "timeout", caseSensitive: "yes" })).isError, true);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_search scopes conversation, tools, and all views with newest results", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const orderQuery = "scope-newest-order-sentinel";
		const conversationQuery = "scope-conversation-sentinel";
		const toolQuery = "scope-tool-sentinel";
		const thinkingQuery = "scope-thinking-sentinel";
		const maintenanceQuery = "scope-maintenance-sentinel";
		const olderId = sessionManager.appendMessage({ role: "user", content: `${orderQuery} older`, timestamp: Date.now() });
		const newerId = sessionManager.appendMessage({ role: "user", content: `${orderQuery} newer`, timestamp: Date.now() });
		const mixedId = sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: `${conversationQuery} assistant text` },
				fauxThinking(thinkingQuery),
				fauxToolCall("ordinary_tool", { marker: toolQuery }, { id: "scope-ordinary-call" }),
				fauxToolCall("history_search", { query: maintenanceQuery, filter: { kinds: ["user_input","assistant_text"] } }, { id: "scope-maintenance-call" }),
			]),
		);
		const resultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "scope-ordinary-call",
			toolName: "ordinary_tool",
			content: [{ type: "text", text: `${toolQuery} result` }],
			isError: false,
			timestamp: Date.now(),
		});
		const maintenanceId = sessionManager.appendCustomEntry("test-maintenance", { marker: maintenanceQuery });
		const initialWindowId = `window:${sessionManager.getSessionId()}:initial`;

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: orderQuery, limit: 1, filter: { kinds: ["user_input","assistant_text"], windowIds: [initialWindowId] } })),
			fauxAssistantMessage("scope order search complete"),
		]);
		await session.prompt("search newest conversation entry");
		const first = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(first);
		const firstDetails = (first.message as { details: { filter: { kinds: string[] }; items: Array<{ entryId: string }>; nextCursor: string | null } }).details;
		assert.deepEqual(firstDetails.filter.kinds, ["assistant_text", "user_input"]);
		assert.equal(firstDetails.items[0].entryId, newerId);
		assert.ok(firstDetails.nextCursor);

		const postSnapshotId = sessionManager.appendMessage({ role: "user", content: orderQuery, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: orderQuery, cursor: firstDetails.nextCursor, limit: 10, filter: { kinds: ["user_input","assistant_text"], windowIds: [initialWindowId] } })),
			fauxAssistantMessage("scope snapshot continuation complete"),
		]);
		await session.prompt("continue the captured conversation snapshot");
		const continuation = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(continuation);
		const continuationDetails = (continuation.message as { details: { items: Array<{ entryId: string }> } }).details;
		assert.ok(continuationDetails.items.some((hit) => hit.entryId === olderId));
		assert.equal(continuationDetails.items.some((hit) => hit.entryId === postSnapshotId), false);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: conversationQuery, limit: 10, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("mixed conversation search complete"),
		]);
		await session.prompt("search mixed assistant text");
		const mixedConversation = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(mixedConversation);
		assert.ok((mixedConversation.message as { details: { items: Array<{ entryId: string }> } }).details.items.some((hit) => hit.entryId === mixedId));

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: thinkingQuery, limit: 10, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("thinking scope search complete"),
		]);
		await session.prompt("search conversation text only");
		const thinkingResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(thinkingResult);
		assert.deepEqual((thinkingResult.message as { details: { items: unknown[] } }).details.items, []);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: toolQuery, limit: 10, filter: { kinds: ["tool_call","tool_result"] } })),
			fauxAssistantMessage("tools scope search complete"),
		]);
		await session.prompt("search ordinary tool evidence");
		const toolsResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(toolsResult);
		const toolsDetails = (toolsResult.message as { details: { filter: { kinds: string[] }; items: Array<{ entryId: string }> } }).details;
		assert.deepEqual(toolsDetails.filter.kinds, ["tool_call", "tool_result"]);
		assert.ok(toolsDetails.items.some((hit) => hit.entryId === mixedId));
		assert.ok(toolsDetails.items.some((hit) => hit.entryId === resultId));
		assert.equal(toolsDetails.items.some((hit) => hit.entryId === olderId), false);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: maintenanceQuery, limit: 10, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("conversation maintenance search complete"),
		]);
		await session.prompt("exclude maintenance tool echo from conversation");
		const conversationMaintenance = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(conversationMaintenance);
		assert.deepEqual((conversationMaintenance.message as { details: { items: unknown[] } }).details.items, []);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: maintenanceQuery, limit: 10, filter: { includeMaintenance: true } })),
			fauxAssistantMessage("all scope search complete"),
		]);
		await session.prompt("search all maintenance evidence");
		const allResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(allResult);
		const allDetails = (allResult.message as { details: { filter: { includeMaintenance: boolean }; items: Array<{ entryId: string }> } }).details;
		assert.equal(allDetails.filter.includeMaintenance, true);
		assert.ok(allDetails.items.some((hit) => hit.entryId === mixedId));
		assert.ok(allDetails.items.some((hit) => hit.entryId === maintenanceId));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_search shares a bounded snippet budget across matching entries", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const query = "snippet-budget-sentinel";
		for (let index = 0; index < 3; index++) {
			sessionManager.appendMessage({ role: "user", content: `${query}-${index} ${"x".repeat(3_000)}`, timestamp: Date.now() });
		}
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query, limit: 3, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("bounded snippet search complete"),
		]);
		await session.prompt("find the bounded snippet entries");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(result);
		const items = (result.message as { details: { items: Array<{ snippet: string; matchOffset: number }> } }).details.items;
		assert.equal(items.length, 3);
		assert.ok(items.every((hit) => hit.snippet.length <= 300));
		assert.ok(items.every((hit) => hit.matchOffset >= 0));

		const longQuery = "q".repeat(3_000);
		sessionManager.appendMessage({ role: "user", content: `${longQuery}-long-query-entry`, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: longQuery, limit: 1, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("long query snippet search complete"),
		]);
		await session.prompt("find the long query entry");
		const longResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(longResult);
		const longHits = (longResult.message as { details: { items: Array<{ snippet: string }> } }).details.items;
		assert.equal(longHits.length, 1);
		assert.ok(longHits[0].snippet.length <= 300);

		const utf8Query = "é".repeat(4_090);
		const olderUtf8Id = sessionManager.appendMessage({ role: "user", content: `${utf8Query} utf8-older`, timestamp: Date.now() });
		const newerUtf8Id = sessionManager.appendMessage({ role: "user", content: `${utf8Query} utf8-newer`, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: utf8Query, limit: 1, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("long UTF-8 query first page complete"),
		]);
		await session.prompt("find the near-limit UTF-8 query entries");
		const utf8First = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(utf8First);
		const utf8FirstDetails = (utf8First.message as { details: { items: Array<{ entryId: string }>; nextCursor: string | null } }).details;
		assert.equal(utf8FirstDetails.items[0].entryId, newerUtf8Id);
		assert.ok(utf8FirstDetails.nextCursor);
		assert.ok(utf8FirstDetails.nextCursor.length <= 1_024);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: utf8Query, cursor: utf8FirstDetails.nextCursor, limit: 1, filter: { kinds: ["user_input","assistant_text"] } })),
			fauxAssistantMessage("long UTF-8 query continuation complete"),
		]);
		await session.prompt("continue the near-limit UTF-8 query page");
		const utf8Second = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(utf8Second);
		const utf8SecondDetails = (utf8Second.message as { details: { items: Array<{ entryId: string }> } }).details;
		assert.equal(utf8SecondDetails.items[0].entryId, olderUtf8Id);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_search keeps a window-filtered cursor stable across a later compaction", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false, [], 2_000);
	try {
		const query = "window-page-sentinel";
		sessionManager.appendMessage({ role: "user", content: "seed before the first compaction", timestamp: Date.now() });
		sessionManager.appendMessage({ role: "user", content: "f".repeat(10_000), timestamp: Date.now() });
		await session.compact();
		const firstCompaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(firstCompaction);
		const firstWindowId = (firstCompaction.details as { windowId: string }).windowId;
		const olderId = sessionManager.appendMessage({ role: "user", content: `${query} older`, timestamp: Date.now() });
		const newerId = sessionManager.appendMessage({ role: "user", content: `${query} newer `.repeat(40), timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query, limit: 1, filter: { kinds: ["user_input","assistant_text"], windowIds: [firstWindowId] } })),
			fauxAssistantMessage("first page complete"),
		]);
		await session.prompt("lookup the captured window page");
		const first = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(first);
		const firstDetails = (first.message as { details: { items: Array<{ entryId: string; windowId: string }>; nextCursor: string | null } }).details;
		assert.equal(firstDetails.items[0].entryId, newerId);
		assert.ok(firstDetails.nextCursor);

		sessionManager.appendMessage({ role: "user", content: "post-page work", timestamp: Date.now() });
		await session.compact();
		const laterCompaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(laterCompaction);
		const branchAfterCompaction = sessionManager.getBranch();
		const olderIndex = branchAfterCompaction.findIndex((entry) => entry.id === olderId);
		const laterCompactionIndex = branchAfterCompaction.findIndex((entry) => entry.id === laterCompaction.id);
		const laterFirstKeptIndex = branchAfterCompaction.findIndex((entry) => entry.id === laterCompaction.firstKeptEntryId);
		assert.ok(olderIndex >= laterFirstKeptIndex && olderIndex < laterCompactionIndex, "the later compaction must retain the pending older match");

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query, cursor: firstDetails.nextCursor, limit: 10, filter: { kinds: ["user_input","assistant_text"], windowIds: [firstDetails.items[0].windowId] } })),
			fauxAssistantMessage("second page complete"),
		]);
		await session.prompt("continue the captured history page");
		const second = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(second);
		const secondDetails = (second.message as { details: { items: Array<{ entryId: string; windowId: string }> } }).details;
		assert.ok(secondDetails.items.some((hit) => hit.entryId === olderId));
		assert.ok(secondDetails.items.every((hit) => hit.windowId === firstDetails.items[0].windowId));

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query, cursor: firstDetails.nextCursor, limit: 10, filter: { kinds: ["user_input","assistant_text"], windowIds: [`${firstWindowId}-mismatch`] } })),
			fauxAssistantMessage("mismatched cursor rejected"),
		]);
		await session.prompt("reject the mismatched captured history page");
		const mismatched = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(mismatched);
		assert.equal((mismatched.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((mismatched.message as { content: unknown }).content), /history_cursor_invalid/);
		assert.match(JSON.stringify((mismatched.message as { content: unknown }).content), /Rerun history_search/);

		const assertInvalidCursor = async (parameters: JsonObject, prompt: string): Promise<void> => {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("history_search", parameters)),
				fauxAssistantMessage("invalid cursor case complete"),
			]);
			await session.prompt(prompt);
			const result = messageEntries(sessionManager.getBranch())
				.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
				.at(-1);
			assert.ok(result);
			assert.equal((result.message as { isError: boolean }).isError, true);
			const text = toolResultText(result);
			const prefix = "history_cursor_invalid: ";
			assert.ok(text.startsWith(prefix));
			const details = JSON.parse(text.slice(prefix.length)) as { code: string; restart: string };
			assert.equal(details.code, "history_cursor_invalid");
			assert.match(details.restart, /Rerun history_search/);
		};

		await assertInvalidCursor(
			{ query: `${query}-query-mismatch`, cursor: firstDetails.nextCursor, limit: 10, filter: { kinds: ["user_input","assistant_text"], windowIds: [firstWindowId] } },
			"reject the query-mismatched captured history page",
		);
		await assertInvalidCursor(
			{ query, cursor: firstDetails.nextCursor, limit: 10, filter: { includeMaintenance: true, windowIds: [firstWindowId] } },
			"reject the scope-mismatched captured history page",
		);
		await assertInvalidCursor(
			{ query, cursor: firstDetails.nextCursor, limit: 10, filter: { kinds: ["user_input"], windowIds: [firstWindowId] } },
			"reject the role-mismatched captured history page",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_read renders only the requested entry body", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, session, sessionManager } = await createFixture(false);
	try {
		const targetId = sessionManager.appendMessage({ role: "user", content: "direct-read-target", timestamp: Date.now() });
		sessionManager.appendMessage({ role: "user", content: "unrelated-body-must-not-be-rendered", timestamp: Date.now() });
		const guardedBranch = sessionManager.getBranch().map((entry) => {
			if (entry.id === targetId || entry.type !== "message") return entry;
			const guarded = { ...entry };
			Object.defineProperty(guarded, "message", {
				configurable: true,
				get() {
					throw new Error("unrelated body rendered");
				},
			});
			return guarded;
		});
		const manager = sessionManager as unknown as { getBranch: () => SessionEntry[] };
		const originalGetBranch = manager.getBranch.bind(sessionManager);
		manager.getBranch = () => guardedBranch;
		try {
			const historyRead = session.getToolDefinition("history_read");
			assert.ok(historyRead);
			const result = await historyRead.execute("direct-read", { entryId: targetId, offset: 0, length: 128 }, undefined, undefined, { sessionManager } as never);
			assert.match(JSON.stringify(result.content), /direct-read-target/);
		} finally {
			manager.getBranch = originalGetBranch;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_search renders only bodies in the selected scope", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, session, sessionManager } = await createFixture(false);
	try {
		const conversationQuery = "guarded-conversation-body-sentinel";
		const toolsQuery = "guarded-tools-result-sentinel";
		const conversationTargetId = sessionManager.appendMessage({ role: "user", content: conversationQuery, timestamp: Date.now() });
		const excludedToolResultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "guarded-excluded-call",
			toolName: "ordinary_tool",
			content: [{ type: "text", text: "excluded ordinary tool result body" }],
			isError: false,
			timestamp: Date.now(),
		});
		const assistantId = sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "assistant conversation body" },
				fauxThinking("assistant thinking body must not be read"),
				fauxToolCall("ordinary_tool", { secret: "assistant tool arguments must not be read" }, { id: "guarded-assistant-call" }),
			]),
		);
		const toolsTargetId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "guarded-target-call",
			toolName: "ordinary_tool",
			content: [{ type: "text", text: toolsQuery }],
			isError: false,
			timestamp: Date.now(),
		});
		const unrelatedConversationId = sessionManager.appendMessage({ role: "user", content: "unrelated conversation body", timestamp: Date.now() });
		const branch = sessionManager.getBranch();
		const guardContent = (entry: SessionEntry, message = "excluded message body rendered"): SessionEntry => {
			if (entry.type !== "message") return entry;
			const guardedMessage = { ...(entry.message as any) } as Record<string, unknown>;
			Object.defineProperty(guardedMessage, "content", {
				configurable: true,
				get() {
					throw new Error(message);
				},
			});
			return { ...entry, message: guardedMessage } as unknown as SessionEntry;
		};
		const guardAssistantBlocks = (entry: SessionEntry): SessionEntry => {
			if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return entry;
			const content = entry.message.content.map((block: any) => {
				if (block?.type !== "thinking" && block?.type !== "toolCall") return block;
				const guardedBlock = { ...block } as Record<string, unknown>;
				const property = block.type === "thinking" ? "thinking" : "arguments";
				Object.defineProperty(guardedBlock, property, {
					configurable: true,
					get() {
						throw new Error(`excluded assistant ${property} rendered`);
					},
				});
				return guardedBlock;
			});
			return { ...entry, message: { ...entry.message, content } } as SessionEntry;
		};
		const conversationGuardedBranch = branch.map((entry) => {
			if (entry.id === excludedToolResultId) return guardContent(entry, "excluded ordinary tool result body rendered");
			if (entry.id === assistantId) return guardAssistantBlocks(entry);
			return entry;
		});
		const toolsGuardedBranch = branch.map((entry) => entry.id === unrelatedConversationId ? guardContent(entry, "unrelated conversation body rendered") : entry);
		const manager = sessionManager as unknown as { getBranch: () => SessionEntry[] };
		const originalGetBranch = manager.getBranch.bind(sessionManager);
		const historySearch = session.getToolDefinition("history_search");
		assert.ok(historySearch);
		try {
			manager.getBranch = () => conversationGuardedBranch;
			const conversationResult = await historySearch.execute(
				"guarded-conversation",
				{ query: conversationQuery, filter: { kinds: ["user_input","assistant_text"] } },
				undefined,
				undefined,
				{ sessionManager } as never,
			);
			const conversationHits = (conversationResult as { details: { items: Array<{ entryId: string }> } }).details.items;
			assert.deepEqual(conversationHits.map((hit) => hit.entryId), [conversationTargetId]);

			manager.getBranch = () => toolsGuardedBranch;
			const toolsResult = await historySearch.execute(
				"guarded-tools",
				{ query: toolsQuery, filter: { kinds: ["tool_call","tool_result"] } },
				undefined,
				undefined,
				{ sessionManager } as never,
			);
			const toolsHits = (toolsResult as { details: { items: Array<{ entryId: string }> } }).details.items;
			assert.deepEqual(toolsHits.map((hit) => hit.entryId), [toolsTargetId]);
		} finally {
			manager.getBranch = originalGetBranch;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clipped older entries do not consume the latest short user reference", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "30000";
	const { root, faux, session, sessionManager } = await createFixture(false, [], 64, {
		contextWindow: 32_000,
		maxTokens: 256,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		const fixed = conservativeContextTokens({ messages: [], systemPrompt: session.systemPrompt }, session, 0);
		process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = String(32_000 - fixed - 512);
		faux.setResponses([fauxAssistantMessage("reference allocation seed"), fauxAssistantMessage("old reference entry recorded")]);
		await session.prompt("reference allocation seed");
		await session.prompt(`old-reference-entry:${"o".repeat(8_000)}`);
		const oldEntry = sessionManager.getBranch().find(
			(entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("old-reference-entry:"),
		);
		assert.ok(oldEntry);
		let resumedContext: Context | undefined;
		const latestText = "short-latest-user-sentinel";
		faux.setResponses([(context) => {
			resumedContext = context;
			return fauxAssistantMessage("reference allocation complete");
		}]);
		await session.prompt(latestText);
		assert.ok(resumedContext);
		const capturedContext = resumedContext;
		const model = session.model;
		assert.ok(model);
		const latestEntry = sessionManager.getBranch().find(
			(entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(latestText),
		);
		assert.ok(latestEntry);
		const latestMessage = capturedContext.messages.find(
			(message) => message.role === "user" && JSON.stringify(message.content).includes(latestText),
		);
		assert.ok(latestMessage);
		const latestContent = JSON.stringify(latestMessage.content);
		assert.match(latestContent, new RegExp(latestText));
		assert.match(latestContent, new RegExp(`pi://entry/${latestEntry.id}`));
		assert.match(JSON.stringify(capturedContext.messages), new RegExp(`old-reference-entry.*pi://entry/${oldEntry.id}`));
		assert.ok(conservativeContextTokens(capturedContext, session, Number(process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS)) <= model.contextWindow);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
	}
});

test("history_read contentIndex returns one normalized image at its original content index", { timeout: 10_000 }, async () => {
	const fixture = await createFixture(true);
	try {
		const { faux, session, sessionManager } = fixture;
		const sourceContent = [
			{ type: "text" as const, text: "image source prefix" },
			{ type: "text" as const, text: "image source gap" },
			{ type: "text" as const, text: "image source third block" },
			{ type: "image" as const, mimeType: "image/jpeg", data: BLUE_3X2_PNG },
		];
		const sourceEntryId = sessionManager.appendMessage({ role: "user", content: sourceContent, timestamp: Date.now() });
		let providerContext: Context | undefined;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, contentIndex: 3, view: "image" }), { stopReason: "toolUse" }),
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("image selected");
			},
		]);
		await session.prompt("read the selected image");
		assert.ok(providerContext);
		const result = messageEntries(sessionManager.getBranch()).filter(
			(entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read",
		).at(-1);
		assert.ok(result);
		const resultMessage = result.message as { content: unknown; details?: Record<string, unknown> };
		assert.ok(Array.isArray(resultMessage.content));
		const resultImage = resultMessage.content.find((block) => block && typeof block === "object" && (block as { type?: string }).type === "image") as { type: string; mimeType: string; data: string } | undefined;
		assert.ok(resultImage);
		assert.equal(resultImage.mimeType, "image/png");
		assert.equal(resultMessage.details?.contentIndex, 3);
		assert.equal(resultMessage.details?.reference, "pi://entry/" + sourceEntryId + "/content/3");
		assert.equal(resultMessage.details?.width, 3);
		assert.equal(resultMessage.details?.height, 2);
		const providerToolResult = providerContext.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === (result.message as { toolCallId: string }).toolCallId,
		);
		assert.ok(providerToolResult);
		assert.ok(Array.isArray(providerToolResult.content));
		assert.equal(providerToolResult.content.filter((block) => block.type === "image").length, 1);
		const sourceEntry = sessionManager.getEntry(sourceEntryId);
		assert.ok(sourceEntry?.type === "message");
		assert.deepEqual((sourceEntry.message as { content: unknown }).content, sourceContent);
		const resizedContent = [{ type: "image" as const, mimeType: "image/png", data: highEntropyPng(2_500, 10) }];
		const resizedEntryId = sessionManager.appendMessage({ role: "user", content: resizedContent, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: resizedEntryId, contentIndex: 0, view: "image" })),
			fauxAssistantMessage("resized image complete"),
		]);
		await session.prompt("read resized image");
		const resizedResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(resizedResult);
		const resizedDetails = (resizedResult.message as { details: { width: number; height: number; originalWidth: number; originalHeight: number; wasResized: boolean; contentIndex: number } }).details;
		assert.equal(resizedDetails.contentIndex, 0);
		assert.equal(resizedDetails.originalWidth, 2_500);
		assert.equal(resizedDetails.originalHeight, 10);
		assert.equal(resizedDetails.width, 2_000);
		assert.equal(resizedDetails.height, 8);
		assert.equal(resizedDetails.wasResized, true);
		assert.deepEqual((sessionManager.getEntry(resizedEntryId) as { type: "message"; message: { content: unknown } }).message.content, resizedContent);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("history_read image resolves a custom-message payload reference", { timeout: 15_000 }, async () => {
	const fixture = await createFixture(false);
	try {
		const { faux, session, sessionManager } = fixture;
		const customContent = [
			{ type: "text" as const, text: "custom image prefix" },
			{ type: "image" as const, mimeType: "image/jpeg", data: BLUE_3X2_PNG },
			{ type: "text" as const, text: "custom image suffix" },
		];
		const customEntryId = sessionManager.appendCustomMessageEntry("test/custom-image", customContent, false, { source: "fixture" });
		let providerContext: Context | undefined;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: customEntryId, contentIndex: 1, view: "image" })),
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("custom image read complete");
			},
		]);
		await session.prompt("read the custom-message image");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(result);
		const resultMessage = result.message as { content: unknown; details: { entryId: string; contentIndex: number; reference: string; role: string } };
		assert.equal(resultMessage.details.entryId, customEntryId);
		assert.equal(resultMessage.details.contentIndex, 1);
		assert.equal(resultMessage.details.reference, "pi://entry/" + customEntryId + "/content/1");
		assert.equal(resultMessage.details.role, "custom_message");
		assert.ok(Array.isArray(resultMessage.content));
		assert.equal(resultMessage.content.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "image").length, 1);
		assert.ok(providerContext);
		const providerResult = providerContext.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === (result.message as { toolCallId: string }).toolCallId,
		);
		assert.ok(providerResult);
		assert.ok(Array.isArray(providerResult.content));
		assert.equal(providerResult.content.filter((block: { type?: string }) => block.type === "image").length, 1);
		const customEntry = sessionManager.getEntry(customEntryId);
		assert.ok(customEntry?.type === "custom_message");
		assert.deepEqual(customEntry.content, customContent);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("history_read image reports an off-branch source reference", { timeout: 15_000 }, async () => {
	const fixture = await createFixture(false);
	try {
		const { faux, session, sessionManager } = fixture;
		const sourceEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: RED_2X2_PNG }],
			timestamp: Date.now(),
		});
		sessionManager.resetLeaf();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, contentIndex: 0, view: "image" })),
			fauxAssistantMessage("off-branch image validation complete"),
		]);
		await session.prompt("read an image from another branch");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(result);
		assert.equal((result.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((result.message as { content: unknown }).content), new RegExp("pi://entry/" + sourceEntryId + "/content/0"));
		assert.equal(JSON.stringify((result.message as { content: unknown }).content).includes('"type":"image"'), false);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("history_read normalizes high-entropy encoded images within the public byte cap", { timeout: 30_000 }, async () => {
	const fixture = await createFixture(true);
	try {
		const { faux, session, sessionManager } = fixture;
		const sourceData = highEntropyPng(1_200, 1_200);
		assert.ok(sourceData.length > MAX_HISTORY_IMAGE_BASE64_BYTES);
		const sourceContent = [{ type: "image" as const, mimeType: "image/png", data: sourceData }];
		const sourceEntryId = sessionManager.appendMessage({ role: "user", content: sourceContent, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, contentIndex: 0, view: "image" })),
			fauxAssistantMessage("high entropy image normalized"),
		]);
		await session.prompt("normalize a high entropy image");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(result);
		const resultMessage = result.message as { content: unknown; details: { normalizedEncodedBytes: number; width: number; height: number } };
		assert.ok(Array.isArray(resultMessage.content));
		assert.ok(resultMessage.content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "image"), JSON.stringify(resultMessage.content).slice(0, 400));
		assert.ok(resultMessage.details.normalizedEncodedBytes < MAX_HISTORY_IMAGE_BASE64_BYTES);
		assert.ok(resultMessage.details.width <= 2_000 && resultMessage.details.height <= 2_000);
		const sourceEntry = sessionManager.getEntry(sourceEntryId);
		assert.ok(sourceEntry?.type === "message");
		assert.equal((sourceEntry.message as { content: Array<{ data?: string }> }).content[0].data, sourceData);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("history_read image errors remain explicit and source-bearing", { timeout: 15_000 }, async () => {
	const previousReadLimit = process.env.LEDGER_CONTEXT_READ_TOKENS;
	const fixture = await createFixture(false);
	try {
		const { faux, session, sessionManager } = fixture;
		const validContent = [
			{ type: "text" as const, text: "valid image prefix" },
			{ type: "text" as const, text: "valid image gap" },
			{ type: "image" as const, mimeType: "image/png", data: RED_2X2_PNG },
		];
		const validEntryId = sessionManager.appendMessage({ role: "user", content: validContent, timestamp: Date.now() });
		const invalidContent = [
			{ type: "text" as const, text: "invalid image prefix" },
			{ type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" },
		];
		const invalidEntryId = sessionManager.appendMessage({ role: "user", content: invalidContent, timestamp: Date.now() });
		const runRead = async (params: JsonObject, prompt: string) => {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("history_read", params)),
				fauxAssistantMessage("image validation complete"),
			]);
			await session.prompt(prompt);
			return messageEntries(sessionManager.getBranch())
				.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
				.at(-1);
		};
		const conflict = await runRead({ entryId: validEntryId, view: "image", contentIndex: 2, offset: 0 }, "read image with conflicting text offset");
		assert.ok(conflict);
		assert.equal((conflict.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((conflict.message as { content: unknown }).content), new RegExp("pi://entry/" + validEntryId + "/content/2"));
		assert.equal(JSON.stringify((conflict.message as { content: unknown }).content).includes('"type":"image"'), false);
		const invalid = await runRead({ entryId: invalidEntryId, view: "image", contentIndex: 1 }, "read invalid image bytes");
		assert.ok(invalid);
		assert.equal((invalid.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((invalid.message as { content: unknown }).content), new RegExp("pi://entry/" + invalidEntryId + "/content/1"));
		assert.equal(JSON.stringify((invalid.message as { content: unknown }).content).includes('"type":"image"'), false);
		const missing = await runRead({ entryId: validEntryId, view: "image", contentIndex: 99 }, "read missing image block");
		assert.ok(missing);
		assert.equal((missing.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((missing.message as { content: unknown }).content), new RegExp("pi://entry/" + validEntryId + "/content/99"));
		process.env.LEDGER_CONTEXT_READ_TOKENS = "256";
		const readLimited = await runRead({ entryId: validEntryId, view: "image", contentIndex: 2 }, "read image over the history output budget");
		assert.ok(readLimited);
		assert.equal((readLimited.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((readLimited.message as { content: unknown }).content), new RegExp("pi://entry/" + validEntryId + "/content/2"));
		assert.equal(JSON.stringify((readLimited.message as { content: unknown }).content).includes('"type":"image"'), false);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousReadLimit === undefined) delete process.env.LEDGER_CONTEXT_READ_TOKENS;
		else process.env.LEDGER_CONTEXT_READ_TOKENS = previousReadLimit;
	}
	const textFixture = await createFixture(false, [], 70, { modelInput: ["text"] });
	try {
		const { faux, session, sessionManager } = textFixture;
		const sourceContent = [{ type: "image" as const, mimeType: "image/png", data: RED_2X2_PNG }];
		const sourceEntryId = sessionManager.appendMessage({ role: "user", content: sourceContent, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, contentIndex: 0, view: "image" })),
			fauxAssistantMessage("vision capability validation complete"),
		]);
		await session.prompt("read image without vision input");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(result);
		assert.equal((result.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((result.message as { content: unknown }).content), new RegExp("pi://entry/" + sourceEntryId + "/content/0"));
		assert.equal(JSON.stringify((result.message as { content: unknown }).content).includes('"type":"image"'), false);
	} finally {
		rmSync(textFixture.root, { recursive: true, force: true });
	}
});

test("history_read image results use the global budget with complete mixed tool protocol", { timeout: 15_000 }, async (t) => {
	use4kRecoveryBudgets(t);
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "512";
	const largePayload = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "large_payload",
			label: "Large payload",
			description: "Returns a large ordinary result for mixed image budget coverage.",
			parameters: Type.Object({}),
			executionMode: "parallel",
			execute: async () => ({ content: [{ type: "text", text: "mixed-large-result:" + "m".repeat(60_000) }], details: {} }),
		});
	};
	const fixture = await createFixture(false, [largePayload], 4_096, {
		contextWindow: 4_096,
		maxTokens: 128,
		reserveTokens: 0,
		compactionEnabled: false,
		extraToolNames: ["large_payload"],
	});
	try {
		const { faux, session, sessionManager } = fixture;
		const fixedTokens = conservativeContextTokens({ messages: [], systemPrompt: session.systemPrompt }, session, 512);
		await session.setModel({ ...faux.getModel(), contextWindow: fixedTokens + 2100 });
		const redEntryId = sessionManager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: RED_2X2_PNG }], timestamp: Date.now() });
		const blueEntryId = sessionManager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: BLUE_3X2_PNG }], timestamp: Date.now() });
		let providerContext: Context | undefined;
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("history_read", { entryId: redEntryId, contentIndex: 0, view: "image" }, { id: "mixed-red-call" }),
				fauxToolCall("history_read", { entryId: blueEntryId, contentIndex: 0, view: "image" }, { id: "mixed-blue-call" }),
				fauxToolCall("large_payload", {}, { id: "mixed-large-call" }),
			], { stopReason: "toolUse" }),
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("mixed image budget complete");
			},
		]);
		const latestUserText = "latest mixed image user: " + "u".repeat(1_200);
		await session.prompt(latestUserText);
		assert.ok(providerContext);
		const messages = providerContext.messages as Array<{ role?: string; toolCallId?: string; content?: unknown; isError?: boolean }>;
		const blocks = (message: { content?: unknown }): Array<{ type?: string }> => Array.isArray(message.content) ? message.content as Array<{ type?: string }> : [];
		const assistantIndex = messages.findIndex(
			(message) => message.role === "assistant" && blocks(message).some((block) => block.type === "toolCall"),
		);
		assert.ok(assistantIndex >= 0);
		const latestUserMessage = messages.find((message) => message.role === "user" && JSON.stringify(message.content).includes("latest mixed image user"));
		assert.ok(latestUserMessage);
		assert.match(JSON.stringify(latestUserMessage.content), /latest mixed image user/);
		const resultMessages = ["mixed-red-call", "mixed-blue-call", "mixed-large-call"].map((toolCallId) => {
			const result = messages.find((message, index) => index > assistantIndex && message.role === "toolResult" && message.toolCallId === toolCallId);
			assert.ok(result);
			return result;
		});
		const imageResults = resultMessages.filter((message) => blocks(message).some((block) => block.type === "image"));
		assert.equal(imageResults.length, 1, "the global budget should admit one image and retain an explicit error for the other");
		if (imageResults.length === 1) {
			const omitted = resultMessages.find((message) => !blocks(message).some((block) => block.type === "image") && message.toolCallId !== "mixed-large-call");
			assert.ok(omitted);
			assert.equal(omitted.isError, true);
			assert.match(JSON.stringify(omitted.content), /pi:\/\/entry\/.*\/content\/0/);
		}
		const largeResultMessage = resultMessages.find((message) => message.toolCallId === "mixed-large-call");
		assert.ok(largeResultMessage);
		const sourceResult = messageEntries(sessionManager.getBranch()).find((entry) => entry.message.role === "toolResult" && entry.message.toolCallId === "mixed-large-call");
		assert.ok(sourceResult);
		assert.match(toolResultText(sourceResult), /mixed-large-result/);
		assert.ok(JSON.stringify(largeResultMessage.content).includes("mixed-large-result") || JSON.stringify(largeResultMessage.content).includes(`pi://entry/${sourceResult.id}`));
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
	}
});

test("history_read image capacity aborts when the mandatory minimum cannot fit", { timeout: 15_000 }, async () => {
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "1";
	let contextSignalAborted = false;
	const observeContext = (pi: ExtensionAPI): void => {
		pi.on("context", (_event, ctx) => {
			contextSignalAborted = ctx.signal?.aborted ?? false;
		});
	};
	const fixture = await createFixture(false, [observeContext], 4_096, {
		contextWindow: 1_536,
		maxTokens: 32,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		const { faux, session, sessionManager } = fixture;
		const fixedTokens = conservativeContextTokens({ messages: [], systemPrompt: session.systemPrompt }, session, 1);
		await session.setModel({ ...faux.getModel(), contextWindow: fixedTokens + 128 });
		const sourceEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: RED_2X2_PNG }],
			timestamp: Date.now(),
		});
		let providerCalls = 0;
		faux.setResponses([
			(context) => {
				providerCalls++;
				return fauxAssistantMessage(
					Array.from({ length: 5 }, (_value, index) => fauxToolCall("history_read", { entryId: sourceEntryId, contentIndex: 0, view: "image" }, { id: "capacity-image-call-" + index })),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				providerCalls++;
				return fauxAssistantMessage("unexpected image capacity continuation");
			},
		]);
		await session.prompt("exercise the image minimum capacity");
		assert.equal(providerCalls, 1, "the provider must stop before a request whose image error minimum cannot fit");
		assert.equal(contextSignalAborted, true);
		assert.equal(session.isStreaming, false);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
	}
});

test("history_read image remains in the immediate provider request across native compaction", { timeout: 15_000 }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	const previousTaskLimit = process.env.LEDGER_CONTEXT_TASK_TOKENS;
	const previousSoftReminder = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgentReminder = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "4096";
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "256";
	process.env.LEDGER_CONTEXT_TASK_TOKENS = "64";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "2";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "1";
	let firstToolStarted = () => {};
	const firstToolStartedPromise = new Promise<void>((resolve) => {
		firstToolStarted = resolve;
	});
	let releaseFirstTool = () => {};
	const firstToolReleased = new Promise<void>((resolve) => {
		releaseFirstTool = resolve;
	});
	let toolCalls = 0;
	const stagedTool = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "staged_result",
			label: "Staged result",
			description: "Returns a small first result and a large second result for image compaction coverage.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				toolCalls++;
				if (toolCalls === 1) {
					firstToolStarted();
					await firstToolReleased;
					return { content: [{ type: "text", text: "native-image-first-tool-result" }], details: {} };
				}
				return { content: [{ type: "text", text: "native-image-second-tool-result:" + "x".repeat(8_000) }], details: {} };
			},
		});
	};
	const fixture = await createFixture(true, [stagedTool], 4_000, {
		contextWindow: 8_192,
		maxTokens: 100,
		reserveTokens: 4_192,
		extraToolNames: ["staged_result"],
	});
	try {
		const { faux, session, sessionManager } = fixture;
		const sourceContent = [
			{ type: "text" as const, text: "native image source" },
			{ type: "text" as const, text: "native image gap" },
			{ type: "text" as const, text: "native image third" },
			{ type: "image" as const, mimeType: "image/png", data: RED_2X2_PNG },
		];
		const sourceEntryId = sessionManager.appendMessage({ role: "user", content: sourceContent, timestamp: Date.now() });
		await session.reload();
		const providerContexts: Context[] = [];
		faux.setResponses([
			fauxAssistantMessage("native image old seed:" + "a".repeat(4_000)),
			fauxAssistantMessage("native image recent seed:" + "b".repeat(4_000)),
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(fauxToolCall("staged_result", {}, { id: "native-image-first-call" }), { stopReason: "toolUse" });
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage([
					fauxToolCall("history_read", { entryId: sourceEntryId, contentIndex: 3, view: "image" }, { id: "native-history-image-call" }),
					fauxToolCall("staged_result", {}, { id: "native-image-second-call" }),
				], { stopReason: "toolUse" });
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("native image compaction resumed");
			},
		]);
		await session.prompt("native image old seed request");
		await session.prompt("native image recent seed request");
		const promptPromise = session.prompt("native image compaction request");
		await firstToolStartedPromise;
		await session.steer("native image steering correction");
		releaseFirstTool();
		await promptPromise;
		assert.equal(providerContexts.length, 3, "native compaction must make a provider request after the image result");
		const resumedContext = providerContexts.at(-1)!;
		const imageResult = resumedContext.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "native-history-image-call",
		);
		assert.ok(imageResult);
		assert.ok(Array.isArray(imageResult.content));
		assert.equal(imageResult.content.filter((block) => block.type === "image").length, 1);
		assert.match(JSON.stringify(imageResult.content), new RegExp("pi://entry/" + sourceEntryId + "/content/3"));
		const branch = sessionManager.getBranch();
		const persistedResult = messageEntries(branch).find(
			(entry) => entry.message.role === "toolResult" && entry.message.toolCallId === "native-history-image-call",
		);
		assert.ok(persistedResult);
		const persistedResultIndex = branch.findIndex((entry) => entry.id === persistedResult.id);
		const compaction = branch.filter((entry) => entry.type === "compaction").find((candidate) => {
			const candidateIndex = branch.findIndex((entry) => entry.id === candidate.id);
			const firstKeptIndex = branch.findIndex((entry) => entry.id === candidate.firstKeptEntryId);
			return candidateIndex > persistedResultIndex && firstKeptIndex >= 0 && persistedResultIndex >= firstKeptIndex;
		});
		assert.ok(compaction, "the image result must be inside a native retained range");
		const sourceEntry = sessionManager.getEntry(sourceEntryId);
		assert.ok(sourceEntry?.type === "message");
		assert.deepEqual((sourceEntry.message as { content: unknown }).content, sourceContent);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
		if (previousTaskLimit === undefined) delete process.env.LEDGER_CONTEXT_TASK_TOKENS;
		else process.env.LEDGER_CONTEXT_TASK_TOKENS = previousTaskLimit;
		if (previousSoftReminder === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoftReminder;
		if (previousUrgentReminder === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgentReminder;
	}
});

test("history payload references keep image data out of text results", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		faux.setResponses([fauxAssistantMessage("image recorded")]);
		await session.prompt("attach image evidence", {
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		});
		const imageUser = messageEntries(sessionManager.getBranch()).find((entry) => entry.message.role === "user");
		assert.ok(imageUser);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: imageUser.id })),
			fauxAssistantMessage("image history read complete"),
		]);
		await session.prompt("read image metadata");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(result);
		const message = result.message as { content: unknown; details: { payloads: Array<{ mimeType: string; bytes: number; reference: string }> } };
		assert.doesNotMatch(JSON.stringify(message.content), /aGVsbG8=/);
		assert.deepEqual(message.details.payloads[0], {
			kind: "image",
			mimeType: "image/png",
			bytes: 5,
			reference: `pi://entry/${imageUser.id}/content/1`,
		});
		assert.match(JSON.stringify(message.content), /image\/png/);
		assert.match(JSON.stringify(message.content), /pi:\/\/entry/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_read accepts safe offsets beyond one million on long entries", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const largeText = "x".repeat(1_100_000);
		const largeEntryId = sessionManager.appendMessage({ role: "user", content: largeText, timestamp: Date.now() });
		const offset = 1_050_000;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: largeEntryId, offset, length: 16 })),
			fauxAssistantMessage("large offset read complete"),
		]);
		await session.prompt("read a long history entry");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(result);
		const details = (result.message as { details: { entryId: string; offset: number; length: number; nextOffset: number | null } }).details;
		assert.equal(details.entryId, largeEntryId);
		assert.equal(details.offset, offset);
		assert.equal(details.length, 16);
		assert.equal(details.nextOffset, offset + 16);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("history_read nextOffset reconstructs the complete rendered entry", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const sourceText = "long-history-fragment-".repeat(400);
		const sourceEntryId = sessionManager.appendMessage({ role: "user", content: sourceText, timestamp: Date.now() });
		const expected = `[entry ${sourceEntryId}] user\n${sourceText}`;
		let offset = 0;
		let reconstructed = "";
		let finished = false;
		for (let page = 0; page < 40; page++) {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, offset, length: 600 })),
				fauxAssistantMessage(`history read page ${page + 1} complete`),
			]);
			await session.prompt(`read rendered entry page ${page + 1}`);
			const result = messageEntries(sessionManager.getBranch())
				.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
				.at(-1);
			assert.ok(result);
			const details = (result.message as { details: { entryId: string; offset: number; text: string; nextOffset: number | null; totalLength: number } }).details;
			assert.equal(details.entryId, sourceEntryId);
			assert.equal(details.offset, offset);
			reconstructed += details.text;
			assertHistoryOutputWithinTokens(result);
			if (details.nextOffset === null) {
				assert.equal(offset + details.text.length, details.totalLength);
				finished = true;
				break;
			}
			assert.equal(details.nextOffset, offset + details.text.length);
			offset = details.nextOffset;
		}
		assert.equal(finished, true);
		assert.equal(reconstructed, expected);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("compaction without an agent checkpoint accumulates deltas and preserves the last delta on failure", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { contextWindow: 16_000, maxTokens: 512, reserveTokens: 0 });
	try {
		faux.setResponses([fauxAssistantMessage("Verified result: operation completed once."), fauxAssistantMessage("Next: inspect the result.")]);
		await session.prompt("Goal: preserve the approved operation.");
		await session.prompt(`Latest constraint: keep Unicode 原文. ${"材料".repeat(30_000)}`);
		const ledger = "Goal: preserve the approved operation. Verified: operation completed once. Next: inspect the result. Skills: none. Earlier omitted evidence needs history_read.";
		ledgerFaux.setResponses([(context, options, _state, model) => {
			const systemPrompt = getCurrentSystemPrompt(context.messages);
			assert.equal(getCurrentTools(context.messages).length, 0);
			assert.equal(options?.timeoutMs, undefined, "ledger generation must not impose a waiting timeout");
			assert.equal(options?.maxRetries, 0);
			assert.match(systemPrompt, /bounded selection/);
			const input = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0) + textTokenEstimate(systemPrompt);
			assert.ok(input + (options?.maxTokens ?? 0) <= model.contextWindow);
			assert.match(JSON.stringify(context.messages), /Latest constraint/);
			assert.match(JSON.stringify(context.messages), /pi:\/\/entry\//);
			return fauxAssistantMessage(ledger);
		}]);
		await session.compact();
		assert.equal(ledgerFaux.state.callCount, 1);
		const checkpoint = latestCompaction(sessionManager.getBranch());
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
		assert.equal(generatedDelta(checkpoint).ledger, ledger);
		assert.equal((checkpoint.details as LedgerCompactionDetails).checkpointEntryId, null);
		assert.match(checkpoint.summary, /^inputRecordDetails: checkpoint=none; delta=this compaction entry$/m);
		assert.match(latestCompaction(sessionManager.getBranch()).summary, /operation completed once/);
		const reopened = SessionManager.open(sessionManager.getSessionFile()!);
		assert.equal(latestCompaction(reopened.getBranch()).id, checkpoint.id);
		const position = (checkpoint.details as LedgerCompactionDetails).snapshotPosition;
		const branch = sessionManager.getBranch();
		assert.equal(branch[position.branchDepth - 1].id, position.entryId);
		assert.equal(branch.findIndex((entry) => entry.id === checkpoint.id), position.branchDepth);
		faux.setResponses([fauxAssistantMessage("Verified: final result is now complete.")]);
		await session.prompt("Continue after the generated checkpoint.");
		ledgerFaux.setResponses([(context) => {
			assert.match(JSON.stringify(context.messages), /Previous cumulative delta.*operation completed once/);
			assert.match(JSON.stringify(context.messages), /final result is now complete/);
			assert.match(JSON.stringify(context.messages), /Preserve the final result/);
			return fauxAssistantMessage("Verified: final result complete. Preserve the original constraints.");
		}]);
		await session.compact("Preserve the final result");
		assert.equal(ledgerFaux.state.callCount, 2);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
		assert.match(latestCompaction(sessionManager.getBranch()).summary, /final result complete/);
		const refreshed = latestCompaction(sessionManager.getBranch());
		const refreshedRecord = JSON.stringify(generatedDelta(refreshed));
		faux.setResponses([fauxAssistantMessage("Later work after the refreshed checkpoint.")]);
		await session.prompt("Continue again.");
		ledgerFaux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "OpenAI API error (503): service unavailable" })));
		await session.compact();
		assert.equal(ledgerFaux.state.callCount, 5);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
		const fallback = latestCompaction(sessionManager.getBranch());
		assert.match(fallback.summary, /Delta update failed/);
		assert.deepEqual((fallback.details as LedgerCompactionDetails).delta, { status: "stale", sourceCompactionEntryId: refreshed.id });
		assert.equal(JSON.stringify(generatedDelta(refreshed)), refreshedRecord);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Responses tool images follow the complete result batch without changing source payloads", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, session, sessionManager } = await createFixture(false);
	try {
		const image = { type: "input_image", image_url: `data:image/png;base64,${RED_2X2_PNG}`, detail: "auto" };
		const payload = { model: "wire-test", input: [
			{ type: "function_call_output", call_id: "first", output: [{ type: "input_text", text: "evidence" }, image, image] },
			{ type: "function_call_output", call_id: "second", output: "plain result" },
			{ type: "custom_tool_call_output", call_id: "third", output: [image] },
			{ role: "assistant", content: "next message" },
		] };
		const original = structuredClone(payload);
		await session.setModel({ ...faux.getModel(), api: "openai-responses" });
		faux.setResponses([async (_context, options, _state, model) => {
			const rewritten = await options?.onPayload?.(payload, model);
			assert.ok(rewritten && typeof rewritten === "object" && "input" in rewritten && Array.isArray(rewritten.input));
			assert.deepEqual(payload, original);
			assert.deepEqual(rewritten.input.slice(0, 3).map((item) => item.call_id), ["first", "second", "third"]);
			assert.deepEqual(rewritten.input[0].output, [{ type: "input_text", text: "evidence" }]);
			assert.equal(rewritten.input[1].output, "plain result");
			assert.equal(typeof rewritten.input[2].output, "string");
			assert.deepEqual(rewritten.input.slice(3, 5).map((item) => item.role), ["user", "user"]);
			assert.deepEqual(rewritten.input[3].content.slice(1), [image, image]);
			assert.deepEqual(rewritten.input.at(-1), payload.input.at(-1));
			const repeated = await options?.onPayload?.(rewritten, model);
			assert.deepEqual(repeated ?? rewritten, rewritten, "normalization is idempotent");
			return fauxAssistantMessage("wire verified");
		}]);
		await session.prompt("Verify the outgoing payload.");
		assert.match(JSON.stringify(sessionManager.getBranch()), /wire verified/);
		await session.setModel(faux.getModel());
		faux.setResponses([async (_context, options, _state, model) => {
			const unchanged = await options?.onPayload?.(payload, model);
			assert.deepEqual(unchanged ?? payload, original, "other APIs retain their native image handling");
			return fauxAssistantMessage("other API verified");
		}]);
		await session.prompt("Verify the other API.");
		assert.match(JSON.stringify(sessionManager.getBranch()), /other API verified/);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("ledger refresh exhausts invalid outputs and transient errors, but stops on permanent failures", { timeout: 25_000 }, async () => {
	for (const { response, attempts } of [
		{ response: () => { throw new Error("generation request failed"); }, attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "OpenAI API error (400): invalid request; retry after fixing the 503 proxy configuration" }), attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 authentication failed" }), attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "Authentication failed: connection rejected" }), attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "403 unsupported parameter" }), attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 insufficient_quota" }), attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "aborted" }), attempts: 1 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "OpenAI API error (503): service unavailable" }), attempts: 3 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }), attempts: 3 },
		{ response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error: ECONNRESET" }), attempts: 3 },
		{ response: fauxAssistantMessage(""), attempts: 3 },
		{ response: fauxAssistantMessage("x".repeat(20_000)), attempts: 3 },
		{ response: fauxAssistantMessage("incomplete", { stopReason: "length" }), attempts: 3 },
		{ response: fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "must not execute" })), attempts: 3 },
	]) {
		const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
		try {
			faux.setResponses([fauxAssistantMessage("First result."), fauxAssistantMessage("Second result.")]);
			await session.prompt("First request.");
			await session.prompt(`Second request ${"x".repeat(800)}`);
			ledgerFaux.setResponses([response, response, response, fauxAssistantMessage("must never reach a fourth attempt")]);
			await session.compact();
			assert.equal(ledgerFaux.state.callCount, attempts);
			assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
			assert.match(latestCompaction(sessionManager.getBranch()).summary, /No agent checkpoint/);
			assert.match(latestCompaction(sessionManager.getBranch()).summary, /Delta update failed/);
		} finally {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("ledger refresh shares three attempts across transport and validation failures and saves success once", { timeout: TEST_TIMEOUT_MS }, async () => {
	let requests = 0;
	const throwNetworkError = (pi: ExtensionAPI) => pi.on("session_start", (_event, ctx) => {
		const complete = ctx.modelRegistry.complete.bind(ctx.modelRegistry);
		ctx.modelRegistry.complete = (...args) => {
			requests++;
			assert.equal(args[2]?.maxRetries, 0);
			assert.equal(args[2]?.timeoutMs, undefined);
			if (requests === 1) throw new TypeError("fetch failed");
			return complete(...args);
		};
	});
	const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [throwNetworkError], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
	try {
		faux.setResponses([fauxAssistantMessage("First result."), fauxAssistantMessage("Second result.")]);
		await session.prompt("First request.");
		await session.prompt(`Second request ${"x".repeat(800)}`);
		ledgerFaux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("Valid ledger on attempt three."), fauxAssistantMessage("must not run")]);
		await session.compact();
		assert.equal(requests, 3);
		assert.equal(ledgerFaux.state.callCount, 2);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
		assert.match(latestCompaction(sessionManager.getBranch()).summary, /Valid ledger on attempt three/);
		assert.equal(generatedDelta(latestCompaction(sessionManager.getBranch())).ledger, "Valid ledger on attempt three.");
		assert.equal(checkpointEntries(SessionManager.open(sessionManager.getSessionFile()!).getBranch()).length, 0);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing checkpoint generation cancellation and persistence failures cancel compaction", { timeout: TEST_TIMEOUT_MS }, async () => {
	for (const mode of ["cancel", "retry-cancel", "write-failure"] as const) {
		const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
		try {
			faux.setResponses([fauxAssistantMessage("First result."), fauxAssistantMessage("Second result.")]);
			await session.prompt("First request.");
			await session.prompt(`Second request ${"x".repeat(800)}`);
			const beforeGeneration = readFileSync(sessionManager.getSessionFile()!, "utf8");
			ledgerFaux.setResponses([() => {
				if (mode === "retry-cancel") {
					setTimeout(() => session.abortCompaction(), 20);
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
				}
				if (mode === "cancel") {
					session.abortCompaction();
					return new Promise<never>(() => {});
				}
				else {
					const log = sessionManager.getSessionFile()!;
					renameSync(log, `${log}.saved`);
					mkdirSync(log);
				}
				return fauxAssistantMessage("Goal: restore state. Next: verify original evidence. Skills: none.");
			}]);
			await assert.rejects(session.compact(), mode === "write-failure" ? /EISDIR/ : /Compaction cancelled/);
			assert.equal(ledgerFaux.state.callCount, 1);
			if (mode !== "write-failure") {
				assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
				assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
				assert.equal(readFileSync(sessionManager.getSessionFile()!, "utf8"), beforeGeneration);
			} else {
				await assert.rejects(session.compact(), /Already compacted|Compaction cancelled/);
				assert.equal(ledgerFaux.state.callCount, 1);
				assert.equal(checkpointEntries(SessionManager.open(`${sessionManager.getSessionFile()!}.saved`).getBranch()).length, 0);
				assert.equal(SessionManager.open(`${sessionManager.getSessionFile()!}.saved`).getBranch().filter((entry) => entry.type === "compaction").length, 0);
			}
		} finally {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("task and tail defaults scale with the model window and allow independent overrides", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTask = process.env.LEDGER_CONTEXT_TASK_TOKENS;
	const previousTail = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	try {
		for (const { window, taskLimit, tailOverride, keepsAnswer } of [
			{ window: 20_000, taskLimit: 1_000, tailOverride: undefined, keepsAnswer: false },
			{ window: 40_000, taskLimit: 2_000, tailOverride: undefined, keepsAnswer: true },
			{ window: 500_000, taskLimit: 25_000, tailOverride: undefined, keepsAnswer: true },
			{ window: 40_000, taskLimit: 256, tailOverride: 64, keepsAnswer: false },
		]) {
			delete process.env.LEDGER_CONTEXT_TASK_TOKENS;
			delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
			if (tailOverride !== undefined) {
				process.env.LEDGER_CONTEXT_TASK_TOKENS = String(taskLimit);
				process.env.LEDGER_CONTEXT_TAIL_TOKENS = String(tailOverride);
			}
			const { root, faux, session, sessionManager } = await createFixture(true, [], 1_500, {
				contextWindow: window, maxTokens: 512, reserveTokens: 0, compactionEnabled: false,
			});
			try {
				faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Preserve the current task and recent evidence." })), fauxAssistantMessage("Saved.")]);
				await session.prompt(`Earlier task: ${"a".repeat(12_000)}`);
				const answer = `tail-budget-probe:${"t".repeat(4_800)}`;
				faux.setResponses([fauxAssistantMessage(answer)]);
				await session.prompt(`Latest task: ${"u".repeat(Math.max(8_000, taskLimit * 8))}`);
				await session.compact();
				const summary = latestCompaction(sessionManager.getBranch()).summary;
				const task = summary.slice(summary.indexOf("<active>"), summary.indexOf("</latest>") + "</latest>".length);
				assert.match(task, /Latest task/);
				assert.ok(textTokenEstimate(task) <= taskLimit);
				assert.ok(textTokenEstimate(task) > taskLimit / 2, "the default budget must be available for a long request");
				let context: Context | undefined;
				faux.setResponses([(input) => { context = input; return fauxAssistantMessage("Resumed."); }]);
				await session.prompt("Continue.");
				assert.ok(context);
				assert.equal(JSON.stringify(context.messages).includes(answer), keepsAnswer);
				assert.ok(conservativeContextTokens(context, session, Math.min(window * 0.1, 16_384)) <= window);
			} finally {
				session.dispose();
				rmSync(root, { recursive: true, force: true });
			}
		}
	} finally {
		if (previousTask === undefined) delete process.env.LEDGER_CONTEXT_TASK_TOKENS;
		else process.env.LEDGER_CONTEXT_TASK_TOKENS = previousTask;
		if (previousTail === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTail;
	}
});

test("failed delta updates expose chronological ranges without changing the checkpoint", { timeout: TEST_TIMEOUT_MS }, async () => {
	const missing = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
	try {
		missing.faux.setResponses([fauxAssistantMessage("missing checkpoint first completion")]);
		await missing.session.prompt("missing checkpoint first request");
		missing.faux.setResponses([fauxAssistantMessage("missing checkpoint second completion")]);
		await missing.session.prompt(`missing checkpoint second request ${"x".repeat(800)}`);
		const branchBeforeCompaction = missing.sessionManager.getBranch();
		await missing.session.compact();
		const compaction = missing.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		const details = compaction.details as {
			checkpointEntryId: string | null;
			snapshotPosition: { entryId: string | null };
			sourceBranchTip: string | null;
		};
		assert.equal(details.checkpointEntryId, null);
		assert.equal(details.snapshotPosition.entryId, branchBeforeCompaction.at(-1)!.id);
		const range = JSON.parse(compaction.summary.match(/^eventsAfterDeltaInput: (.+)$/m)![1]);
		assert.equal(range.fromEntryId, branchBeforeCompaction[0].id);
		assert.equal(range.toEntryId, branchBeforeCompaction.at(-1)!.id);
		assert.equal(details.sourceBranchTip, branchBeforeCompaction.at(-1)!.id);
		assert.match(compaction.summary, /No agent checkpoint/);
	} finally {
		rmSync(missing.root, { recursive: true, force: true });
	}

	const stale = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
	try {
		stale.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Goal: stale checkpoint range recovery." })),
			fauxAssistantMessage("checkpoint persisted"),
		]);
		await stale.session.prompt("save the stale checkpoint request");
		const checkpoint = checkpointEntries(stale.sessionManager.getBranch()).at(-1);
		assert.ok(checkpoint);
		const checkpointData = checkpoint.data as { requestHistoryPosition: { entryId: string | null } };
		assert.ok(checkpointData.requestHistoryPosition.entryId);

		stale.faux.setResponses([fauxAssistantMessage("work after stale checkpoint")]);
		await stale.session.prompt(`record work after the checkpoint ${"y".repeat(800)}`);
		const branchBeforeCompaction = stale.sessionManager.getBranch();
		const positionIndex = branchBeforeCompaction.findIndex((entry) => entry.id === checkpointData.requestHistoryPosition.entryId);
		assert.ok(positionIndex >= 0);
		const expectedFrom = branchBeforeCompaction[positionIndex + 1]?.id ?? null;
		const expectedTo = branchBeforeCompaction.at(-1)!.id;
		await stale.session.compact();
		const compaction = stale.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		const details = compaction.details as {
			checkpointEntryId: string | null;
		};
		assert.equal(details.checkpointEntryId, checkpoint.id);
		const range = JSON.parse(compaction.summary.match(/^eventsAfterDeltaInput: (.+)$/m)![1]);
		assert.match(compaction.summary, new RegExp(`^inputRecordDetails: checkpoint=pi://entry/${checkpoint.id}; delta=none$`, "m"));
		assert.equal(range.fromEntryId, expectedFrom);
		assert.equal(range.toEntryId, expectedTo);
	} finally {
		rmSync(stale.root, { recursive: true, force: true });
	}
});

test("compaction tail budget applies to the complete retained suffix", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 1_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([fauxAssistantMessage("seed before retained tail")]);
		await session.prompt("seed the retained tail history");
		const prefixId = sessionManager.appendMessage({
			role: "user",
			content: `old-prefix:${"p".repeat(8_000)}`,
			timestamp: Date.now(),
		});
		const tailIds = Array.from({ length: 8 }, (_, index) =>
			sessionManager.appendMessage({
				role: "user",
				content: `retained-tail-unit-${index} ${"x".repeat(100)}`,
				timestamp: Date.now(),
			}),
		);
		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.notEqual(compaction.firstKeptEntryId, prefixId);
		const firstKeptTailIndex = tailIds.indexOf(compaction.firstKeptEntryId);
		assert.ok(firstKeptTailIndex > 0, "the native retained suffix must be reduced to the aggregate tail budget");
		const summaryTail = compaction.summary.slice(
			compaction.summary.indexOf("<recent-interaction>"),
			compaction.summary.indexOf("</recent-interaction>") + "</recent-interaction>".length,
		);
		assert.ok(estimateTokens({ role: "user", content: [{ type: "text", text: summaryTail }], timestamp: 0 }) <= 64);

		let resumedContext: Context | undefined;
		faux.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("retained suffix resumed");
			},
		]);
		await session.prompt("request after aggregate tail compaction");
		assert.ok(resumedContext);
		const tailMessages = resumedContext.messages.filter(
			(message) =>
				message.role === "user" &&
				/retained-tail-unit-\d/.test(JSON.stringify(message.content)) &&
				!/Ledger Context Recovery/.test(JSON.stringify(message.content)),
		);
		const tailTokens = tailMessages.reduce((total, message) => total + estimateTokens(message as never), 0);
		assert.ok(tailTokens <= 64, `retained provider suffix uses ${tailTokens} tokens`);
		assert.ok(tailMessages.length < tailIds.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("shrinking the retained tail budget drops oldest optional units", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "4096";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 1_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([fauxAssistantMessage("seed shrinking retained tail")]);
		await session.prompt("seed the shrinking retained tail");
		sessionManager.appendMessage({ role: "user", content: `shrink-retained-prefix:${"p".repeat(8_000)}`, timestamp: Date.now() });
		const retainedIds = Array.from({ length: 6 }, (_, index) =>
			sessionManager.appendMessage({ role: "user", content: `shrink-retained-${index}:${"r".repeat(100)}`, timestamp: Date.now() }),
		);
		await session.compact();
		process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";

		let resumedContext: Context | undefined;
		faux.setResponses([(context) => {
			resumedContext = context;
			return fauxAssistantMessage("shrinking retained tail resumed");
		}]);
		await session.prompt("resume after shrinking retained tail");
		assert.ok(resumedContext);
		const retainedMessages = resumedContext.messages.filter(
			(message) =>
				message.role === "user" &&
				/shrink-retained-\d/.test(JSON.stringify(message.content)) &&
				!/Ledger Context Recovery/.test(JSON.stringify(message.content)),
		);
		const retainedTokens = retainedMessages.reduce((total, message) => total + estimateTokens(message as never), 0);
		assert.ok(retainedTokens <= 64, `retained provider suffix uses ${retainedTokens} tokens`);
		assert.ok(retainedMessages.length < retainedIds.length);
		assert.ok(retainedMessages.some((message) => JSON.stringify(message.content).includes(`shrink-retained-${retainedIds.length - 1}`)));
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("global recovery pressure drops optional retained units before the latest request", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "2048";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 1_000, {
		contextWindow: 8_192,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		const prefixId = sessionManager.appendMessage({ role: "user", content: `global-retained-prefix:${"p".repeat(8_000)}`, timestamp: Date.now() });
		const retainedIds = Array.from({ length: 24 }, (_, index) =>
			sessionManager.appendMessage({ role: "user", content: `global-retained-${index}:${"r".repeat(120)}`, timestamp: Date.now() }),
		);
		const retainedRawTokens = retainedIds.reduce((total, id) => {
			const entry = sessionManager.getEntry(id);
			assert.ok(entry && entry.type === "message");
			return total + estimateTokens(entry.message as never);
		}, 0);
		assert.ok(retainedRawTokens <= 2_048, `retained entries must fit the configured tail budget (${retainedRawTokens} tokens)`);
		const windowId = `window:${sessionManager.getSessionId()}:global-pressure`;
		const compactionId = sessionManager.appendCompaction(
			"# Ledger Context Recovery\n<active-ledger>global-pressure</active-ledger>",
			retainedIds[0],
			8_000,
			{
				schemaVersion: 4,
				kind: "ledger-context",
				windowId,
				sourceWindowId: `window:${sessionManager.getSessionId()}:initial`,
				checkpointEntryId: null,
					sourceBranchTip: retainedIds.at(-1),
				firstKeptEntryId: retainedIds[0],
					snapshotPosition: { entryId: retainedIds.at(-1), branchDepth: sessionManager.getBranch().length },
					delta: { status: "empty" },
					recoveryContext: { task: "global-pressure", tail: "" },
			},
			true,
		);
		const compaction = sessionManager.getEntry(compactionId);
		assert.ok(compaction && compaction.type === "compaction");
		await session.reload();
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		let measuredContext: Context | undefined;
		faux.setResponses([(context) => { measuredContext = context; return fauxAssistantMessage("measured"); }]);
		await session.prompt("measure recovery projection");
		assert.ok(measuredContext);
		const summaryCost = conservativeContextTokens(
			{ messages: measuredContext.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("# Ledger Context Recovery")), systemPrompt: session.systemPrompt } as Context,
			session,
			0,
		);
		const globalNonSummaryBudget = 128;
		const model = session.model;
		assert.ok(model);
		const outputReserve = model.contextWindow - summaryCost - globalNonSummaryBudget;
		assert.ok(outputReserve > 0);
		process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = String(outputReserve);
		let resumedContext: Context | undefined;
		faux.setResponses([(context) => {
			resumedContext = context;
			return fauxAssistantMessage("global pressure resumed");
		}]);
		await session.prompt("global-pressure-latest-request");
		assert.ok(resumedContext);
		const capturedContext = resumedContext;
		const resumedModel = session.model;
		assert.ok(resumedModel);
		const retainedMessages = capturedContext.messages.filter(
			(message) => message.role === "user" && /global-retained-\d/.test(JSON.stringify(message.content)) && !/Ledger Context Recovery/.test(JSON.stringify(message.content)),
		);
		assert.ok(retainedMessages.length < retainedIds.length);
		const latestUserMessage = capturedContext.messages.find(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("global-pressure-latest-request"),
		);
		assert.ok(latestUserMessage);
		assert.match(JSON.stringify(latestUserMessage.content), /global-pressure-latest-request/);
		assert.ok(conservativeContextTokens(capturedContext, session, outputReserve) <= resumedModel.contextWindow);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
	}
});

test("native same-run compaction retains a persisted steering correction", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	const previousTaskLimit = process.env.LEDGER_CONTEXT_TASK_TOKENS;
	const previousSoftReminder = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const previousUrgentReminder = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "4096";
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "256";
	process.env.LEDGER_CONTEXT_TASK_TOKENS = "64";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "2";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "1";
	let firstToolStarted = () => {};
	const firstToolStartedPromise = new Promise<void>((resolve) => {
		firstToolStarted = resolve;
	});
	let releaseFirstTool = () => {};
	const firstToolReleased = new Promise<void>((resolve) => {
		releaseFirstTool = resolve;
	});
	let toolCalls = 0;
	const stagedTool = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "staged_result",
			label: "Staged result",
			description: "Returns a small first result and a larger second result for same-run compaction coverage.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				toolCalls++;
				if (toolCalls === 1) {
					firstToolStarted();
					await firstToolReleased;
					return { content: [{ type: "text", text: "same-run-first-tool-result" }], details: {} };
				}
				return { content: [{ type: "text", text: `same-run-second-tool-result:${"x".repeat(12_000)}` }], details: {} };
			},
		});
		pi.on("session_compact", () => {
			process.env.LEDGER_CONTEXT_TAIL_TOKENS = "256";
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [stagedTool], 4_000, {
		contextWindow: 8_192,
		maxTokens: 100,
		reserveTokens: 4_192,
		extraToolNames: ["staged_result"],
	});
	try {
		sessionManager.appendMessage({ role: "user", content: `same-run-discardable-history:${"d".repeat(400)}`, timestamp: Date.now() });
		const prefixId = sessionManager.appendMessage({ role: "user", content: `same-run-prefix:${"p".repeat(4_000)}`, timestamp: Date.now() });
		const optionalIds = Array.from({ length: 6 }, (_, index) =>
			sessionManager.appendMessage({ role: "user", content: `same-run-optional-${index}:${"o".repeat(120)}`, timestamp: Date.now() }),
		);
		const correctionText = `probe-retained-correction:${"c".repeat(700)}`;
		const providerContexts: Context[] = [];
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(fauxToolCall("staged_result", {}, { id: "same-run-first-call" }), { stopReason: "toolUse" });
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(fauxToolCall("staged_result", {}, { id: "same-run-second-call" }), { stopReason: "toolUse" });
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("same-run correction resumed");
			},
		]);
		let agentStarts = 0;
		session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts++;
		});
		const promptPromise = session.prompt("same-run native compaction start");
		await firstToolStartedPromise;
		await session.steer(correctionText);
		releaseFirstTool();
		await promptPromise;
		assert.equal(agentStarts, 1, "the retry after native compaction must remain in one agent run");
		assert.equal(providerContexts.length, 3, "the staged run must make two tool requests and one resumed request");
		const branch = sessionManager.getBranch();
		const correctionEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(correctionText));
		assert.ok(correctionEntry);
		const correctionIndex = branch.findIndex((entry) => entry.id === correctionEntry.id);
		const compaction = branch.filter((entry) => entry.type === "compaction").find((candidate) => {
			const candidateIndex = branch.findIndex((entry) => entry.id === candidate.id);
			const firstKeptIndex = branch.findIndex((entry) => entry.id === candidate.firstKeptEntryId);
			return correctionIndex >= firstKeptIndex && correctionIndex < candidateIndex;
		});
		assert.ok(compaction);
		const compactionIndex = branch.findIndex((entry) => entry.id === compaction.id);
		const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
		assert.ok(correctionIndex < compactionIndex, "the steering correction must be persisted before compaction");
		assert.ok(correctionIndex >= firstKeptIndex, "the persisted steering correction must be retained by compaction");
		for (const optionalId of optionalIds) {
			const optionalIndex = branch.findIndex((entry) => entry.id === optionalId);
			assert.ok(optionalIndex >= firstKeptIndex && optionalIndex < compactionIndex, "the optional retained entries must remain in the native suffix");
		}
		const resumedContext = providerContexts.at(-1)!;
		const correctionUserMessage = resumedContext.messages.find((message) =>
			message.role === "user" && JSON.stringify(message.content).includes(correctionText),
		);
		assert.ok(correctionUserMessage);
		const correctionUserText = typeof correctionUserMessage.content === "string"
			? correctionUserMessage.content
			: correctionUserMessage.content.map((block) => ("text" in block ? block.text : "")).join("\n");
		assert.match(correctionUserText, new RegExp(correctionText));
		assert.match(correctionUserText, new RegExp(`pi://entry/${correctionEntry.id}`));
		assert.ok(conservativeContextTokens(resumedContext, session, 256) <= 8_192);
		assert.ok(prefixId);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
		if (previousTaskLimit === undefined) delete process.env.LEDGER_CONTEXT_TASK_TOKENS;
		else process.env.LEDGER_CONTEXT_TASK_TOKENS = previousTaskLimit;
		if (previousSoftReminder === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
		else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = previousSoftReminder;
		if (previousUrgentReminder === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS;
		else process.env.LEDGER_CONTEXT_URGENT_TOKENS = previousUrgentReminder;
	}
});

test("post-compaction additions remain visible until the next native compaction", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	const oldSummaryExtension = (pi: ExtensionAPI): void => {
		pi.on("session_compact", () => {
			pi.sendMessage({ customType: "test/old-summary", content: "old-summary-boundary", display: false }, { deliverAs: "nextTurn" });
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [oldSummaryExtension], 1_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		faux.setResponses([fauxAssistantMessage("pre-compaction prefix")]);
		await session.prompt("seed post-compaction visibility");
		sessionManager.appendMessage({
			role: "user",
			content: `pre-compaction-large:${"p".repeat(8_000)}`,
			timestamp: Date.now(),
		});
		await session.compact();
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);

		for (let index = 0; index < 5; index++) {
			faux.setResponses([fauxAssistantMessage(`postcompact-fact-${index}`)]);
			await session.prompt(`postcompact-request-${index}`);
		}
		let latestContext: Context | undefined;
		faux.setResponses([
			(context) => {
				latestContext = context;
				return fauxAssistantMessage("postcompact-fact-5");
			},
		]);
		await session.prompt("postcompact-request-5");
		assert.ok(latestContext);
		const providerText = JSON.stringify(latestContext.messages);
		assert.match(providerText, /old-summary-boundary/);
		assert.match(providerText, /postcompact-request-0/);
		assert.match(providerText, /postcompact-fact-0/);
		assert.match(providerText, /postcompact-request-4/);
		assert.match(providerText, /postcompact-fact-4/);
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("non-context custom entries do not split a tool call unit", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "256";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 256, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([fauxAssistantMessage("custom-unit prefix")]);
		await session.prompt("seed custom unit history");
		const oldId = sessionManager.appendMessage({
			role: "user",
			content: `custom-unit-old:${"o".repeat(8_000)}`,
			timestamp: Date.now(),
		});
		const toolCallId = "custom-unit-call";
		const assistantId = sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "custom-unit" }, { id: toolCallId })));
		const customId = sessionManager.appendCustomEntry("test/non-context-checkpoint", { persisted: true });
		const resultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "checkpoint",
			content: [{ type: "text", text: "custom-unit-result" }],
			isError: false,
			timestamp: Date.now(),
		});
		assert.ok(oldId);
		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.equal(compaction.firstKeptEntryId, assistantId);
		assert.match(compaction.summary, new RegExp(`entry ${customId}`));

		let resumedContext: Context | undefined;
		faux.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("custom unit resumed");
			},
		]);
		await session.prompt("resume custom unit");
		assert.ok(resumedContext);
		const callIndex = resumedContext.messages.findIndex(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
		const resultIndex = resumedContext.messages.findIndex(
			(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
		);
		assert.ok(callIndex >= 0);
		assert.ok(resultIndex > callIndex);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("duplicate tool call IDs keep corrected provider order in bounded context", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "32";
	const duplicateTool = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "duplicate_id_tool",
			label: "Duplicate ID tool",
			description: "Returns a small result for duplicate tool ID ordering coverage.",
			parameters: Type.Object({ value: Type.String() }),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `tool-result:${params.value}` }],
				details: {},
			}),
		});
	};
	const { root, faux, session } = await createFixture(false, [duplicateTool], 2_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
		extraToolNames: ["duplicate_id_tool"],
	});
	try {
		const repeatedId = "duplicate-provider-call-id";
		const providerContexts: Context[] = [];
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(
					fauxToolCall("duplicate_id_tool", { value: "first" }, { id: repeatedId }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("first assistant completion");
			},
		]);
		await session.prompt("first assistant request");

		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(
					fauxToolCall("duplicate_id_tool", { value: "corrected" }, { id: repeatedId }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("corrected assistant completion");
			},
		]);
		await session.prompt("user correction: use the corrected value");

		const context = providerContexts.at(-1);
		assert.ok(context);
		const messages = context.messages;
		const callIndices = messages.flatMap((message, index) =>
			message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === repeatedId)
				? [index]
				: [],
		);
		const resultIndices = messages.flatMap((message, index) =>
			message.role === "toolResult" && message.toolCallId === repeatedId ? [index] : [],
		);
		const correctionIndex = messages.findIndex(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("user correction: use the corrected value"),
		);
		const firstCompletionIndex = messages.findIndex(
			(message) => message.role === "assistant" && JSON.stringify(message.content).includes("first assistant completion"),
		);
		const firstRequestIndex = messages.findIndex(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("first assistant request"),
		);
		assert.deepEqual(callIndices.length, 2);
		assert.deepEqual(resultIndices.length, 2);
		assert.ok(firstCompletionIndex >= 0);
		assert.ok(firstRequestIndex >= 0);
		assert.ok(correctionIndex > firstCompletionIndex);
		assert.ok(callIndices[0] < resultIndices[0]);
		assert.ok(resultIndices[0] < correctionIndex);
		assert.ok(correctionIndex < callIndices[1]);
		assert.ok(callIndices[1] < resultIndices[1]);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("oversized retained units use a durable non-context tail marker", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	const preparations: string[] = [];
	const preparationObserver = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => {
			preparations.push(event.preparation.firstKeptEntryId);
		});
	};
	const { root, faux, session, sessionManager } = await createFixture(true, [preparationObserver], 64, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([fauxAssistantMessage("seed before oversized retained unit")]);
		await session.prompt("seed compaction history");
		const oversizedEntryId = sessionManager.appendMessage({
			role: "user",
			content: `raw-tail-sentinel:${"r".repeat(20_000)}`,
			timestamp: Date.now(),
		});

		await session.compact("retain a bounded recovery tail");
		const branch = sessionManager.getBranch();
		const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === "ledger-context/tail-marker");
		assert.ok(markerIndex >= 0);
		const marker = branch[markerIndex];
		if (marker.type !== "custom") throw new Error("missing tail marker");
		assert.equal(preparations.length, 1);
		assert.deepEqual(marker.data, {
			schemaVersion: 4,
			sourceEntryId: preparations[0],
			reason: "tail-budget",
		});
		assert.equal(branch.findIndex((entry) => entry.id === oversizedEntryId) < markerIndex, true);
		const compaction = branch.filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.equal(compaction.firstKeptEntryId, marker.id);
		assert.match(compaction.summary, /firstKeptEntryId:/);
		assert.match(readFileSync(sessionManager.getSessionFile()!, "utf8"), /ledger-context\/tail-marker/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("tail marker bootstrap preserves removed tool execution facts and references", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 64, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		sessionManager.appendMessage({ role: "user", content: "signed marker prefix", timestamp: Date.now() });
		const toolCallId = "signed-marker-call";
		const signedText = { type: "text" as const, text: `signed-text-sentinel:${"s".repeat(12_000)}`, textSignature: "signed-text" };
		const signedThinking = {
			...fauxThinking(`signed-thinking-sentinel:${"t".repeat(12_000)}`),
			thinkingSignature: "signed-thinking",
			redacted: true,
		};
		const signedToolCall = {
			...fauxToolCall("checkpoint", { payload: `signed-payload-sentinel:${"p".repeat(20_000)}` }, { id: toolCallId }),
			thoughtSignature: "signed-tool-call",
			namespace: "signed-tools",
		};
		const assistantId = sessionManager.appendMessage(fauxAssistantMessage([signedText, signedThinking, signedToolCall]));
		const resultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "checkpoint",
			content: [{ type: "text", text: "signed-tool-result-sentinel" }],
			isError: false,
			timestamp: Date.now(),
		});

		await session.compact();
		const branch = sessionManager.getBranch();
		const marker = branch.find((entry) => entry.type === "custom" && entry.customType === "ledger-context/tail-marker");
		assert.ok(marker);
		const compaction = branch.filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.equal(compaction.firstKeptEntryId, marker.id);
		assert.match(compaction.summary, new RegExp(`entry ${assistantId}`));
		assert.match(compaction.summary, /status: requested/);
		assert.match(compaction.summary, new RegExp(`id=${toolCallId}`));
		assert.match(compaction.summary, new RegExp(`entry ${resultId}`));
		assert.match(compaction.summary, /status: completed/);
		assert.match(readFileSync(sessionManager.getSessionFile()!, "utf8"), /signed-payload-sentinel/);

		let resumedContext: Context | undefined;
		faux.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("signed marker resumed");
			},
		]);
		await session.prompt("resume after signed marker");
		assert.ok(resumedContext);
		const providerText = JSON.stringify(resumedContext.messages);
		assert.match(providerText, new RegExp(`entry ${assistantId}`));
		assert.match(providerText, new RegExp(`entry ${resultId}`));
		assert.match(providerText, /status: requested/);
		assert.match(providerText, /status: completed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("task budget keeps a bounded latest user request and complete reference", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTaskLimit = process.env.LEDGER_CONTEXT_TASK_TOKENS;
	process.env.LEDGER_CONTEXT_TASK_TOKENS = "64";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 64, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([fauxAssistantMessage("task budget prefix")]);
		await session.prompt("seed task budget history");
		const latestId = sessionManager.appendMessage({
			role: "user",
			content: `latest-task-sentinel:${"l".repeat(20_000)}`,
			timestamp: Date.now(),
		});
		await session.compact(`focus-sentinel:${"c".repeat(20_000)}`);
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		const taskStart = compaction.summary.indexOf("<active>");
		const recentStart = compaction.summary.indexOf("<recent-interaction>");
		assert.ok(taskStart >= 0 && recentStart > taskStart);
		const taskText = compaction.summary.slice(taskStart, recentStart);
		assert.ok(estimateTokens({ role: "user", content: [{ type: "text", text: taskText }], timestamp: 0 }) <= 64);
		assert.match(taskText, /latest-task-sentinel/);
		assert.match(taskText, new RegExp(`pi://entry/${latestId}`));
		assert.match(taskText, /focus-sentinel/);

		let resumedContext: Context | undefined;
		faux.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("task budget resumed");
			},
		]);
		await session.prompt("resume after bounded task");
		assert.ok(resumedContext);
		const providerText = JSON.stringify(resumedContext.messages);
		assert.match(providerText, /latest-task-sentinel/);
		assert.match(providerText, new RegExp(`pi://entry/${latestId}`));
		assert.match(providerText, /focus-sentinel/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTaskLimit === undefined) delete process.env.LEDGER_CONTEXT_TASK_TOKENS;
		else process.env.LEDGER_CONTEXT_TASK_TOKENS = previousTaskLimit;
	}
});

test("near-capacity context keeps the latest correction when the summary fits", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTaskLimit = process.env.LEDGER_CONTEXT_TASK_TOKENS;
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousReserve = process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
	const tailBudget = 128;
	process.env.LEDGER_CONTEXT_TASK_TOKENS = "64";
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = String(tailBudget);
	process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = "256";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 64, {
		contextWindow: 8_000,
		maxTokens: 256,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		faux.setResponses([fauxAssistantMessage("near-capacity prefix")]);
		await session.prompt("seed near-capacity summary");
		sessionManager.appendMessage({
			role: "user",
			content: `near-capacity-old:${"o".repeat(6_000)}`,
			timestamp: Date.now(),
		});
		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		const summaryTokens = convertToLlm(sessionEntryToContextMessages(compaction)).reduce((sum, message) => sum + estimateTokens(message), 0);
		const fixedTokens = conservativeContextTokens({ messages: [], systemPrompt: session.systemPrompt }, session, 256);
		await session.setModel({ ...faux.getModel(), contextWindow: fixedTokens + summaryTokens + 600 });
		for (let index = 0; index < 18; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: `near-capacity-active-${index}:${"a".repeat(120)}`,
				timestamp: Date.now(),
			});
		}
		let resumedContext: Context | undefined;
		const correction = `latest-near-capacity-correction-sentinel:${"c".repeat(1_200)}`;
		faux.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("near-capacity response");
			},
		]);
		await session.prompt(correction);
		assert.ok(resumedContext);
		const capturedContext = resumedContext;
		const model = session.model;
		assert.ok(model);
		const correctionEntry = sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(correction),
			);
		assert.ok(correctionEntry);
		const latestUserMessage = capturedContext.messages.find(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("latest-near-capacity-correction-sentinel"),
		);
		assert.ok(latestUserMessage);
		const latestUserText = typeof latestUserMessage.content === "string"
			? latestUserMessage.content
			: latestUserMessage.content.map((block) => ("text" in block ? block.text : "")).join("\n");
		const visiblePrefix = latestUserText.split("\n[truncated; complete entry:")[0];
		assert.ok(visiblePrefix.length > 0 && correction.startsWith(visiblePrefix));
		const latestUserIndex = capturedContext.messages.findIndex((message) =>
			message.role === "user" && JSON.stringify(message.content).includes("latest-near-capacity-correction-sentinel"),
		);
		const reference = `\n[truncated; complete entry: pi://entry/${correctionEntry.id}]`;
		const fitsWitness = (prefixLength: number): boolean => {
			const witnessText = `${correction.slice(0, prefixLength)}${reference}`;
			const witnessMessages = capturedContext.messages.map((message, index) =>
				index === latestUserIndex ? { ...message, content: [{ type: "text" as const, text: witnessText }] } : message,
			);
			const witnessMessage = witnessMessages[latestUserIndex];
			return estimateTokens(witnessMessage as never) <= tailBudget && conservativeContextTokens({ ...capturedContext, messages: witnessMessages }, session, 256) <= model.contextWindow;
		};
		let low = 1;
		let high = correction.length;
		let witnessPrefixLength = 1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			if (fitsWitness(middle)) {
				witnessPrefixLength = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		assert.ok(visiblePrefix.length >= witnessPrefixLength);
		assert.match(latestUserText, new RegExp(`pi://entry/${correctionEntry.id}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTaskLimit === undefined) delete process.env.LEDGER_CONTEXT_TASK_TOKENS;
		else process.env.LEDGER_CONTEXT_TASK_TOKENS = previousTaskLimit;
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
	}
});

test("tail marker write failure cancels compaction and blocks another attempt", { timeout: TEST_TIMEOUT_MS }, async () => {
	const previousTailLimit = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "64";
	const { root, faux, session, sessionManager } = await createFixture(true, [], 64, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
	});
	try {
		faux.setResponses([fauxAssistantMessage("seed before marker write fault")]);
		await session.prompt("seed marker failure history");
		const oversizedEntryId = sessionManager.appendMessage({
			role: "user",
			content: `faulted-tail-sentinel:${"f".repeat(20_000)}`,
			timestamp: Date.now(),
		});
		const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
		sessionManager.appendCustomEntry = ((customType: string, data?: unknown) => {
			if (customType === "ledger-context/tail-marker") throw new Error("simulated tail marker log failure");
			return appendCustomEntry(customType, data);
		}) as SessionManager["appendCustomEntry"];

		await assert.rejects(session.compact(), /Compaction cancelled/);
		assert.equal(session.isStreaming, false);
		assert.equal(sessionManager.getLeafId(), oversizedEntryId);
		assert.equal(sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "ledger-context/tail-marker"), false);
		const providerCallsBeforeRetry = faux.state.callCount;
		await assert.rejects(session.compact(), /Compaction cancelled/);
		assert.equal(faux.state.callCount, providerCallsBeforeRetry);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
	}
});

test("context display bounds large multimodal tool units while preserving protocol fields", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	use4kRecoveryBudgets(t);
	const payload = `structured-payload-sentinel:${"p".repeat(40_000)}`;
	const toolText = `large-tool-text-sentinel:${"t".repeat(40_000)}`;
	const largeTool = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "large_payload",
			label: "Large payload",
			description: "Returns a large multimodal result for context display coverage.",
			parameters: Type.Object({ payload: Type.String() }),
			executionMode: "sequential",
			execute: async () => ({
				content: [
					{ type: "text", text: toolText },
					{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
				],
				details: {},
			}),
		});
	};
	const { root, faux, session } = await createFixture(false, [largeTool], 2_000, {
		contextWindow: 32_000,
		maxTokens: 512,
		reserveTokens: 0,
		compactionEnabled: false,
		extraToolNames: ["large_payload"],
	});
	try {
		const providerContexts: Context[] = [];
		const toolCallId = "large-payload-call";
		const signedText = { type: "text" as const, text: `signed-text-sentinel:${"s".repeat(8_000)}`, textSignature: "signed-text-signature" };
		const signedThinking = { ...fauxThinking("signed-thinking-sentinel"), thinkingSignature: "signed-thinking-signature" };
		const signedToolCall = {
			...fauxToolCall("large_payload", { payload: "signed-argument-sentinel" }, { id: "signed-tool-call" }),
			thoughtSignature: "signed-tool-signature",
			namespace: "signed-tools",
		};
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(
					[signedText, signedThinking, fauxToolCall("large_payload", { payload }, { id: toolCallId }), signedToolCall],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("large context display completed");
			},
		]);
		await session.prompt(`large-user-sentinel:${"u".repeat(40_000)}`, {
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		});

		assert.equal(providerContexts.length, 2);
		const messages = providerContexts[1].messages;
		const assistantIndex = messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
		const resultIndex = messages.findIndex(
			(message, index) => index > assistantIndex && message.role === "toolResult" && message.toolCallId === toolCallId,
		);
		assert.ok(assistantIndex >= 0);
		assert.ok(resultIndex > assistantIndex);
		const toolCall = messages[assistantIndex];
		if (toolCall.role !== "assistant") throw new Error("missing assistant tool call");
		const toolCallBlock = toolCall.content.find((block) => block.type === "toolCall" && block.id === toolCallId);
		if (!toolCallBlock || toolCallBlock.type !== "toolCall") throw new Error("missing tool call block");
		assert.equal(typeof toolCallBlock.name, "string");
		assert.equal(typeof toolCallBlock.arguments, "object");
		assert.ok(JSON.stringify(toolCallBlock.arguments).length < JSON.stringify({ payload }).length);
		const thinkingBlock = toolCall.content.find((block) => block.type === "thinking");
		assert.deepEqual(thinkingBlock, signedThinking);
		const signedTextBlock = toolCall.content.find((block) => block.type === "text" && block.textSignature === signedText.textSignature);
		assert.deepEqual(signedTextBlock, signedText);
		const signedToolCallBlock = toolCall.content.find((block) => block.type === "toolCall" && block.id === signedToolCall.id);
		assert.deepEqual(signedToolCallBlock, signedToolCall);
		assert.match(JSON.stringify(messages), /structured-payload-sentinel/);
		assert.match(JSON.stringify(messages), /large-tool-text-sentinel/);
		assert.doesNotMatch(JSON.stringify(messages), /aGVsbG8=/);
		assert.match(JSON.stringify(messages), /image payload omitted/);
		assert.match(JSON.stringify(messages), /complete entry: pi:\/\/entry\//);
		assert.ok(messages.reduce((total, message) => total + estimateTokens(message as never), 0) <= 32_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("context capacity failure aborts the active provider request", { timeout: TEST_TIMEOUT_MS }, async () => {
	let contextSignalAborted = false;
	const observesAbort = (pi: ExtensionAPI): void => {
		pi.on("context", (_event, ctx) => {
			contextSignalAborted = ctx.signal?.aborted ?? false;
		});
	};
	const { root, faux, session } = await createFixture(false, [observesAbort], 500, {
		contextWindow: 64,
		maxTokens: 32,
		reserveTokens: 0,
		compactionEnabled: false,
	});
	try {
		let providerCalled = false;
		let providerSignalAborted = false;
		let agentEnded = false;
		session.subscribe((event) => {
			if (event.type === "agent_end") agentEnded = true;
		});
		faux.setResponses([
			(_context, options) => {
				providerCalled = true;
				providerSignalAborted = options?.signal?.aborted ?? false;
				return fauxAssistantMessage("capacity response");
			},
		]);
		await session.prompt("trigger a capacity failure");

		assert.equal(contextSignalAborted, true);
		assert.equal(providerCalled ? providerSignalAborted : agentEnded, true);
		assert.equal(agentEnded, true);
		assert.equal(session.isStreaming, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function navigationCall(fixture: Awaited<ReturnType<typeof createFixture>>, name: string, args: JsonObject) {
	await fixture.session.reload();
	fixture.session.agent.state.messages = fixture.sessionManager.buildSessionContext().messages;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall(name, args)),
		fauxAssistantMessage("navigation complete"),
	]);
	await fixture.session.prompt("inspect history");
	const result = messageEntries(fixture.sessionManager.getBranch())
		.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === name).at(-1);
	assert.ok(result);
	assertHistoryOutputWithinTokens(result);
	return result;
}

test("history navigation discovers checkpoint versions independently of recovery capacity", async (t) => {
	const previous = process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
	process.env.LEDGER_CONTEXT_LEDGER_TOKENS = "64";
	t.after(() => {
		if (previous === undefined) delete process.env.LEDGER_CONTEXT_LEDGER_TOKENS;
		else process.env.LEDGER_CONTEXT_LEDGER_TOKENS = previous;
	});
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const { sessionManager } = fixture;
	const data = { schemaVersion: 4, kind: "agent-checkpoint", activeRequestEntryIds: [], sourceWindowId: "metadata-only-key", requestHistoryPosition: { entryId: null, branchDepth: 0 }, inputCoverage: UNMEASURED_INPUT_RECORD };
	const first = sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { ...data, ledger: "historic constraint" });
	const second = sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { ...data, ledger: `historic oversized ${"x".repeat(2_000)}` });
	const listed = await navigationCall(fixture, "history_list_items", { limit: 1, filter: { kinds: ["checkpoint"] } });
	assert.equal((listed.message as { isError?: boolean }).isError, false);
	const firstPage = (listed.message as { details: { items: Array<Record<string, any>>; nextCursor: string } }).details;
	assert.equal(firstPage.items[0].entryId, second);
	assert.equal(firstPage.items[0].previousCheckpointEntryId, first);
	assert.equal(firstPage.items[0].sourceWindowId, "metadata-only-key");
	assert.equal(firstPage.items[0].fitsCurrentLedgerBudget, false);
	assert.match(firstPage.items[0].recoveryIssue, /estimated tokens/);
	assert.equal(firstPage.items[0].active, true, "the latest checkpoint retains its identity even when its budget shrinks");
	assert.ok(firstPage.nextCursor);
	sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { ...data, ledger: "historic newer" });
	const continued = await navigationCall(fixture, "history_list_items", { limit: 1, cursor: firstPage.nextCursor, filter: { kinds: ["checkpoint"] } });
	const next = (continued.message as { details: { items: Array<Record<string, any>>; nextCursor: null } }).details;
	assert.equal(next.items[0].entryId, first);
	assert.equal(next.items[0].fitsCurrentLedgerBudget, true);
	assert.equal(next.items[0].active, false, "active status belongs to the cursor snapshot, whose latest ledger exceeds the budget");
	assert.equal(next.nextCursor, null);
	const found = await navigationCall(fixture, "history_search", { query: "historic", filter: { kinds: ["checkpoint"] } });
	assert.equal((found.message as { details: { items: unknown[] } }).details.items.length, 3);
	const metadata = await navigationCall(fixture, "history_search", { query: "metadata-only-key", filter: { kinds: ["checkpoint"] } });
	assert.deepEqual((metadata.message as { details: { items: unknown[] } }).details.items, []);
	const read = await navigationCall(fixture, "history_read", { entryId: second, length: 500 });
	assert.match(toolResultText(read), /historic oversized/);
	const mismatched = await navigationCall(fixture, "history_list_items", { cursor: firstPage.nextCursor, filter: { includeMaintenance: true } });
	assert.match(toolResultText(mismatched), /history_cursor_invalid/);
	const crossTool = await navigationCall(fixture, "history_search", { query: "historic", cursor: firstPage.nextCursor, filter: { kinds: ["checkpoint"] } });
	assert.match(toolResultText(crossTool), /history_cursor_invalid/);
});

test("history navigation lists image-only entries and exposes tool pairing without payload bytes", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const image = fixture.sessionManager.appendMessage({ role: "user", content: [{ type: "image", data: RED_2X2_PNG, mimeType: "image/png" }], timestamp: Date.now() });
	const older = fixture.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "image evidence" }, { type: "image", data: BLUE_3X2_PNG, mimeType: "image/png" }], timestamp: Date.now() });
	const listed = await navigationCall(fixture, "history_list_items", { limit: 1, filter: { kinds: ["user_input"], hasImage: true } });
	const page = (listed.message as { details: { items: Array<{ entryId: string; payloads: Array<{ reference: string }> }>; nextCursor: string } }).details;
	assert.equal(page.items[0].entryId, older);
	assert.equal(page.items[0].payloads[0].reference, `pi://entry/${older}/content/1`);
	assert.ok(page.nextCursor);
	const continued = await navigationCall(fixture, "history_list_items", { cursor: page.nextCursor, filter: { kinds: ["user_input"], hasImage: true } });
	assert.equal((continued.message as { details: { items: Array<{ entryId: string }> } }).details.items[0].entryId, image);
	assert.equal(toolResultText(continued).includes(RED_2X2_PNG), false);
	const mismatch = await navigationCall(fixture, "history_list_items", { cursor: page.nextCursor, filter: { kinds: ["user_input"], hasImage: false } });
	assert.match(toolResultText(mismatch), /history_cursor_invalid/);
	const search = await navigationCall(fixture, "history_search", { query: "image evidence", filter: { kinds: ["user_input","assistant_text"], hasImage: true } });
	assert.deepEqual((search.message as { details: { items: Array<{ entryId: string }> } }).details.items.map((hit) => hit.entryId), [older]);
	const call = fixture.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("ordinary_tool", { value: "pairing" }, { id: "pairing-call" })));
	const result = fixture.sessionManager.appendMessage({ role: "toolResult", toolCallId: "pairing-call", toolName: "ordinary_tool", content: [{ type: "text", text: "pairing result" }], isError: false, timestamp: Date.now() });
	const tools = await navigationCall(fixture, "history_list_items", { filter: { kinds: ["tool_call","tool_result"] } });
	const items = (tools.message as { details: { items: Array<Record<string, any>> } }).details.items;
	assert.deepEqual(items.map((item) => item.entryId), [result, call]);
	assert.equal(items[0].toolCallId, "pairing-call");
	assert.equal(items[1].toolCalls[0].id, "pairing-call");
	const invalid = await navigationCall(fixture, "history_list_items", { filter: { includeMaintenance: true, hasImage: "yes" } });
	assert.equal((invalid.message as { isError?: boolean }).isError, true);
});

test("history navigation freezes windows and item pages across later compaction", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_windows", "history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const { sessionManager } = fixture;
	const initial = `window:${sessionManager.getSessionId()}:initial`;
	const seed = sessionManager.appendMessage({ role: "user", content: "window seed", timestamp: Date.now() });
	const details = (windowId: string, sourceWindowId: string) => ({ schemaVersion: 4, kind: "ledger-context", windowId, sourceWindowId, checkpointEntryId: null, sourceBranchTip: sessionManager.getLeafId(), firstKeptEntryId: seed, snapshotPosition: { entryId: seed, branchDepth: sessionManager.getBranch().findIndex((entry) => entry.id === seed) + 1 }, delta: { status: "empty" }, recoveryContext: { task: "window seed", tail: "" } });
	sessionManager.appendCompaction("first window", seed, 100, details("window:first", initial), true);
	const before = await navigationCall(fixture, "history_list_windows", { limit: 1 });
	const page = (before.message as { details: { windows: Array<Record<string, any>>; nextCursor: string } }).details;
	assert.equal(page.windows[0].windowId, "window:first");
	assert.equal(page.windows[0].active, true);
	assert.ok(page.nextCursor);
	const listed = await navigationCall(fixture, "history_list_items", { limit: 1, filter: { kinds: ["user_input"], includeMaintenance: true, windowIds: ["window:first"] } });
	const itemPage = (listed.message as { details: { nextCursor: string } }).details;
	assert.ok(itemPage.nextCursor);
	sessionManager.appendCompaction("second window", seed, 200, details("window:second", "window:first"), true);
	const remaining = await navigationCall(fixture, "history_list_windows", { cursor: page.nextCursor });
	const windows = (remaining.message as { details: { windows: Array<Record<string, any>> } }).details.windows;
	assert.equal(windows.length, 1);
	assert.equal(windows[0].windowId, initial);
	assert.equal(windows[0].entryCount, sessionManager.getBranch().findIndex((entry) => entry.id === seed));
	const nextItems = await navigationCall(fixture, "history_list_items", { cursor: itemPage.nextCursor, filter: { kinds: ["user_input"], includeMaintenance: true, windowIds: ["window:first"] } });
	assert.ok((nextItems.message as { details: { items: Array<{ entryId: string }> } }).details.items.some((item) => item.entryId === seed));
	const empty = await navigationCall(fixture, "history_list_items", { filter: { includeMaintenance: true, windowIds: ["window:first"] } });
	assert.deepEqual((empty.message as { details: { items: unknown[] } }).details.items, []);
	const current = await navigationCall(fixture, "history_list_windows", {});
	assert.deepEqual((current.message as { details: { windows: Array<{ windowId: string }> } }).details.windows.map((window) => window.windowId), ["window:second", "window:first", initial]);
	assert.equal((current.message as { details: { windows: Array<{ entryCount: number }> } }).details.windows[1].entryCount, 0);
	sessionManager.branch(seed);
	const offBranch = await navigationCall(fixture, "history_list_windows", { cursor: page.nextCursor });
	assert.match(toolResultText(offBranch), /history_cursor_invalid/);
});

test("history navigation reports remaining capacity without changing checkpoints or windows", async (t) => {
	for (const enabled of [true, false]) {
		const fixture = await createFixture(false, [], 70, { contextWindow: 500_000, reserveTokens: 27_200, compactionEnabled: enabled, extraToolNames: ["get_context_remaining", "history_list_items"] });
		t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
		const before = checkpointEntries(fixture.sessionManager.getBranch()).length;
		const result = await navigationCall(fixture, "get_context_remaining", {});
		const data = (result.message as { details: Record<string, any> }).details;
		assert.equal(data.contextWindowTokens, 500_000);
		assert.equal(data.modelRemainingTokens, Math.max(0, 500_000 - data.usedTokens));
		assert.equal(data.effectiveBoundaryTokens, enabled ? 472_800 : 483_616);
		assert.equal(data.tokensUntilBoundary, Math.max(0, data.effectiveBoundaryTokens - data.usedTokens));
		assert.equal(data.nativeCompactionMode, enabled ? "native" : "disabled");
		assert.equal(data.usageKind, "pi-context-usage");
		assert.equal(checkpointEntries(fixture.sessionManager.getBranch()).length, before);
		assert.equal(fixture.sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);
		const ordinary = await navigationCall(fixture, "history_list_items", { filter: { kinds: ["tool_call","tool_result"] } });
		assert.deepEqual((ordinary.message as { details: { items: unknown[] } }).details.items, []);
	}
});

test("history navigation handles estimated and unavailable capacity and bounded list errors", async (t) => {
	const fixture = await createFixture(false, [], 70, {
		compactionEnabled: false,
		extraToolNames: ["get_context_remaining", "history_list_items", "history_list_windows"],
		settingsReader: () => ({ error: "settings unavailable" }),
	});
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const budget = fixture.session.getToolDefinition("get_context_remaining");
	assert.ok(budget);
	const context = { sessionManager: fixture.sessionManager, model: fixture.faux.getModel(), getContextUsage: () => undefined, getSystemPrompt: () => "" };
	const estimated = await budget.execute("estimate", {}, undefined, undefined, context as never);
	const details = estimated.details as { usageKind: string; usedTokens: number; nativeCompactionMode: string; effectiveBoundaryTokens: number };
	assert.equal(details.usageKind, "bounded-content-estimate");
	assert.ok(details.usedTokens > 0);
	assert.equal(details.nativeCompactionMode, "unknown");
	assert.equal(details.effectiveBoundaryTokens, 115_200);
	const unavailable = await budget.execute("unknown", {}, undefined, undefined, { ...context, model: undefined } as never);
	assert.equal((unavailable.details as { usageKind: string }).usageKind, "unavailable");
	assert.equal((unavailable.details as { modelRemainingTokens: null }).modelRemainingTokens, null);
	const previous = process.env.LEDGER_CONTEXT_READ_TOKENS;
	process.env.LEDGER_CONTEXT_READ_TOKENS = "1";
	try {
		for (const name of ["history_list_items", "history_list_windows"]) {
			const tool = fixture.session.getToolDefinition(name);
			assert.ok(tool);
			await assert.rejects(() => tool.execute("small-budget", {}, undefined, undefined, context as never), /history_output_capacity/);
		}
	} finally {
		if (previous === undefined) delete process.env.LEDGER_CONTEXT_READ_TOKENS;
		else process.env.LEDGER_CONTEXT_READ_TOKENS = previous;
	}
	const invalid = await navigationCall(fixture, "history_list_windows", { limit: 0 });
	assert.equal((invalid.message as { isError?: boolean }).isError, true);
});

test("history navigation bounds pairing metadata and continues past large tool batches", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const olderId = fixture.sessionManager.appendMessage(fauxAssistantMessage("constraint before the batch"));
	const batchId = fixture.sessionManager.appendMessage(fauxAssistantMessage([
		{ type: "text", text: "constraint in the batch" },
		...Array.from({ length: 100 }, (_, index) => fauxToolCall("ordinary_tool", { index }, { id: `batch-${index}-${"x".repeat(48)}` })),
	]));
	for (const name of ["history_search", "history_list_items"]) {
		const tool = fixture.session.getToolDefinition(name);
		assert.ok(tool);
		const params = name === "history_search" ? { query: "constraint", limit: 1, filter: { includeMaintenance: true } } : { limit: 1, filter: { includeMaintenance: true } };
		const first = await tool.execute("batch-navigation", params, undefined, undefined, { sessionManager: fixture.sessionManager } as never);
		const details = first.details as { items: Array<Record<string, any>>; nextCursor: string };
		const hit = details.items[0];
		assert.equal(hit.entryId, batchId);
		assert.match(hit.snippet, /constraint/);
		assert.ok(hit.omittedToolCalls > 0);
		assert.equal(hit.toolCalls.length + hit.omittedToolCalls, 100);
		assert.equal(hit.reference, `pi://entry/${batchId}`);
		const text = first.content.map((block) => block.type === "text" ? block.text : "").join("\n");
		assert.ok(textTokenEstimate(text) <= 2_048);
		assert.ok(details.nextCursor);
		const second = await tool.execute("batch-next-page", { ...params, cursor: details.nextCursor }, undefined, undefined, { sessionManager: fixture.sessionManager } as never);
		const next = second.details as { items: Array<{ entryId: string }> };
		assert.equal(next.items[0].entryId, olderId);
	}
});

test("history window listing shrinks optional previews before rejecting mandatory metadata", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_windows"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const initial = `window:${fixture.sessionManager.getSessionId()}:initial`;
	const checkpointId = fixture.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, {
		schemaVersion: 4, kind: "agent-checkpoint", activeRequestEntryIds: [], sourceWindowId: initial,
		requestHistoryPosition: { entryId: null, branchDepth: 0 }, ledger: "A".repeat(256),
		inputCoverage: UNMEASURED_INPUT_RECORD,
	});
	const tool = fixture.session.getToolDefinition("history_list_windows");
	assert.ok(tool);
	const read = () => tool.execute("preview-capacity", {}, undefined, undefined, { sessionManager: fixture.sessionManager } as never);
	const full = await read();
	const fullText = full.content.map((block) => block.type === "text" ? block.text : "").join("\n");
	const bare = JSON.parse(fullText);
	bare.windows[0].checkpointPreview = "";
	bare.windows[0].checkpointPreviewTruncated = true;
	const bareTokens = textTokenEstimate(JSON.stringify(bare, null, 2));
	const tokenLimit = Math.floor((bareTokens + textTokenEstimate(fullText)) / 2);
	const previous = process.env.LEDGER_CONTEXT_READ_TOKENS;
	try {
		process.env.LEDGER_CONTEXT_READ_TOKENS = String(tokenLimit);
		const bounded = await read();
		const text = bounded.content.map((block) => block.type === "text" ? block.text : "").join("\n");
		assert.ok(textTokenEstimate(text) <= tokenLimit);
		const window = (bounded.details as { windows: Array<{ latestCheckpointEntryId: string; checkpointPreview: string; checkpointCount: number }> }).windows[0];
		assert.equal(window.latestCheckpointEntryId, checkpointId);
		assert.equal(window.checkpointCount, 1);
		assert.ok(window.checkpointPreview.length > 0 && window.checkpointPreview.length < 256);
		process.env.LEDGER_CONTEXT_READ_TOKENS = "1";
		await assert.rejects(read, (error: Error) => {
			const data = JSON.parse(error.message.slice("history_output_capacity: ".length));
			assert.equal(data.metadataTokens, bareTokens);
			return true;
		});
	} finally {
		if (previous === undefined) delete process.env.LEDGER_CONTEXT_READ_TOKENS;
		else process.env.LEDGER_CONTEXT_READ_TOKENS = previous;
	}
});

test("history window active flags match restored state after non-ledger compaction", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_windows", "get_context_remaining"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const { sessionManager } = fixture;
	const initial = `window:${sessionManager.getSessionId()}:initial`;
	const seed = sessionManager.appendMessage({ role: "user", content: "window source", timestamp: Date.now() });
	sessionManager.appendCompaction("ledger summary", seed, 100, {
		schemaVersion: 4, kind: "ledger-context", windowId: "window:tracked", sourceWindowId: initial,
		checkpointEntryId: null, sourceBranchTip: seed, firstKeptEntryId: seed,
		snapshotPosition: { entryId: seed, branchDepth: sessionManager.getBranch().findIndex((entry) => entry.id === seed) + 1 }, delta: { status: "empty" }, recoveryContext: { task: "window source", tail: "" },
	}, true);
	sessionManager.appendCompaction("native summary", seed, 100);
	await fixture.session.reload();
	const list = fixture.session.getToolDefinition("history_list_windows");
	const budget = fixture.session.getToolDefinition("get_context_remaining");
	assert.ok(list && budget);
	const context = { sessionManager, model: fixture.faux.getModel(), getContextUsage: () => undefined, getSystemPrompt: () => "" };
	const listed = await list.execute("restored-windows", {}, undefined, undefined, context as never);
	const remaining = await budget.execute("restored-budget", {}, undefined, undefined, context as never);
	const windows = (listed.details as { windows: Array<{ windowId: string; active: boolean; entryCount: number }> }).windows;
	assert.deepEqual(windows.filter((window) => window.active).map((window) => window.windowId), [initial]);
	assert.equal((remaining.details as { windowId: string }).windowId, initial);
	assert.ok(windows.find((window) => window.windowId === "window:tracked")!.entryCount > 0);
});

async function inspectHistory(fixture: Awaited<ReturnType<typeof createFixture>>, name: string, params: Record<string, unknown>) {
	const tool = fixture.session.getToolDefinition(name);
	assert.ok(tool);
	return tool.execute("direct-history-inspection", params, undefined, undefined, { sessionManager: fixture.sessionManager } as never);
}

test("unified history filters separate record selection, matching, and returned content", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items", "history_list_windows"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const manager = fixture.sessionManager;
	const user = manager.appendMessage({ role: "user", content: [{ type: "text", text: "precision requirement" }, { type: "image", mimeType: "image/png", data: RED_2X2_PNG }], timestamp: Date.now() });
	const pureCall = manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", { command: "precision hidden args" }, { id: "pure-call" })));
	const mixed = manager.appendMessage(fauxAssistantMessage([{ type: "text", text: "precision explanation" }, fauxToolCall("bash", { command: "private-argument" }, { id: "mixed-call" })]));
	const failed = manager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: "mixed-call", isError: true,
		content: [{ type: "text", text: "timeout while testing" }, { type: "image", mimeType: "image/png", data: BLUE_3X2_PNG }], timestamp: Date.now() });
	const success = manager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: "pure-call", isError: false, content: [{ type: "text", text: "timeout recovered" }], timestamp: Date.now() });
	const filter = { kinds: ["tool_result"], toolNames: ["bash"], statuses: ["failed"], hasImage: true, afterEntryId: user, beforeEntryId: success };
	const listed = await inspectHistory(fixture, "history_list_items", { filter, projection: "text" });
	const searched = await inspectHistory(fixture, "history_search", { filter, projection: "text", query: "timeout" });
	for (const result of [listed, searched]) {
		const details = result.details as { items: Array<Record<string, any>>; totalMatches: number };
		assert.equal(details.totalMatches, 1);
		assert.equal(details.items[0].entryId, failed);
		assert.equal(details.items[0].hasImage, true);
		assert.deepEqual(details.items[0].payloads, []);
		assert.match(details.items[0].snippet, /timeout/);
	}
	assert.equal((searched.details as { items: Array<{ match: { contentIndex: number; kind: string; offset: number } }> }).items[0].match.contentIndex, 0);
	const overview = await inspectHistory(fixture, "history_list_windows", { filter });
	const windows = (overview.details as { windows: Array<Record<string, any>> }).windows;
	assert.equal(windows.reduce((sum, window) => sum + window.matchedEntryCount, 0), 1);
	assert.equal(windows[0].failedToolResults, 1);
	assert.equal(windows[0].imageCount, 1);
	const dialogue = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["assistant_text", "tool_call"], excludeKinds: ["tool_call"] } });
	const dialogueItems = (dialogue.details as { items: Array<Record<string, any>> }).items;
	assert.deepEqual(dialogueItems.map((item) => item.entryId), [mixed]);
	assert.equal(dialogueItems[0].toolCalls, undefined);
	assert.equal(JSON.stringify(dialogue.content).includes("private-argument"), false);
	assert.equal(dialogueItems.some((item) => item.entryId === pureCall), false);
	const text = await inspectHistory(fixture, "history_read", { entryId: user, projection: "text" });
	assert.match((text.details as { text: string }).text, /precision requirement/);
	assert.equal(JSON.stringify(text.content).includes("[image"), false);
	const images = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["user_input"], hasImage: true }, projection: "images" });
	const imageItem = (images.details as { items: Array<Record<string, any>> }).items[0];
	assert.equal(imageItem.snippet, undefined);
	assert.equal(imageItem.payloads[0].reference, `pi://entry/${user}/content/1`);
	assert.equal(JSON.stringify(images).includes(RED_2X2_PNG), false);
});

test("unified history order, ranges, and filter fingerprints remain stable across new work", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items", "history_list_windows"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const ids = ["first", "second", "third"].map((content) => fixture.sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() }));
	const params = { filter: { kinds: ["user_input", "assistant_text"] }, order: "oldest", limit: 1, projection: "references" };
	const first = await inspectHistory(fixture, "history_list_items", params);
	const firstDetails = first.details as { items: Array<{ entryId: string }>; nextCursor: string; totalMatches: number };
	assert.equal(firstDetails.items[0].entryId, ids[0]);
	assert.equal(firstDetails.totalMatches, 3);
	fixture.sessionManager.appendMessage({ role: "user", content: "fourth", timestamp: Date.now() });
	const second = await inspectHistory(fixture, "history_list_items", { ...params, filter: { kinds: ["assistant_text", "user_input"] }, cursor: firstDetails.nextCursor });
	assert.equal((second.details as { items: Array<{ entryId: string }> }).items[0].entryId, ids[1]);
	assert.equal((second.details as { totalMatches: number }).totalMatches, 3);
	const bounded = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["user_input"], afterEntryId: ids[0], beforeEntryId: ids[2] } });
	assert.deepEqual((bounded.details as { items: Array<{ entryId: string }> }).items.map((item) => item.entryId), [ids[1]]);
	const resized = await inspectHistory(fixture, "history_list_items", { ...params, cursor: firstDetails.nextCursor, projection: "text", maxChars: 450, limit: 40 });
	assert.deepEqual((resized.details as { items: Array<{ entryId: string }> }).items.map((item) => item.entryId), ids.slice(1));
	for (const changed of [{ order: "newest" }, { filter: { kinds: ["tool_result"] } }]) {
		await assert.rejects(() => inspectHistory(fixture, "history_list_items", { ...params, ...changed, cursor: firstDetails.nextCursor }), /history_cursor_invalid/);
	}
	for (const invalid of [{ scope: "all" }, { filter: { roles: ["user"] } }, { filter: { statuses: ["suceeded"] } }, { filter: { afterEntryId: ids[2], beforeEntryId: ids[0] } }, { filter: { beforeEntryId: "missing" } }]) {
		await assert.rejects(() => inspectHistory(fixture, "history_list_items", invalid), /history validation failed/);
	}
	const oldCursor = JSON.stringify({ ...JSON.parse(firstDetails.nextCursor), version: 2 });
	await assert.rejects(() => inspectHistory(fixture, "history_list_items", { ...params, cursor: oldCursor }), /history_cursor_invalid/);
});

test("history exchange reads preserve repeated call IDs, multiple results, and unresolved calls", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const manager = fixture.sessionManager;
	const call = manager.appendMessage(fauxAssistantMessage([{ type: "text", text: "run both" },
		fauxToolCall("bash", { command: "first-command" }, { id: "repeated" }), fauxToolCall("read", { path: "second-path" }, { id: "other" })]));
	const result = (id: string, text: string) => manager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: id, content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
	const firstResult = result("repeated", "first result");
	manager.appendCustomEntry("intervening-metadata", { marker: true });
	const correctedResult = result("repeated", "corrected result");
	const otherResult = result("other", "other result");
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", { command: "new-command" }, { id: "repeated" })));
	const laterResult = result("repeated", "later batch result");
	const exchange = await inspectHistory(fixture, "history_read", { entryId: firstResult, view: "exchange" });
	const details = exchange.details as { items: Array<Record<string, any>>; relation: Record<string, any> };
	assert.deepEqual(details.items.map((item) => item.entryId), [call, firstResult, correctedResult]);
	assert.equal(details.relation.missingResultCount, 0);
	assert.equal(details.items[0].toolCalls.length, 1);
	assert.equal(details.items[0].toolCalls[0].contentIndex, 1);
	assert.equal(JSON.stringify(exchange).includes("second-path"), false);
	assert.equal(details.items.some((item) => item.entryId === laterResult), false);
	const selected = await inspectHistory(fixture, "history_read", { entryId: call, view: "exchange", contentIndex: 2 });
	assert.deepEqual((selected.details as { items: Array<{ entryId: string }> }).items.map((item) => item.entryId), [call, otherResult]);
	const block = await inspectHistory(fixture, "history_read", { entryId: call, contentIndex: 1, projection: "text" });
	assert.match((block.details as { text: string }).text, /first-command/);
	assert.equal(JSON.stringify(block.content).includes("second-path"), false);
	const incomplete = manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", {}, { id: "pending" })));
	const pending = await inspectHistory(fixture, "history_read", { entryId: incomplete, view: "exchange" });
	assert.equal((pending.details as { relation: { missingResultCount: number } }).relation.missingResultCount, 1);
	const orphan = result("missing-call", "orphan result");
	const missing = await inspectHistory(fixture, "history_read", { entryId: orphan, view: "exchange" });
	assert.equal((missing.details as { relation: { missingCall: boolean } }).relation.missingCall, true);
});

test("history related-view pagination freezes neighborhoods and rejects mixed read modes", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const ids = ["before", "anchor", "after"].map((content) => fixture.sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() }));
	const params = { entryId: ids[1], view: "neighbors", before: 1, after: 2, projection: "references", limit: 1 };
	const first = await inspectHistory(fixture, "history_read", params);
	const data = first.details as { items: Array<{ entryId: string }>; nextCursor: string; totalMatches: number };
	assert.equal(data.items[0].entryId, ids[0]);
	assert.equal(data.totalMatches, 3);
	fixture.sessionManager.appendMessage({ role: "user", content: "new after", timestamp: Date.now() });
	const second = await inspectHistory(fixture, "history_read", { ...params, cursor: data.nextCursor });
	assert.equal((second.details as { items: Array<{ entryId: string }> }).items[0].entryId, ids[1]);
	assert.equal((second.details as { totalMatches: number }).totalMatches, 3);
	for (const invalid of [{ ...params, offset: 0 }, { entryId: ids[1], view: "entry", cursor: data.nextCursor }, { ...params, contentIndex: 0 }, { ...params, before: 21 }]) {
		await assert.rejects(() => inspectHistory(fixture, "history_read", invalid), /history validation failed/);
	}
	await assert.rejects(() => inspectHistory(fixture, "history_read", { ...params, after: 1, cursor: data.nextCursor }), (error: Error) => error.message.startsWith("history_cursor_invalid:"));
});

test("history preserves empty assistant failures as metadata and neighborhood anchors", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const id = fixture.sessionManager.appendMessage(fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider timeout evidence" }));
	const listed = await inspectHistory(fixture, "history_list_items", { filter: { statuses: ["failed"] } });
	const details = listed.details as { items: Array<{ entryId: string; kinds: string[]; snippet: string }> };
	assert.equal(details.items[0].entryId, id);
	assert.deepEqual(details.items[0].kinds, ["metadata"]);
	assert.match(details.items[0].snippet, /provider timeout evidence/);
	const neighbors = await inspectHistory(fixture, "history_read", { entryId: id, view: "neighbors", before: 0, after: 0 });
	assert.equal((neighbors.details as { totalMatches: number }).totalMatches, 1);
	assert.equal((neighbors.details as { items: Array<{ entryId: string }> }).items[0].entryId, id);
	const textOnly = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["assistant_text"] } });
	assert.deepEqual((textOnly.details as { items: unknown[] }).items, []);
	const read = await inspectHistory(fixture, "history_read", { entryId: id });
	assert.match((read.details as { text: string }).text, /provider timeout evidence/);
});

test("history search block coordinates round-trip through exact UTF-16 reads", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const result = fixture.sessionManager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: "coordinate-call", isError: false,
		content: [{ type: "image", mimeType: "image/png", data: RED_2X2_PNG }, { type: "text", text: "前缀 🐱 target 尾部" }], timestamp: Date.now() });
	const call = fixture.sessionManager.appendMessage(fauxAssistantMessage([{ type: "text", text: "calling" }, fauxToolCall("bash", { command: "run --mode fast" }, { id: "coordinate-invocation" })]));
	for (const [query, expectedId, kind] of [["target", result, "tool_result"], ["image/png", result, "tool_result"], ["--mode", call, "tool_call"]]) {
		const searched = await inspectHistory(fixture, "history_search", { query, filter: { kinds: [kind] } });
		const item = (searched.details as { items: Array<{ entryId: string; match: { contentIndex: number; offset: number } }> }).items[0];
		assert.equal(item.entryId, expectedId);
		const read = await inspectHistory(fixture, "history_read", { entryId: item.entryId, contentIndex: item.match.contentIndex, offset: item.match.offset, length: query.length });
		assert.equal((read.details as { text: string }).text, query);
	}
	fixture.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "cross" }, { type: "text", text: "boundary" }], timestamp: Date.now() });
	const spanning = await inspectHistory(fixture, "history_search", { query: "cross\nboundary", filter: { kinds: ["user_input"] } });
	assert.equal((spanning.details as { items: Array<{ match: { spansBlocks: boolean } }> }).items[0].match.spansBlocks, true);
});

test("history read explains view conflicts and supplies exact bounded continuation", async (t) => {
	const fixture = await createFixture(false, [], 70, { compactionEnabled: false, extraToolNames: ["history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const id = fixture.sessionManager.appendMessage({ role: "user", content: "A".repeat(1000), timestamp: Date.now() });
	for (const limit of [1, 5]) await assert.rejects(() => inspectHistory(fixture, "history_read", { entryId: id, view: "entry", projection: "text", limit }), (error: Error) => {
		assert.match(error.message, /limit/);
		assert.match(error.message, /length/);
		return true;
	});
	for (const view of ["exchange", "neighbors"]) await assert.rejects(() => inspectHistory(fixture, "history_read", { entryId: id, view, offset: 0, length: 20 }), (error: Error) => {
		assert.match(error.message, /offset.*length/);
		assert.match(error.message, /Remove.*limit/);
		return true;
	});
	const first = await inspectHistory(fixture, "history_read", { entryId: id, projection: "text", length: 20 });
	const details = first.details as { nextRead: Record<string, unknown>; pageEnd: string; length: number };
	assert.equal(details.pageEnd, "length");
	assert.equal(details.length, 20);
	const second = await inspectHistory(fixture, "history_read", details.nextRead);
	assert.equal((second.details as { offset: number }).offset, 20);
	assert.match(JSON.stringify(first.content), /nextRead/);
});

test("delta input records remain immutable across cumulative updates, agent saves, reload and branches", async (t) => {
	const previousTail = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	const previousTask = process.env.LEDGER_CONTEXT_TASK_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "512";
	t.after(() => { if (previousTail === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS; else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTail; });
	t.after(() => { if (previousTask === undefined) delete process.env.LEDGER_CONTEXT_TASK_TOKENS; else process.env.LEDGER_CONTEXT_TASK_TOKENS = previousTask; });
	const fixture = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0, compactionEnabled: false, extraToolNames: ["history_list_items"] });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Initial task. Skills: none." })), fauxAssistantMessage("saved")]);
	await session.prompt("Original task anchor");
	const base = checkpointEntries(manager.getBranch()).at(-1)!;
	assert.deepEqual((base.data as any).inputCoverage, { ...UNMEASURED_INPUT_RECORD, snapshotThrough: (base.data as any).requestHistoryPosition.entryId });
	const correction = manager.appendMessage({ role: "user", content: "Important correction must remain discoverable " + "c".repeat(500), timestamp: Date.now() });
	for (let i = 0; i < 100; i++) manager.appendMessage(fauxAssistantMessage(`large-${i}:` + "x".repeat(8000)));
	const latest = manager.appendMessage({ role: "user", content: "Latest task anchor", timestamp: Date.now() });
	ledgerFaux.setResponses([(context) => {
		assert.doesNotMatch(JSON.stringify(context.messages), /Important correction/);
		assert.match(JSON.stringify(context.messages), /Original task anchor/);
		return fauxAssistantMessage("Bounded ledger. Source references are available. Skills: none.");
	}]);
	await session.compact();
	const first = latestCompaction(manager.getBranch());
	const coverage = generatedDelta(first).inputCoverage;
	assert.equal(coverage.source, "compaction-delta");
	assert.equal(coverage.measurement, "measured");
	assert.equal(coverage.baseCheckpointEntryId, base.id);
	assert.equal(coverage.snapshotThrough, latest);
	assert.deepEqual(coverage.historyScope, { afterEntryId: (base.data as any).requestHistoryPosition.entryId, throughEntryId: latest });
	assert.equal(coverage.projections.find((item) => item.entryId === base.id)?.kind, "checkpoint-ledger");
	const contains = (entries: SessionEntry[], ranges: any[], id: string) => ranges.some(range => entries.findIndex(e => e.id === range.fromEntryId) <= entries.findIndex(e => e.id === id) && entries.findIndex(e => e.id === range.toEntryId) >= entries.findIndex(e => e.id === id));
	assert.ok(contains(manager.getBranch(), coverage.omittedRanges, correction));
	assert.ok(coverage.partialEntries.length > 0);
	assert.ok(contains(manager.getBranch(), coverage.fullRanges, latest));
	assert.match(latestCompaction(manager.getBranch()).summary, /"inputRecord":.*measured/);
	assert.doesNotMatch(latestCompaction(manager.getBranch()).summary, /outstandingEntries|unknownEntries|gapRanges/);
	const firstRecord = JSON.stringify(first.details);
	manager.appendMessage({ role: "user", content: "Continue the next window", timestamp: Date.now() });
	ledgerFaux.setResponses([fauxAssistantMessage("Second ledger uses its own input record. Skills: none.")]);
	await session.compact();
	const second = latestCompaction(manager.getBranch());
	const secondCoverage = generatedDelta(second).inputCoverage;
	assert.equal(secondCoverage.baseCheckpointEntryId, base.id);
	assert.equal(secondCoverage.baseDeltaCompactionEntryId, first.id);
	assert.equal(secondCoverage.historyScope.afterEntryId, coverage.snapshotThrough);
	assert.equal(generatedDelta(second).scope.afterEntryId, (base.data as any).requestHistoryPosition.entryId);
	assert.equal(contains(manager.getBranch(), secondCoverage.omittedRanges, correction), false);
	assert.equal(JSON.stringify(first.details), firstRecord);
	await session.reload();
	faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Agent saved ledger. Skills: none." })), fauxAssistantMessage("saved again")]);
	await session.prompt("Save current progress");
	const manual = checkpointEntries(manager.getBranch()).at(-1)!;
	const recoveryBasis = { checkpointEntryId: base.id, deltaCompactionEntryId: second.id };
	assert.deepEqual((manual.data as any).inputCoverage, { ...UNMEASURED_INPUT_RECORD, snapshotThrough: (manual.data as any).requestHistoryPosition.entryId, recoveryBasis });
	const listed = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["checkpoint"] }, limit: 1 });
	assert.equal((listed.details as any).items[0].previousCheckpointEntryId, base.id);
	assert.deepEqual((listed.details as any).items[0].inputRecord, { measurement: "unmeasured", source: "agent-context", recoveryBasis });
	const read = await inspectHistory(fixture, "history_read", { entryId: first.id, length: 65536 });
	assert.equal((read.details as any).inputRecord.measurement, "measured");
	let page = read;
	let manifestText = "";
	for (let pageCount = 0; ; pageCount++) {
		assert.ok(pageCount < 100);
		manifestText += (page.details as any).text;
		if (!(page.details as any).nextRead) break;
		page = await inspectHistory(fixture, "history_read", (page.details as any).nextRead);
	}
	const recoveryCalls = JSON.parse(manifestText.split("Input record browse calls (inclusive recorded ranges, exclusive query bounds):\n")[1]);
	const recovery = recoveryCalls.find((item: any) => item.inputForm === "omitted" && contains(manager.getBranch(), [item], correction));
	const recoveredIds: string[] = [];
	let cursor: string | undefined;
	do {
		const recovered = await inspectHistory(fixture, recovery.tool, { ...recovery.arguments, ...(cursor ? { cursor } : {}) });
		recoveredIds.push(...(recovered.details as any).items.map((item: any) => item.entryId));
		cursor = (recovered.details as any).nextCursor ?? undefined;
	} while (cursor);
	const branch = manager.getBranch();
	assert.deepEqual(recoveredIds, branch.slice(branch.findIndex(entry => entry.id === recovery.fromEntryId), branch.findIndex(entry => entry.id === recovery.toEntryId) + 1).map(entry => entry.id));
	faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Make correction an explicit task anchor.", activeRequestEntryIds: [correction] })), fauxAssistantMessage("anchor saved")]);
	await session.prompt("Carry the correction as an active request");
	ledgerFaux.setResponses([(context) => {
		assert.match(JSON.stringify(context.messages), /Important correction/);
		return fauxAssistantMessage("Ledger now received correction text. Skills: none.");
	}]);
	await session.compact();
	const repaired = generatedDelta(latestCompaction(manager.getBranch())).inputCoverage;
	assert.equal(repaired.baseDeltaCompactionEntryId, null, "a new checkpoint retires the old delta basis");
	assert.ok(contains(manager.getBranch(), repaired.fullRanges, correction));
	assert.equal("outstandingGaps" in repaired, false);
	assert.equal(JSON.stringify(first.details), firstRecord, "later input and browsing must not rewrite prior omission records");
	process.env.LEDGER_CONTEXT_TASK_TOKENS = "128";
	manager.appendMessage({ role: "user", content: "Continue briefly", timestamp: Date.now() });
	ledgerFaux.setResponses([fauxAssistantMessage("Carry previously supplied correction. Skills: none.")]);
	await session.compact();
	const carriedOwner = latestCompaction(manager.getBranch());
	const carried = generatedDelta(carriedOwner).inputCoverage;
	assert.equal(carried.projections.find((part) => part.entryId === correction)?.kind, "reference");
	assert.equal("outstandingGaps" in carried, false);
	const savedCoverage = JSON.stringify(carried);
	manager.appendMessage({ role: "user", content: "Refresh will fail", timestamp: Date.now() });
	ledgerFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" })]);
	await session.compact();
	assert.equal(JSON.stringify(generatedDelta(carriedOwner).inputCoverage), savedCoverage);
	assert.deepEqual((latestCompaction(manager.getBranch()).details as LedgerCompactionDetails).delta, { status: "stale", sourceCompactionEntryId: carriedOwner.id });
	manager.branch(base.id);
	await session.reload();
	manager.appendMessage({ role: "user", content: "Independent branch request", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("Independent branch evidence. ".repeat(100)));
	ledgerFaux.setResponses([fauxAssistantMessage("Independent branch ledger. Skills: none.")]);
	await session.compact();
	assert.equal(JSON.stringify(generatedDelta(latestCompaction(manager.getBranch())).inputCoverage).includes(correction), false);
});

test("coverage records task references, exact text prefixes and image representation", async (t) => {
	const saved = { task: process.env.LEDGER_CONTEXT_TASK_TOKENS, tail: process.env.LEDGER_CONTEXT_TAIL_TOKENS };
	process.env.LEDGER_CONTEXT_TASK_TOKENS = "256";
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "256";
	t.after(() => {
		for (const [name, value] of [["LEDGER_CONTEXT_TASK_TOKENS", saved.task], ["LEDGER_CONTEXT_TAIL_TOKENS", saved.tail]]) {
			if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
		}
	});
	const fixture = await createFixture(false, [], 64, { compactionEnabled: false, contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Anchor recorded. Skills: none." })), fauxAssistantMessage("saved")]);
	await session.prompt("Large original task: " + "anchor-content-".repeat(1000));
	const anchor = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
	const longText = "Long observed text: " + "准确🐱内容-".repeat(1000);
	const long = manager.appendMessage({ role: "user", content: longText, timestamp: Date.now() });
	const image = manager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: RED_2X2_PNG }], timestamp: Date.now() });
	manager.appendMessage({ role: "user", content: "Short latest task", timestamp: Date.now() });
	let actualInput = "";
	ledgerFaux.setResponses([(context) => {
		const input = context.messages.find((message) => message.role === "user");
		assert.ok(input);
		actualInput = typeof input.content === "string" ? input.content : input.content.map((block) => block.type === "text" ? block.text : "").join("\n");
		return fauxAssistantMessage("Image references and partial text supplied. Skills: none.");
	}]);
	await session.compact();
	const coverage = generatedDelta(latestCompaction(manager.getBranch())).inputCoverage;
	assert.equal(coverage.representation, "rendered-text-with-image-references");
	const reference = coverage.projections.find((part) => part.entryId === anchor)!;
	assert.equal(reference.kind, "reference");
	assert.equal(reference.providedChars, reference.totalChars);
	assert.ok(reference.providedChars > 0);
	const part = coverage.partialEntries.find((part) => part.entryId === long)!;
	const rendered = `[entry ${long}] user\n${longText}`;
	assert.equal(part.totalChars, rendered.length);
	assert.ok(part.providedChars > 0 && part.providedChars < part.totalChars);
	assert.ok(actualInput.includes(rendered.slice(0, part.providedChars) + "\n[truncated;"));
	assert.ok(actualInput.includes(`pi://entry/${image}/content/0`));
	assert.equal(actualInput.includes(RED_2X2_PNG), false);
	assert.ok(coverage.fullRanges.some((range: any) => {
		const entries = manager.getBranch();
		const index = entries.findIndex(entry => entry.id === image);
		return index >= entries.findIndex(entry => entry.id === range.fromEntryId) && index <= entries.findIndex(entry => entry.id === range.toEntryId);
	}));
});

test("delta updates project the previous delta without recursively copying compaction packets", async (t) => {
	const previousTail = process.env.LEDGER_CONTEXT_TAIL_TOKENS;
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "128";
	t.after(() => { if (previousTail === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS; else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTail; });
	const fixture = await createFixture(false, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0, compactionEnabled: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const { session, sessionManager: manager, ledgerFaux } = fixture;
	manager.appendMessage({ role: "user", content: "Preserve the important checkpoint ledger", timestamp: Date.now() });
	for (let i = 0; i < 180; i++) manager.appendMessage(fauxAssistantMessage(`Evidence ${i}: ${"x".repeat(8000)}`));
	manager.appendMessage({ role: "user", content: "Save the first window", timestamp: Date.now() });
	ledgerFaux.setResponses([fauxAssistantMessage("checkpoint-ledger-sentinel: preserve decisions. Skills: none.")]);
	await session.compact();
	const first = latestCompaction(manager.getBranch());
	const original = JSON.stringify(generatedDelta(first));
	assert.ok(generatedDelta(first).inputCoverage.partialEntries.length >= 100);
	assert.ok(original.length > 8000);
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "4096";
	manager.appendMessage({ role: "user", content: "Keep fresh-work-sentinel in the next ledger", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("Additional recent evidence. ".repeat(30)));
	let input = "";
	ledgerFaux.setResponses([(context) => {
		const user = context.messages.find((message) => message.role === "user");
		assert.ok(user);
		input = typeof user.content === "string" ? user.content : user.content.map((block) => block.type === "text" ? block.text : "").join("\n");
		return fauxAssistantMessage("New ledger. Skills: none.");
	}]);
	await session.compact();
	assert.match(input, /checkpoint-ledger-sentinel/);
	assert.match(input, /fresh-work-sentinel/);
	assert.ok(input.includes(`pi://entry/${first.id}`));
	assert.doesNotMatch(input, /"fullRanges":\[|"partialEntries":\[|"projections":\[|# Ledger Context Recovery/);
	assert.ok(input.length < original.length, "the refresh must not pay for the full manifest");
	const coverage = generatedDelta(latestCompaction(manager.getBranch())).inputCoverage;
	for (const id of [first.id]) {
		const projection = coverage.projections.find((part) => part.entryId === id)!;
		assert.equal(projection.kind, "delta-ledger");
		assert.ok(projection.providedChars > 0 && projection.providedChars <= projection.totalChars);
		assert.equal(coverage.partialEntries.some((part: any) => part.entryId === id), false);
	}
	assert.equal(JSON.stringify(generatedDelta(first)), original);
	let params: Record<string, unknown> | null = { entryId: first.id, length: 65536 };
	let recovered = "";
	for (let count = 0; params; count++) {
		assert.ok(count < 100);
		const result = await inspectHistory(fixture, "history_read", params);
		recovered += (result.details as any).text;
		params = (result.details as any).nextRead;
	}
	assert.ok(recovered.includes(original));
});

test("unmeasured input records expose no invented coverage and reject mixed formats", async (t) => {
	const fixture = await createFixture(false, [], 64, { compactionEnabled: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const data = { schemaVersion: 4, kind: "agent-checkpoint", ledger: "Saved by the agent.", activeRequestEntryIds: [], sourceWindowId: "initial", requestHistoryPosition: { entryId: null, branchDepth: 0 }, inputCoverage: UNMEASURED_INPUT_RECORD };
	for (const invalid of [
		{ ...data, inputCoverage: { ...UNMEASURED_INPUT_RECORD, omittedRanges: [] } },
		{ ...data, inputCoverage: { ...UNMEASURED_INPUT_RECORD, baseCheckpointEntryId: "invented-basis" } },
		{ ...data, schemaVersion: 2 },
	]) {
		const entryId = fixture.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, invalid);
		const read = await inspectHistory(fixture, "history_read", { entryId, projection: "references" });
		assert.equal((read.details as any).fitsCurrentLedgerBudget, false);
		assert.deepEqual((read.details as any).inputRecord, { measurement: "unavailable" });
	}
	const entryId = fixture.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, data);
	const read = await inspectHistory(fixture, "history_read", { entryId });
	assert.deepEqual((read.details as any).inputRecord, { measurement: "unmeasured", source: "agent-context", recoveryBasis: null });
	assert.doesNotMatch((read.details as any).text, /omittedRanges|Input record browse calls/);
});

test("unchanged compactions reuse the delta owner and custom instructions request a new cumulative delta", async (t) => {
	const fixture = await createFixture(false, [], 64, { compactionEnabled: false, extraToolNames: ["history_list_items", "history_list_windows"] });
	t.after(() => { fixture.session.dispose(); rmSync(fixture.root, { recursive: true, force: true }); });
	const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
	faux.setResponses([fauxAssistantMessage("Executed once; source is available."), fauxAssistantMessage("Ready for recovery.")]);
	await session.prompt("Track this operation. " + "source material ".repeat(80));
	await session.prompt("Prepare the recovery summary. " + "current request ".repeat(80));
	ledgerFaux.setResponses([fauxAssistantMessage("Operation completed once; first-delta.")]);
	await session.compact();
	const first = latestCompaction(manager.getBranch());
	for (let index = 0; index < 2; index++) {
		manager.appendCustomMessageEntry(REMINDER_MESSAGE_TYPE, "checkpoint budget reminder ".repeat(20), false);
		await session.compact();
		assert.deepEqual((latestCompaction(manager.getBranch()).details as LedgerCompactionDetails).delta, { status: "reused", sourceCompactionEntryId: first.id });
	}
	assert.equal(ledgerFaux.state.callCount, 1);
	assert.equal(checkpointEntries(manager.getBranch()).length, 0);
	const latest = manager.appendCustomMessageEntry(REMINDER_MESSAGE_TYPE, "checkpoint budget reminder ".repeat(20), false);
	ledgerFaux.setResponses([(context) => {
		assert.match(JSON.stringify(context.messages), /first-delta/);
		assert.match(JSON.stringify(context.messages), /Focus on verification/);
		assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /Write a recovery ledger/);
		return fauxAssistantMessage("Operation completed; verification pending. second-delta.");
	}]);
	await session.compact("Focus on verification");
	const second = latestCompaction(manager.getBranch());
	const record = generatedDelta(second);
	assert.equal(record.scope.afterEntryId, null);
	assert.equal(record.scope.throughEntryId, latest);
	assert.equal(record.inputCoverage.baseDeltaCompactionEntryId, first.id);
	assert.equal(record.inputCoverage.historyScope.afterEntryId, generatedDelta(first).scope.throughEntryId);
	const listed = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["compaction_delta"] }, order: "oldest" });
	assert.deepEqual((listed.details as any).items.map((item: any) => item.entryId), [first.id, second.id]);
	assert.deepEqual((listed.details as any).items.map((item: any) => item.active), [false, true]);
	const checkpoints = await inspectHistory(fixture, "history_list_items", { filter: { kinds: ["checkpoint"] } });
	assert.deepEqual((checkpoints.details as any).items, []);
	const windows = await inspectHistory(fixture, "history_list_windows", { limit: 1 });
	assert.equal((windows.details as any).windows[0].deltaCompactionEntryId, second.id);
	assert.equal((windows.details as any).windows[0].checkpointCount, 0);
});

test("delta selection distinguishes maintenance, filtered messages and recovered history evidence", async (t) => {
	const fixture = await createFixture(false, [], 64, { compactionEnabled: false });
	t.after(() => { fixture.session.dispose(); rmSync(fixture.root, { recursive: true, force: true }); });
	const { session, sessionManager: manager, ledgerFaux } = fixture;
	manager.appendMessage({ role: "user", content: "Track the changes. " + "source material ".repeat(80), timestamp: Date.now() });
	const mixed = manager.appendMessage(fauxAssistantMessage([{ type: "text", text: "Observed new decision." }, fauxToolCall("checkpoint", { ledger: "excluded-checkpoint-argument" }, { id: "maintenance-call" })]));
	const receipt = manager.appendMessage({ role: "toolResult", toolName: "checkpoint", toolCallId: "maintenance-call", isError: false, content: [{ type: "text", text: "excluded-checkpoint-receipt" }], timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("history_read", { entryId: mixed }, { id: "history-evidence" })));
	const evidence = manager.appendMessage({ role: "toolResult", toolName: "history_read", toolCallId: "history-evidence", isError: false, content: [{ type: "text", text: "Recovered user correction: only staging." }], timestamp: Date.now() });
	manager.appendMessage({ role: "user", content: "Continue with the corrected target. " + "current request ".repeat(80), timestamp: Date.now() });
	ledgerFaux.setResponses([(context) => {
		const text = JSON.stringify(context.messages);
		assert.match(text, /Observed new decision/);
		assert.match(text, /Recovered user correction: only staging/);
		assert.doesNotMatch(text, /excluded-checkpoint/);
		return fauxAssistantMessage("User corrected the target to staging.");
	}]);
	await session.compact();
	const coverage = generatedDelta(latestCompaction(manager.getBranch())).inputCoverage;
	assert.equal(coverage.projections.find((part) => part.entryId === mixed)?.kind, "filtered-entry");
	assert.ok(coverage.excludedRanges.some((range) => range.reason === "maintenance" && range.fromEntryId === receipt && range.toEntryId === receipt));
	const entries = manager.getBranch();
	const evidenceIndex = entries.findIndex((entry) => entry.id === evidence);
	assert.ok(coverage.fullRanges.some((range) => entries.findIndex((entry) => entry.id === range.fromEntryId) <= evidenceIndex && entries.findIndex((entry) => entry.id === range.toEntryId) >= evidenceIndex));
});

test("older schemas and corrupt recovery sources stop resume instead of falling back", async (t) => {
	for (const source of ["older-schema", "missing-source", "wrong-kind"] as const) {
		const fixture = await createFixture(false, [], 64, { compactionEnabled: false });
		t.after(() => { fixture.session.dispose(); rmSync(fixture.root, { recursive: true, force: true }); });
		const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
		faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Valid initial baseline." })), fauxAssistantMessage("saved")]);
		await session.prompt("Save working state.");
		const original = checkpointEntries(manager.getBranch()).at(-1)!;
		const data = structuredClone(original.data) as Record<string, any>;
		if (source === "older-schema") data.schemaVersion = 3;
		if (source === "missing-source") {
			data.requestHistoryPosition.entryId = "off-branch-source";
			data.inputCoverage.snapshotThrough = "off-branch-source";
		}
		if (source === "wrong-kind") data.kind = "compaction-delta";
		manager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, data);
		await session.reload();
		let called = false;
		faux.setResponses([() => { called = true; return fauxAssistantMessage("must not receive an older baseline"); }]);
		const errorsBefore = extensionErrors.length;
		await session.prompt("Resume the current baseline.");
		assert.equal(called, false);
		const errors = extensionErrors.splice(errorsBefore);
		assert.ok(errors.length > 0);
		assert.ok(errors.every((error) => /incompatible|invalid schema|not an ancestor/.test(error.error)));
		await assert.rejects(session.compact(), /Compaction cancelled/);
		assert.equal(ledgerFaux.state.callCount, 0);
	}
});

test("compaction provenance must match its native owner even when corrupted IDs are ancestors", async (t) => {
	for (const field of ["firstKeptEntryId", "sourceBranchTip"] as const) {
		const fixture = await createFixture(false, [], 64, { compactionEnabled: false });
		t.after(() => { fixture.session.dispose(); rmSync(fixture.root, { recursive: true, force: true }); });
		const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
		faux.setResponses([fauxAssistantMessage("First result."), fauxAssistantMessage("Second result.")]);
		await session.prompt("First task.");
		await session.prompt("Current task " + "evidence ".repeat(80));
		ledgerFaux.setResponses([fauxAssistantMessage("Observed subsequent results.")]);
		await session.compact();
		const owner = latestCompaction(manager.getBranch());
		const details = owner.details as LedgerCompactionDetails;
		const other = manager.getBranch().find((entry) => entry.type === "message" && entry.id !== details[field])!;
		details[field] = other.id;
		let called = false;
		faux.setResponses([() => { called = true; return fauxAssistantMessage("must not use corrupt recovery"); }]);
		const errorsBefore = extensionErrors.length;
		await session.prompt("Resume.");
		assert.equal(called, false);
		const errors = extensionErrors.splice(errorsBefore);
		assert.ok(errors.length > 0);
		assert.ok(errors.every((error) => /provenance disagrees/.test(error.error)));
	}
});

test("committed compaction restarts volume reminders beyond retained history across reload", async (t) => {
	const saved = { tail: process.env.LEDGER_CONTEXT_TAIL_TOKENS, soft: process.env.LEDGER_CONTEXT_REMINDER_TOKENS, urgent: process.env.LEDGER_CONTEXT_URGENT_TOKENS };
	process.env.LEDGER_CONTEXT_TAIL_TOKENS = "6000";
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "100";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "50";
	t.after(() => {
		for (const [name, value] of [["LEDGER_CONTEXT_TAIL_TOKENS", saved.tail], ["LEDGER_CONTEXT_REMINDER_TOKENS", saved.soft], ["LEDGER_CONTEXT_URGENT_TOKENS", saved.urgent]]) {
			if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
		}
	});
	const fixture = await createFixture(true, [], 5000, { contextWindow: 32000, maxTokens: 512, reserveTokens: 0, compactionEnabled: false });
	t.after(() => { fixture.session.dispose(); rmSync(fixture.root, { recursive: true, force: true }); });
	const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Preserve the task state." })), fauxAssistantMessage("Saved.")]);
	await session.prompt("Save the baseline.");
	const checkpoint = checkpointEntries(manager.getBranch()).at(-1)!;
	const original = JSON.stringify(checkpoint.data);
	manager.appendMessage({ role: "user", content: "Earlier work " + "x".repeat(30000), timestamp: Date.now() });
	manager.appendMessage({ role: "user", content: "Retained work " + "r".repeat(16000), timestamp: Date.now() });
	ledgerFaux.setResponses([fauxAssistantMessage("Subsequent work remains available in history.")]);
	await session.compact();
	const compact = latestCompaction(manager.getBranch());
	const entries = manager.getBranch();
	const compactIndex = entries.findIndex((entry) => entry.id === compact.id);
	const retained = entries.slice(entries.findIndex((entry) => entry.id === compact.firstKeptEntryId), compactIndex).flatMap(sessionEntryToContextMessages);
	assert.ok(retained.reduce((total, message) => total + estimateTokens(message), 0) >= 3200);
	const notices = () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE);
	for (const reload of [false, true]) {
		if (reload) await session.reload();
		faux.setResponses([(context) => { assert.doesNotMatch(JSON.stringify(context.messages), /Ledger Context stale-volume reminder/); return fauxAssistantMessage("Ready."); }]);
		await session.prompt("Resume.");
		assert.equal(notices().length, 0, "retained pre-compaction work must not trigger a new volume reminder");
	}
	manager.appendMessage({ role: "user", content: "New work " + "n".repeat(13200), timestamp: Date.now() });
	faux.setResponses([fauxAssistantMessage("Fresh work recorded.")]);
	await session.prompt("Continue.");
	assert.equal(notices().length, 1);
	const notice = notices()[0];
	assert.equal(notice.type, "custom_message");
	if (notice.type === "custom_message") {
		const details = notice.details as { windowId: string; checkpointEntryId: string; fromEntryId: string };
		assert.equal(details.windowId, (compact.details as LedgerCompactionDetails).windowId);
		assert.equal(details.checkpointEntryId, checkpoint.id);
		assert.ok(manager.getBranch().findIndex((entry) => entry.id === details.fromEntryId) > compactIndex);
	}
	assert.equal(JSON.stringify(checkpoint.data), original);
});

test("queued volume and budget reminders are rechecked after native compaction before provider delivery", async (t) => {
	const soft = process.env.LEDGER_CONTEXT_REMINDER_TOKENS;
	const urgent = process.env.LEDGER_CONTEXT_URGENT_TOKENS;
	process.env.LEDGER_CONTEXT_REMINDER_TOKENS = "100";
	process.env.LEDGER_CONTEXT_URGENT_TOKENS = "50";
	t.after(() => {
		if (soft === undefined) delete process.env.LEDGER_CONTEXT_REMINDER_TOKENS; else process.env.LEDGER_CONTEXT_REMINDER_TOKENS = soft;
		if (urgent === undefined) delete process.env.LEDGER_CONTEXT_URGENT_TOKENS; else process.env.LEDGER_CONTEXT_URGENT_TOKENS = urgent;
	});
	const resultText = "Result " + "x".repeat(60000);
	const largeTool = (pi: ExtensionAPI) => pi.registerTool({ name: "reminder_crossing", label: "Crossing", description: "Produces enough ordinary work to cross the native boundary.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: resultText }], details: {} }) });
	const fixture = await createFixture(true, [largeTool], textTokenEstimate(resultText) + 1, { contextWindow: 32000, maxTokens: 512, reserveTokens: 20000, extraToolNames: ["reminder_crossing"] });
	t.after(() => { fixture.session.dispose(); rmSync(fixture.root, { recursive: true, force: true }); });
	const { session, sessionManager: manager, faux, ledgerFaux } = fixture;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "Current task baseline." })), fauxAssistantMessage("Saved.")]);
	await session.prompt("Save current state.");
	const checkpoint = checkpointEntries(manager.getBranch()).at(-1)!;
	ledgerFaux.setResponses([fauxAssistantMessage("The tool returned a large result; inspect it as needed.")]);
	let request: Context | undefined;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("reminder_crossing", {})), (context) => { request = context; return fauxAssistantMessage("Recovered."); }]);
	await session.prompt("Run the tool.");
	assert.ok(request);
	const compact = latestCompaction(manager.getBranch());
	const entries = manager.getBranch();
	const notice = entries.find((entry) => entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE && entry.parentId === compact.id);
	assert.ok(notice && notice.type === "custom_message", "reproduce a pre-compaction notice persisted after the compaction entry");
	assert.notEqual((notice.details as { usageWindowId: string }).usageWindowId, (compact.details as LedgerCompactionDetails).windowId);
	assert.doesNotMatch(JSON.stringify(request.messages), /Ledger Context (stale-volume|soft budget|urgent budget) reminder/);
	assert.equal(checkpointEntries(entries).at(-1)?.id, checkpoint.id);
});

test("capacity failures are reported and extension handlers have no unexpected errors", () => {
	assert.equal(extensionErrors.length, 4);
	for (const [index, pattern] of [
		/the active compaction summary uses \d+ tokens, above the \d+-token recovery budget/,
		/stored checkpoint cannot fit the current budget: ledger exceeds 4096 estimated tokens/,
		/mandatory context requires \d+ tokens, above the 128-token recovery budget/,
		/fixed context uses \d+ tokens, output reserve uses 6, and the 64-token window cannot fit recovery metadata/,
	].entries()) {
		assert.equal(extensionErrors[index].event, "context");
		assert.match(extensionErrors[index].error, pattern);
	}
});
