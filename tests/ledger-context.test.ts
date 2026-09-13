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
import { Type, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY_TYPE, MAX_HISTORY_IMAGE_BASE64_BYTES, REMINDER_MESSAGE_TYPE, createLedgerContext, type LedgerContextSettingsReader } from "../src/ledger-context.ts";

const TEST_TIMEOUT_MS = 5_000;
const extensionErrors: ExtensionError[] = [];
const RED_2X2_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const BLUE_3X2_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEElEQVR4nGNgYPj/H4GROACPigv118uacgAAAABJRU5ErkJggg==";

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

function conservativeContextTokens(context: Context, session: AgentSession, outputReserve: number): number {
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
		textTokenEstimate(context.systemPrompt ?? "") +
		textTokenEstimate(activeToolSchemas) +
		textTokenEstimate(modelMetadata) +
		outputReserve
	);
}

function registerFixtureProvider(modelRuntime: ModelRuntime, faux: ReturnType<typeof fauxProvider>) {
	// Separate scripts for maintenance generation keep ordinary run assertions meaningful.
	const ledgerFaux = fauxProvider({ provider: faux.provider.id, models: faux.models, tokenSize: { min: 1_024, max: 1_024 } });
	const providerFor = (context: Context) => context.systemPrompt?.startsWith("Write a recovery ledger for this session.")
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
		: options.settingsReader ?? (() => ({ source: "fixture SettingsManager", compaction: settingsManager.getCompactionSettings() }));
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
		for (const phrase of ["important decisions", "goal/status", "constraints/decisions", "verified results", "next step/wait", "artifact/recovery", "suggested skills (or none)", "plans from facts", "redact secrets"]) {
			assert.ok(checkpointGuidance.includes(phrase), `checkpoint guidance must include ${phrase}`);
		}
		let historySearchResult: Extract<SessionEntry, { type: "message" }> | undefined;
		faux.setResponses([
			(context) => fauxAssistantMessage(
				fauxToolCall("checkpoint", { ledger: "packaged smoke ledger" }),
				{ stopReason: "toolUse" },
			),
			(context) => fauxAssistantMessage(
				fauxToolCall("history_search", { query: "packaged smoke", limit: 5 }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				historySearchResult = messageEntries(sessionManager.getBranch()).find(
					(entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search",
				);
				assert.ok(historySearchResult);
				const details = (historySearchResult.message as { details?: unknown }).details as { hits?: Array<{ entryId?: string }> } | undefined;
				assert.ok(details?.hits?.[0]?.entryId);
				return fauxAssistantMessage(
					fauxToolCall("history_read", { entryId: details.hits[0].entryId, offset: 0, length: 128 }),
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
		assert.equal(reloadHandoffs.length, 1);
		assert.deepEqual(newManager.getBranch().filter((entry) => entry.id !== reloadHandoffs[0].id).map((entry) => entry.id), newBranchBeforeReload);
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
	const { root, faux, session, sessionManager } = await createFixture(true);
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
		assert.match(JSON.stringify(toolReceiptMessage.content), /native compaction threshold/);
		assert.equal((toolReceiptMessage.details as { checkpointEntryId: string }).checkpointEntryId, checkpoint.id);
		assert.equal((toolReceiptMessage.details as { windowId: string }).windowId, checkpointData.sourceWindowId);
		assert.equal(faux.state.callCount, 2);
		assert.equal(sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);

		await session.compact("keep the task request visible");
		const branch = sessionManager.getBranch();
		const compaction = branch.filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		assert.ok(branch.some((entry) => entry.id === compaction.firstKeptEntryId));
		assert.equal((compaction.details as { schemaVersion: number; kind: string }).schemaVersion, 1);
		assert.equal((compaction.details as { schemaVersion: number; kind: string }).kind, "ledger-context");
		const provenance = compaction.details as {
			checkpointEntryId: string | null;
			previousCheckpointEntryId: string | null;
			requestHistoryPosition: { entryId: string | null; branchDepth: number } | null;
			lastUserEntryId: string | null;
			lastAssistantEntryId: string | null;
		};
		const lastAssistant = messageEntries(branch).filter((entry) => entry.message.role === "assistant").at(-1);
		assert.ok(lastAssistant);
		assert.equal(provenance.checkpointEntryId, checkpoint.id);
		assert.equal(provenance.previousCheckpointEntryId, null);
		assert.equal(provenance.requestHistoryPosition?.entryId, userEntryId);
		assert.equal(provenance.lastUserEntryId, userEntryId);
		assert.equal(provenance.lastAssistantEntryId, lastAssistant.id);
		assert.match(compaction.summary, /preserve the task across compaction/);
		assert.match(compaction.summary, /previousCheckpointEntryId: \(none\)/);
		assert.match(compaction.summary, new RegExp(`requestHistoryPosition: entry=${userEntryId}`));
		assert.match(compaction.summary, /Continue the ledger integration task/);
		assert.match(compaction.summary, /tool call checkpoint/);
		assert.match(compaction.summary, /toolResult/);
		assert.equal(faux.state.callCount, 2, "manual compaction must not call the model");
		assert.match(readFileSync(sessionManager.getSessionFile()!, "utf8"), /ledger-context\/checkpoint/);
		const assistantEntry = messageEntries(sessionManager.getBranch()).find((entry) => entry.message.role === "assistant");
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
		sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { malformed: true });

		await session.compact();
		const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		assert.ok(compaction);
		const details = compaction.details as {
			checkpointEntryId: string | null;
			previousCheckpointEntryId: string | null;
			requestHistoryPosition: { entryId: string | null; branchDepth: number } | null;
			lastUserEntryId: string | null;
			lastAssistantEntryId: string | null;
		};
		assert.equal(details.checkpointEntryId, secondCheckpoint.id);
		assert.equal(details.previousCheckpointEntryId, firstCheckpoint.id);
		assert.equal(details.requestHistoryPosition?.entryId, secondUser.id);
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: "provenance partial", scope: "all", limit: 10 })),
			fauxAssistantMessage("partial provenance search complete"),
		]);
		await session.prompt("check partial provenance statuses");
		const partialSearch = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(partialSearch);
		const partialHits = (partialSearch.message as { details: { hits: Array<{ executionStatus: string }> } }).details.hits;
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
		contextWindow: 4_000,
		maxTokens: 100,
		reserveTokens: 500,
		extraToolNames: ["large_result_first", "large_result_second"],
	});
	try {
		let resumedContext: Context | undefined;
		const toolCallIds = ["same-run-large-tool-first", "same-run-large-tool-second"];
		ledgerFaux.setResponses([fauxAssistantMessage("native-generated-ledger: Large operations returned; verify evidence before repeating. Skills: none.")]);
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
		assert.equal(ledgerFaux.state.callCount, 1);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 1);
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
		contextWindow: 4_000,
		maxTokens: 128,
		reserveTokens: 500,
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
			wrapResponse(() => fauxAssistantMessage(fauxToolCall("history_search", { query: "long-operation-result:long-operation-01", scope: "tools", limit: 5 }), { stopReason: "toolUse" })),
			wrapResponse((context) => {
				historySearchContext = context;
				const searchResult = sessionManager.getBranch().find(
					(entry): entry is Extract<SessionEntry, { type: "message" }> =>
						entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "history_search",
				);
				assert.ok(searchResult);
				const searchDetails = (searchResult.message as { details?: unknown }).details as { hits?: Array<{ entryId?: string; snippet?: string }> } | undefined;
				const hit = searchDetails?.hits?.find((candidate) => candidate.snippet?.includes("long-operation-result:long-operation-01"));
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
		assert.match(JSON.stringify(extraContext.messages), /Ledger Context urgent budget reminder/);
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
		contextWindow: 8_000,
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
							block.text.includes(`window: ${latestDetails.windowId}`),
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
		assert.equal(details.level, "urgent");
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
			schemaVersion: 1,
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

test("external runs receive one settled reminder while extension work stays internal", { timeout: TEST_TIMEOUT_MS }, async () => {
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
		assert.equal(remindersAfterSecond.length, 1);
		const externalReminderCountBeforeExtension = remindersAfterSecond.filter((entry) =>
			(entry.details as { reasonKinds?: string[] }).reasonKinds?.includes("external-run"),
		).length;
		assert.equal(externalReminderCountBeforeExtension, 1);
		assert.match(JSON.stringify(remindersAfterSecond[0].details), /external-run/);
		assert.match(JSON.stringify(secondContext.messages), /cause: external run/);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("extension_probe", {}, { id: "extension-probe-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("extension initiated work completed"),
		]);
		await session.sendUserMessage("extension initiated work");
		const remindersAfterExtension = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
		);
		assert.equal(remindersAfterExtension.filter((entry) =>
			(entry.details as { reasonKinds?: string[] }).reasonKinds?.includes("external-run"),
		).length, externalReminderCountBeforeExtension);
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

test("external provenance survives compaction reload while extension work stays internal", { timeout: TEST_TIMEOUT_MS }, async () => {
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
		assert.equal(runRecords.length, 1);
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
				return fauxAssistantMessage("reload received old-window reminder");
			}]);
			await reopened.session.prompt("next external input after reload");
			assert.ok(resumedContext);
			const providerText = JSON.stringify(resumedContext.messages);
			assert.match(providerText, new RegExp("window: " + oldWindowId));
			assert.match(providerText, /external run/);
			const reminders = reopened.sessionManager.getBranch().filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE,
			);
			assert.equal(reminders.length, 1);
			assert.ok((reminders[0].details as { reasonKinds?: string[] }).reasonKinds?.includes("external-run"));
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

test("reload handoff preserves an active external run through settlement", { timeout: 10_000 }, async () => {
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
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_gate", {}, { id: "reload-gate-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("active run settled after reload"),
		]);
		const runPromise = session.prompt("reload while the external run is active");
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
		assert.equal(records.length, 1);
		const handoff = handoffs[0].data as { externalRun?: { startPosition?: unknown; checkpointEntryId?: string | null; windowId?: string } };
		assert.ok(handoff.externalRun?.startPosition);
		assert.equal(handoff.externalRun?.checkpointEntryId, null);
		assert.equal(typeof handoff.externalRun?.windowId, "string");
		await session.reload();
		const pendingHandoffs = sessionManager.getBranch().filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === "ledger-context/reminder-handoff",
		);
		assert.equal(pendingHandoffs.length, 2);
		const pendingHandoff = pendingHandoffs.at(-1)!.data as { pendingReminderReasons?: unknown[] };
		assert.ok((pendingHandoff.pendingReminderReasons?.length ?? 0) > 0);
		await session.setModel(faux.getModel());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_gate", {}, { id: "extension-after-model-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("extension-origin work after model selection"),
		]);
		await session.sendUserMessage("extension-origin work after model selection");
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ledger-context/external-run").length, 1);
		let nextExternalContext: Context | undefined;
		faux.setResponses([(context) => {
			nextExternalContext = context;
			return fauxAssistantMessage("next external run after reload handoff");
		}]);
		await session.prompt("next external run after reload handoff");
		assert.ok(nextExternalContext);
		assert.match(JSON.stringify(nextExternalContext.messages), /external run/);
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
		assert.ok(compactions.every((entry) => entry.fromHook === true && (entry.details as { schemaVersion?: number; kind?: string }).schemaVersion === 1));
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
		assert.equal(reminders.length, 1);
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: searchQuery, scope: "all", limit: 5 })),
			fauxAssistantMessage("history lookup complete"),
		]);
		await session.prompt("look up the old checkpoint");
		const searchResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(searchResult);
		const searchDetails = (searchResult.message as { details: { hits: Array<{ entryId: string; windowId: string; role: string; executionStatus: string }>; nextCursor: string | null } }).details;
		assert.ok(searchDetails.hits.some((hit) => hit.entryId === oldCheckpoint.id));
		assert.ok(searchDetails.hits.every((hit) => hit.windowId.startsWith("window:")));
		assert.ok(searchDetails.hits.some((hit) => hit.role === "assistant" && hit.executionStatus === "requested"));
		assert.ok(searchDetails.hits.some((hit) => hit.entryId === oldCheckpoint.id && hit.role === "custom" && hit.executionStatus === "saved"));
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: "first-retained-sentinel", limit: 5 })),
			fauxAssistantMessage("retained sentinel lookup complete"),
		]);
		await session.prompt("find the first retained sentinel");
		const retainedSearch = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(retainedSearch);
		const retainedSearchDetails = (retainedSearch.message as { details: { hits: Array<{ entryId: string; role: string; executionStatus: string }> } }).details;
		const retainedHit = retainedSearchDetails.hits.find((hit) => hit.entryId === firstRetainedEntryId);
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
			fauxAssistantMessage(fauxToolCall("history_search", { query, limit: 1 })),
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
				fauxAssistantMessage(fauxToolCall("history_search", { query, cursor, limit: 1 })),
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: mainText })),
			fauxAssistantMessage("branch search complete"),
		]);
		await session.prompt("search this branch");
		const branchSearch = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(branchSearch);
		assert.deepEqual((branchSearch.message as { details: { hits: unknown[] } }).details.hits, []);

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
				fauxToolCall("history_search", { query: "x", limit: 101 }),
				fauxToolCall("history_read", { entryId: sessionManager.getLeafId(), offset: -1 }),
				fauxToolCall("history_search", { query: hugeIdentifier }),
				fauxToolCall("history_read", { entryId: hugeIdentifier }),
				fauxToolCall("history_search", { query: "x", windowId: hugeIdentifier }),
				fauxToolCall("history_search", { query: "x", cursor: hugeIdentifier }),
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: "absent-first" }, { id: repeatedId })),
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: laterText }, { id: repeatedId })),
			fauxAssistantMessage("fresh search complete"),
		]);
		await session.prompt("run a fresh search");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(result);
		const details = (result.message as { details: { hits: Array<{ entryId: string; role: string; executionStatus: string }>; nextCursor: string | null } }).details;
		assert.ok(details.hits.some((hit) => hit.entryId === later.id));
		assert.ok(details.hits.some((hit) => hit.role === "assistant" && hit.executionStatus === "completed"));
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
			faux.setResponses([fauxAssistantMessage(fauxToolCall("history_search", { role: "user", ...params })), fauxAssistantMessage("done")]);
			await session.prompt("Run the history lookup.");
			const result = messageEntries(sessionManager.getBranch()).filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search").at(-1)!;
			assert.ok(result);
			assertHistoryOutputWithinTokens(result);
			return {
				text: toolResultText(result),
				isError: result.message.role === "toolResult" && result.message.isError,
				details: (result.message as { details: { caseSensitive: boolean; hits: Array<{ entryId: string; matchOffset: number; snippet: string }>; nextCursor: string | null } }).details,
			};
		};
		const first = await search({ query: "timeout", limit: 1 });
		assert.equal(first.isError, false);
		assert.equal(first.details.caseSensitive, false);
		assert.deepEqual(first.details.hits.map((hit) => hit.entryId), [ids[2]]);
		assert.ok(first.details.nextCursor);
		assert.match(first.text, /case-insensitive literal/);
		sessionManager.appendMessage({ role: "user", content: "late TIMEOUT", timestamp: Date.now() });
		const next = await search({ query: "timeout", caseSensitive: false, limit: 1, cursor: first.details.nextCursor });
		assert.deepEqual(next.details.hits.map((hit) => hit.entryId), [ids[1]]);
		const mismatch = await search({ query: "timeout", caseSensitive: true, cursor: first.details.nextCursor });
		assert.equal(mismatch.isError, true);
		assert.match(mismatch.text, /history_cursor_invalid/);
		const strict = await search({ query: "Timeout", caseSensitive: true });
		assert.equal(strict.details.caseSensitive, true);
		assert.deepEqual(strict.details.hits.map((hit) => hit.entryId), [ids[0]]);
		assert.match(strict.text, /case-sensitive literal/);
		const literal = await search({ query: "[A+B]." });
		assert.deepEqual(literal.details.hits.map((hit) => hit.entryId), [...ids].reverse());
		assert.equal((await search({ query: ".*" })).details.hits.length, 0);
		const unicode = await search({ query: "TIMEOUT" });
		const originalHit = unicode.details.hits.find((hit) => hit.entryId === ids[0]);
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
				fauxToolCall("history_search", { query: maintenanceQuery }, { id: "scope-maintenance-call" }),
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
			fauxAssistantMessage(fauxToolCall("history_search", { query: orderQuery, scope: "conversation", windowId: initialWindowId, limit: 1 })),
			fauxAssistantMessage("scope order search complete"),
		]);
		await session.prompt("search newest conversation entry");
		const first = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(first);
		const firstDetails = (first.message as { details: { scope: string; hits: Array<{ entryId: string }>; nextCursor: string | null } }).details;
		assert.equal(firstDetails.scope, "conversation");
		assert.equal(firstDetails.hits[0].entryId, newerId);
		assert.ok(firstDetails.nextCursor);

		const postSnapshotId = sessionManager.appendMessage({ role: "user", content: orderQuery, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", {
				query: orderQuery,
				scope: "conversation",
				windowId: initialWindowId,
				cursor: firstDetails.nextCursor,
				limit: 10,
			})),
			fauxAssistantMessage("scope snapshot continuation complete"),
		]);
		await session.prompt("continue the captured conversation snapshot");
		const continuation = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(continuation);
		const continuationDetails = (continuation.message as { details: { hits: Array<{ entryId: string }> } }).details;
		assert.ok(continuationDetails.hits.some((hit) => hit.entryId === olderId));
		assert.equal(continuationDetails.hits.some((hit) => hit.entryId === postSnapshotId), false);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: conversationQuery, scope: "conversation", limit: 10 })),
			fauxAssistantMessage("mixed conversation search complete"),
		]);
		await session.prompt("search mixed assistant text");
		const mixedConversation = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(mixedConversation);
		assert.ok((mixedConversation.message as { details: { hits: Array<{ entryId: string }> } }).details.hits.some((hit) => hit.entryId === mixedId));

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: thinkingQuery, scope: "conversation", limit: 10 })),
			fauxAssistantMessage("thinking scope search complete"),
		]);
		await session.prompt("search conversation text only");
		const thinkingResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(thinkingResult);
		assert.deepEqual((thinkingResult.message as { details: { hits: unknown[] } }).details.hits, []);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: toolQuery, scope: "tools", limit: 10 })),
			fauxAssistantMessage("tools scope search complete"),
		]);
		await session.prompt("search ordinary tool evidence");
		const toolsResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(toolsResult);
		const toolsDetails = (toolsResult.message as { details: { scope: string; hits: Array<{ entryId: string }> } }).details;
		assert.equal(toolsDetails.scope, "tools");
		assert.ok(toolsDetails.hits.some((hit) => hit.entryId === mixedId));
		assert.ok(toolsDetails.hits.some((hit) => hit.entryId === resultId));
		assert.equal(toolsDetails.hits.some((hit) => hit.entryId === olderId), false);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: maintenanceQuery, scope: "conversation", limit: 10 })),
			fauxAssistantMessage("conversation maintenance search complete"),
		]);
		await session.prompt("exclude maintenance tool echo from conversation");
		const conversationMaintenance = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(conversationMaintenance);
		assert.deepEqual((conversationMaintenance.message as { details: { hits: unknown[] } }).details.hits, []);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: maintenanceQuery, scope: "all", limit: 10 })),
			fauxAssistantMessage("all scope search complete"),
		]);
		await session.prompt("search all maintenance evidence");
		const allResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(allResult);
		const allDetails = (allResult.message as { details: { scope: string; hits: Array<{ entryId: string }> } }).details;
		assert.equal(allDetails.scope, "all");
		assert.ok(allDetails.hits.some((hit) => hit.entryId === mixedId));
		assert.ok(allDetails.hits.some((hit) => hit.entryId === maintenanceId));
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
			fauxAssistantMessage(fauxToolCall("history_search", { query, scope: "conversation", limit: 3 })),
			fauxAssistantMessage("bounded snippet search complete"),
		]);
		await session.prompt("find the bounded snippet entries");
		const result = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(result);
		const hits = (result.message as { details: { hits: Array<{ snippet: string; matchOffset: number }> } }).details.hits;
		assert.equal(hits.length, 3);
		assert.ok(hits.every((hit) => hit.snippet.length <= 300));
		assert.ok(hits.every((hit) => hit.matchOffset >= 0));

		const longQuery = "q".repeat(3_000);
		sessionManager.appendMessage({ role: "user", content: `${longQuery}-long-query-entry`, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: longQuery, scope: "conversation", limit: 1 })),
			fauxAssistantMessage("long query snippet search complete"),
		]);
		await session.prompt("find the long query entry");
		const longResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(longResult);
		const longHits = (longResult.message as { details: { hits: Array<{ snippet: string }> } }).details.hits;
		assert.equal(longHits.length, 1);
		assert.ok(longHits[0].snippet.length <= 300);

		const utf8Query = "é".repeat(4_090);
		const olderUtf8Id = sessionManager.appendMessage({ role: "user", content: `${utf8Query} utf8-older`, timestamp: Date.now() });
		const newerUtf8Id = sessionManager.appendMessage({ role: "user", content: `${utf8Query} utf8-newer`, timestamp: Date.now() });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: utf8Query, scope: "conversation", limit: 1 })),
			fauxAssistantMessage("long UTF-8 query first page complete"),
		]);
		await session.prompt("find the near-limit UTF-8 query entries");
		const utf8First = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(utf8First);
		const utf8FirstDetails = (utf8First.message as { details: { hits: Array<{ entryId: string }>; nextCursor: string | null } }).details;
		assert.equal(utf8FirstDetails.hits[0].entryId, newerUtf8Id);
		assert.ok(utf8FirstDetails.nextCursor);
		assert.ok(utf8FirstDetails.nextCursor.length <= 1_024);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", {
				query: utf8Query,
				scope: "conversation",
				cursor: utf8FirstDetails.nextCursor,
				limit: 1,
			})),
			fauxAssistantMessage("long UTF-8 query continuation complete"),
		]);
		await session.prompt("continue the near-limit UTF-8 query page");
		const utf8Second = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(utf8Second);
		const utf8SecondDetails = (utf8Second.message as { details: { hits: Array<{ entryId: string }> } }).details;
		assert.equal(utf8SecondDetails.hits[0].entryId, olderUtf8Id);
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
			fauxAssistantMessage(fauxToolCall("history_search", { query, windowId: firstWindowId, limit: 1 })),
			fauxAssistantMessage("first page complete"),
		]);
		await session.prompt("lookup the captured window page");
		const first = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(first);
		const firstDetails = (first.message as { details: { hits: Array<{ entryId: string; windowId: string }>; nextCursor: string | null } }).details;
		assert.equal(firstDetails.hits[0].entryId, newerId);
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
			fauxAssistantMessage(fauxToolCall("history_search", {
				query,
				scope: "conversation",
				windowId: firstDetails.hits[0].windowId,
				cursor: firstDetails.nextCursor,
				limit: 10,
			})),
			fauxAssistantMessage("second page complete"),
		]);
		await session.prompt("continue the captured history page");
		const second = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_search")
			.at(-1);
		assert.ok(second);
		const secondDetails = (second.message as { details: { hits: Array<{ entryId: string; windowId: string }> } }).details;
		assert.ok(secondDetails.hits.some((hit) => hit.entryId === olderId));
		assert.ok(secondDetails.hits.every((hit) => hit.windowId === firstDetails.hits[0].windowId));

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", {
				query,
				scope: "conversation",
				windowId: `${firstWindowId}-mismatch`,
				cursor: firstDetails.nextCursor,
				limit: 10,
			})),
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

		const assertInvalidCursor = async (parameters: Record<string, unknown>, prompt: string): Promise<void> => {
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
			{ query: `${query}-query-mismatch`, scope: "conversation", windowId: firstWindowId, cursor: firstDetails.nextCursor, limit: 10 },
			"reject the query-mismatched captured history page",
		);
		await assertInvalidCursor(
			{ query, scope: "all", windowId: firstWindowId, cursor: firstDetails.nextCursor, limit: 10 },
			"reject the scope-mismatched captured history page",
		);
		await assertInvalidCursor(
			{ query, scope: "conversation", role: "user", windowId: firstWindowId, cursor: firstDetails.nextCursor, limit: 10 },
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
				{ query: conversationQuery, scope: "conversation" },
				undefined,
				undefined,
				{ sessionManager } as never,
			);
			const conversationHits = (conversationResult as { details: { hits: Array<{ entryId: string }> } }).details.hits;
			assert.deepEqual(conversationHits.map((hit) => hit.entryId), [conversationTargetId]);

			manager.getBranch = () => toolsGuardedBranch;
			const toolsResult = await historySearch.execute(
				"guarded-tools",
				{ query: toolsQuery, scope: "tools" },
				undefined,
				undefined,
				{ sessionManager } as never,
			);
			const toolsHits = (toolsResult as { details: { hits: Array<{ entryId: string }> } }).details.hits;
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
		assert.ok(conservativeContextTokens(capturedContext, session, 30_000) <= model.contextWindow);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (previousTailLimit === undefined) delete process.env.LEDGER_CONTEXT_TAIL_TOKENS;
		else process.env.LEDGER_CONTEXT_TAIL_TOKENS = previousTailLimit;
		if (previousReserve === undefined) delete process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS;
		else process.env.LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS = previousReserve;
	}
});

test("history_read imageIndex returns one normalized image at its original content index", { timeout: 10_000 }, async () => {
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
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, imageIndex: 3 }), { stopReason: "toolUse" }),
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
		assert.equal(resultMessage.details?.imageIndex, 3);
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
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: resizedEntryId, imageIndex: 0 })),
			fauxAssistantMessage("resized image complete"),
		]);
		await session.prompt("read resized image");
		const resizedResult = messageEntries(sessionManager.getBranch())
			.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
			.at(-1);
		assert.ok(resizedResult);
		const resizedDetails = (resizedResult.message as { details: { width: number; height: number; originalWidth: number; originalHeight: number; wasResized: boolean; imageIndex: number } }).details;
		assert.equal(resizedDetails.imageIndex, 0);
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
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: customEntryId, imageIndex: 1 })),
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
		const resultMessage = result.message as { content: unknown; details: { entryId: string; imageIndex: number; reference: string; role: string } };
		assert.equal(resultMessage.details.entryId, customEntryId);
		assert.equal(resultMessage.details.imageIndex, 1);
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
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, imageIndex: 0 })),
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
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, imageIndex: 0 })),
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
		const runRead = async (params: Record<string, unknown>, prompt: string) => {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("history_read", params)),
				fauxAssistantMessage("image validation complete"),
			]);
			await session.prompt(prompt);
			return messageEntries(sessionManager.getBranch())
				.filter((entry) => entry.message.role === "toolResult" && entry.message.toolName === "history_read")
				.at(-1);
		};
		const conflict = await runRead({ entryId: validEntryId, imageIndex: 2, offset: 0 }, "read image with conflicting text offset");
		assert.ok(conflict);
		assert.equal((conflict.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((conflict.message as { content: unknown }).content), new RegExp("pi://entry/" + validEntryId + "/content/2"));
		assert.equal(JSON.stringify((conflict.message as { content: unknown }).content).includes('"type":"image"'), false);
		const invalid = await runRead({ entryId: invalidEntryId, imageIndex: 1 }, "read invalid image bytes");
		assert.ok(invalid);
		assert.equal((invalid.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((invalid.message as { content: unknown }).content), new RegExp("pi://entry/" + invalidEntryId + "/content/1"));
		assert.equal(JSON.stringify((invalid.message as { content: unknown }).content).includes('"type":"image"'), false);
		const missing = await runRead({ entryId: validEntryId, imageIndex: 99 }, "read missing image block");
		assert.ok(missing);
		assert.equal((missing.message as { isError: boolean }).isError, true);
		assert.match(JSON.stringify((missing.message as { content: unknown }).content), new RegExp("pi://entry/" + validEntryId + "/content/99"));
		process.env.LEDGER_CONTEXT_READ_TOKENS = "256";
		const readLimited = await runRead({ entryId: validEntryId, imageIndex: 2 }, "read image over the history output budget");
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
			fauxAssistantMessage(fauxToolCall("history_read", { entryId: sourceEntryId, imageIndex: 0 })),
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
		const redEntryId = sessionManager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: RED_2X2_PNG }], timestamp: Date.now() });
		const blueEntryId = sessionManager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: BLUE_3X2_PNG }], timestamp: Date.now() });
		let providerContext: Context | undefined;
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("history_read", { entryId: redEntryId, imageIndex: 0 }, { id: "mixed-red-call" }),
				fauxToolCall("history_read", { entryId: blueEntryId, imageIndex: 0 }, { id: "mixed-blue-call" }),
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
		assert.match(JSON.stringify(largeResultMessage.content), /mixed-large-result/);
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
					Array.from({ length: 5 }, (_value, index) => fauxToolCall("history_read", { entryId: sourceEntryId, imageIndex: 0 }, { id: "capacity-image-call-" + index })),
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
					fauxToolCall("history_read", { entryId: sourceEntryId, imageIndex: 3 }, { id: "native-history-image-call" }),
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

test("missing checkpoint generation saves bounded evidence once and survives reopening", { timeout: TEST_TIMEOUT_MS }, async () => {
	const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { contextWindow: 16_000, maxTokens: 512, reserveTokens: 0 });
	try {
		faux.setResponses([fauxAssistantMessage("Verified result: operation completed once."), fauxAssistantMessage("Next: inspect the result.")]);
		await session.prompt("Goal: preserve the approved operation.");
		await session.prompt(`Latest constraint: keep Unicode 原文. ${"材料".repeat(30_000)}`);
		const ledger = "Goal: preserve the approved operation. Verified: operation completed once. Next: inspect the result. Skills: none. Earlier omitted evidence needs history_read.";
		ledgerFaux.setResponses([(context, options, _state, model) => {
			assert.equal(context.tools?.length ?? 0, 0);
			assert.equal(options?.timeoutMs, undefined, "ledger generation must not impose a waiting timeout");
			assert.equal(options?.maxRetries, 0);
			assert.match(context.systemPrompt ?? "", /bounded selection/);
			const input = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0) + textTokenEstimate(context.systemPrompt);
			assert.ok(input + (options?.maxTokens ?? 0) <= model.contextWindow);
			assert.match(JSON.stringify(context.messages), /Latest constraint/);
			assert.match(JSON.stringify(context.messages), /pi:\/\/entry\//);
			return fauxAssistantMessage(ledger);
		}]);
		await session.compact();
		assert.equal(ledgerFaux.state.callCount, 1);
		const checkpoint = checkpointEntries(sessionManager.getBranch()).at(-1);
		assert.ok(checkpoint);
		assert.equal((checkpoint.data as { ledger: string }).ledger, ledger);
		assert.equal((latestCompaction(sessionManager.getBranch()).details as { checkpointEntryId: string }).checkpointEntryId, checkpoint.id);
		assert.match(latestCompaction(sessionManager.getBranch()).summary, /operation completed once/);
		const reopened = SessionManager.open(sessionManager.getSessionFile()!);
		assert.equal(checkpointEntries(reopened.getBranch()).at(-1)?.id, checkpoint.id);
		const position = (checkpoint.data as { requestHistoryPosition: { entryId: string; branchDepth: number } }).requestHistoryPosition;
		const branch = sessionManager.getBranch();
		assert.equal(branch[position.branchDepth - 1].id, position.entryId);
		assert.equal(branch.findIndex((entry) => entry.id === checkpoint.id), position.branchDepth);
		faux.setResponses([fauxAssistantMessage("Continued without regenerating.")]);
		await session.prompt("Continue after the generated checkpoint.");
		await session.compact();
		assert.equal(ledgerFaux.state.callCount, 1);
		assert.equal(checkpointEntries(sessionManager.getBranch()).length, 1);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing checkpoint generation failures use the existing recovery bootstrap", { timeout: TEST_TIMEOUT_MS }, async () => {
	for (const response of [
		() => { throw new Error("generation request failed"); },
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }),
		fauxAssistantMessage(""),
		fauxAssistantMessage("x".repeat(20_000)),
		fauxAssistantMessage("incomplete", { stopReason: "length" }),
		fauxAssistantMessage(fauxToolCall("checkpoint", { ledger: "must not execute" })),
	]) {
		const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
		try {
			faux.setResponses([fauxAssistantMessage("First result."), fauxAssistantMessage("Second result.")]);
			await session.prompt("First request.");
			await session.prompt(`Second request ${"x".repeat(800)}`);
			ledgerFaux.setResponses([response]);
			await session.compact();
			assert.equal(ledgerFaux.state.callCount, 1);
			assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
			assert.match(latestCompaction(sessionManager.getBranch()).summary, /checkpoint missing/);
		} finally {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("missing checkpoint generation cancellation and persistence failures cancel compaction", { timeout: TEST_TIMEOUT_MS }, async () => {
	for (const mode of ["cancel", "write-failure"] as const) {
		const { root, faux, ledgerFaux, session, sessionManager } = await createFixture(true, [], 64, { contextWindow: 32_000, maxTokens: 512, reserveTokens: 0 });
		try {
			faux.setResponses([fauxAssistantMessage("First result."), fauxAssistantMessage("Second result.")]);
			await session.prompt("First request.");
			await session.prompt(`Second request ${"x".repeat(800)}`);
			const beforeGeneration = readFileSync(sessionManager.getSessionFile()!, "utf8");
			ledgerFaux.setResponses([() => {
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
			await assert.rejects(session.compact(), /Compaction cancelled/);
			assert.equal(ledgerFaux.state.callCount, 1);
			assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
			if (mode === "cancel") {
				assert.equal(checkpointEntries(sessionManager.getBranch()).length, 0);
				assert.equal(readFileSync(sessionManager.getSessionFile()!, "utf8"), beforeGeneration);
			} else {
				await assert.rejects(session.compact(), /Compaction cancelled/);
				assert.equal(ledgerFaux.state.callCount, 1);
				assert.equal(checkpointEntries(SessionManager.open(`${sessionManager.getSessionFile()!}.saved`).getBranch()).length, 0);
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

test("compaction details expose missing and stale checkpoint ranges", { timeout: TEST_TIMEOUT_MS }, async () => {
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
			requestHistoryPosition: unknown;
			pendingHistoryRange: { fromEntryId: string | null; toEntryId: string | null };
			sourceBranchTip: string | null;
		};
		assert.equal(details.checkpointEntryId, null);
		assert.equal(details.requestHistoryPosition, null);
		assert.equal(details.pendingHistoryRange.fromEntryId, branchBeforeCompaction[0].id);
		assert.equal(details.pendingHistoryRange.toEntryId, branchBeforeCompaction.at(-1)!.id);
		assert.equal(details.sourceBranchTip, branchBeforeCompaction.at(-1)!.id);
		assert.match(compaction.summary, /checkpoint missing/);
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
			pendingHistoryRange: { fromEntryId: string | null; toEntryId: string | null };
		};
		assert.equal(details.checkpointEntryId, checkpoint.id);
		assert.equal(details.pendingHistoryRange.fromEntryId, expectedFrom);
		assert.equal(details.pendingHistoryRange.toEntryId, expectedTo);
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
		contextWindow: 4_096,
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
				schemaVersion: 1,
				kind: "ledger-context",
				windowId,
				sourceWindowId: `window:${sessionManager.getSessionId()}:initial`,
				checkpointEntryId: null,
				sourceBranchTip: prefixId,
				firstKeptEntryId: retainedIds[0],
				requestHistoryPosition: null,
				pendingHistoryRange: { fromEntryId: prefixId, toEntryId: prefixId },
			},
			true,
		);
		const compaction = sessionManager.getEntry(compactionId);
		assert.ok(compaction && compaction.type === "compaction");
		const summaryCost = conservativeContextTokens(
			{ messages: convertToLlm(sessionEntryToContextMessages(compaction)), systemPrompt: session.systemPrompt } as Context,
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
			schemaVersion: 1,
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
		contextWindow: 2_304,
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

test("extension handlers report no unexpected errors", () => {
	assert.deepEqual(extensionErrors, []);
});
