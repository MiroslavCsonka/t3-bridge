import * as Crypto from "node:crypto";
import * as Path from "node:path";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";

import { AGENT_LAYOUT_MANIFEST_VERSION, MANIFEST_VERSION } from "./adapters/slack/manifest.ts";
import { DiscordAdapter, discordInviteUrl, testDiscordToken } from "./adapters/discord/DiscordAdapter.ts";
import { SlackAdapter, testSlackTokens } from "./adapters/slack/SlackAdapter.ts";
import { TelegramAdapter, testTelegramToken } from "./adapters/telegram/TelegramAdapter.ts";
import { isWorking, type ActivityEntry } from "./core/activity.ts";
import { BotRuntime, type FirstMessage } from "./core/BotRuntime.ts";
import { ButtonStore } from "./core/ButtonStore.ts";
import {
  ConversationRouter,
  type AnnounceRequest,
  type AnnounceResult,
} from "./core/ConversationRouter.ts";
import {
  MEMORY_LINE_LIMIT,
  displayPath,
  memoryDir,
  memoryInstructions,
  readMemory,
  writeMemoryFile,
  type MemoryFile,
} from "./core/memory.ts";
import { categoriesFor, reactionCategoriesOf } from "./core/feedback.ts";
import { DEFAULT_INSTRUCTIONS } from "./core/render.ts";
import { RefusedError, type ChatAdapter } from "./core/types.ts";
import { makeLogger } from "./log.ts";
import {
  ConfigStore,
  readJson,
  writeJsonAtomic,
  type BotConfig,
  type BridgeConfig,
  type ConversationMode,
  type Platform,
  type SecretStore,
} from "./store.ts";
import { makeLocalCredentials, type LocalEnvironmentOptions } from "./t3/localEnvironment.ts";
import { T3Client, type T3ConnectionStatus } from "./t3/T3Client.ts";
import { BRIDGE_VERSION } from "./version.ts";

export interface EngineOptions {
  readonly dataDir: string;
  readonly secrets: SecretStore;
  readonly t3Defaults?: LocalEnvironmentOptions;
  readonly controlPort?: number;
  readonly logSink?: (line: string) => void;
  /** Replaces the chat platform, for tests. */
  readonly makeAdapter?: (bot: BotConfig) => ChatAdapter;
}

export interface BotInput {
  readonly name: string;
  readonly platform: Platform;
  readonly slack?: { readonly botToken: string; readonly appToken: string };
  readonly discord?: { readonly botToken: string };
  readonly telegram?: { readonly botToken: string };
  readonly threadId: string | null;
  readonly allowedUserIds?: ReadonlyArray<string>;
  readonly instructions?: string;
  readonly reminder?: boolean;
  readonly manifestVersion?: number;
  readonly enabled?: boolean;
  readonly conversationMode?: ConversationMode;
  readonly settleAfterDays?: number;
  readonly announceChannels?: ReadonlyArray<string>;
  readonly reactionCategories?: Readonly<Record<string, ReadonlyArray<string>>> | null;
  /** Send the instructions to the thread now, for a thread that was not created by the bridge. */
  readonly sendInstructions?: boolean;
}

export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly pinned: boolean;
  readonly status: string;
  readonly model: string;
  readonly updatedAt: string;
}

const botSecret = (botId: string, name: string) => `bot.${botId}.${name}`;

const DEFAULT_SETTLE_AFTER_DAYS = 7;

const PLATFORM_LABELS: Record<Platform, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
};

export class Engine {
  readonly log;
  readonly config: ConfigStore;
  t3!: T3Client;
  private readonly bots = new Map<string, BotRuntime | ConversationRouter>();
  private bridgeMessages = new Set<string>();

  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
    this.log = makeLogger(options.logSink);
    this.config = new ConfigStore(options.dataDir);
  }

  private get bridgeMessagesFile() {
    return Path.join(this.options.dataDir, "bridge-messages.json");
  }

  async start(): Promise<BridgeConfig> {
    const config = await this.config.load({
      ...(this.options.controlPort === undefined ? {} : { controlPort: this.options.controlPort }),
      t3: this.options.t3Defaults ?? {},
    });
    this.bridgeMessages = new Set((await readJson<string[]>(this.bridgeMessagesFile)) ?? []);
    const credentials = await makeLocalCredentials(config.t3, this.options.secrets);
    this.t3 = new T3Client(credentials, this.log);
    this.t3.start();
    for (const bot of config.bots) await this.startBot(bot);
    this.log.info(`T3 Bridge ${BRIDGE_VERSION} started with ${config.bots.length} bot(s)`);
    return config;
  }

  async stop(): Promise<void> {
    for (const runtime of this.bots.values()) await runtime.stop().catch(() => {});
    this.bots.clear();
    await this.t3?.stop();
  }

  // ── status ──────────────────────────────────────────────────────────────

  status() {
    const config = this.config.get();
    return {
      version: BRIDGE_VERSION,
      manifestVersion: MANIFEST_VERSION,
      t3: describeT3Status(this.t3.status, this.t3.label),
      bots: config.bots.map((bot) => {
        const runtime = this.bots.get(bot.id);
        return {
          ...publicBot(bot),
          connection: runtime?.adapterStatus ?? {
            state: bot.enabled ? "error" : "disabled",
            error: "Not running",
          },
          lastError: runtime?.lastError ?? null,
          manifestOutdated: bot.platform === "slack" && (bot.manifestVersion ?? 1) < MANIFEST_VERSION,
          chatLink: chatLink(bot),
          activity: summarize(runtime?.activity ?? []),
          conversations: runtime instanceof ConversationRouter ? runtime.conversationCount : null,
        };
      }),
    };
  }

  /** A bot's latest requests, newest first. */
  activity(botId: string): ReadonlyArray<ActivityEntry> {
    if (!this.config.get().bots.some((bot) => bot.id === botId)) throw new NotFoundError("No such bot");
    return [...(this.bots.get(botId)?.activity ?? [])].reverse();
  }

  // ── T3 threads ──────────────────────────────────────────────────────────

  async listThreads(): Promise<{
    projects: Array<{ id: string; title: string }>;
    threads: ThreadSummary[];
  }> {
    const shell: OrchestrationV2ShellSnapshot = await this.t3.getShell();
    const projects = new Map(shell.projects.map((project) => [project.id, project.title]));
    const threads = shell.threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.lineage.relationshipToParent !== "subagent",
      )
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        projectTitle: projects.get(thread.projectId) ?? "Project",
        pinned: thread.pinnedAt != null,
        status: thread.status,
        model: thread.modelSelection.model,
        updatedAt: String(thread.updatedAt),
      }))
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.updatedAt.localeCompare(left.updatedAt),
      );
    return {
      projects: shell.projects.map((project) => ({ id: project.id, title: project.title })),
      threads,
    };
  }

  /** Models already in use in a project, newest first, to offer when creating an orchestrator. */
  async modelChoices(projectId: string): Promise<ModelSelection[]> {
    const shell = await this.t3.getShell();
    const project = shell.projects.find((candidate) => candidate.id === projectId);
    const seen = new Map<string, ModelSelection>();
    if (project?.defaultModelSelection)
      seen.set(modelKey(project.defaultModelSelection), project.defaultModelSelection);
    const threads = [...shell.threads].sort((left, right) =>
      String(right.updatedAt).localeCompare(String(left.updatedAt)),
    );
    for (const thread of threads) {
      if (!seen.has(modelKey(thread.modelSelection)))
        seen.set(modelKey(thread.modelSelection), thread.modelSelection);
    }
    return [...seen.values()].slice(0, 12);
  }

  /** Creates and pins an orchestrator thread whose first message is the instructions. */
  async createOrchestratorThread(input: {
    readonly projectId: string;
    readonly title: string;
    readonly instructions?: string;
    readonly modelSelection?: ModelSelection;
    readonly pin?: boolean;
    readonly firstMessage?: FirstMessage;
  }): Promise<{ threadId: string }> {
    const shell = await this.t3.getShell();
    const project = shell.projects.find((candidate) => candidate.id === input.projectId);
    if (project === undefined) throw new Error("That project no longer exists in T3.");
    const modelSelection =
      input.modelSelection ??
      project.defaultModelSelection ??
      shell.threads.find((thread) => thread.projectId === input.projectId)?.modelSelection ??
      shell.threads[0]?.modelSelection;
    if (modelSelection === undefined)
      throw new Error("Pick a model: this project has no default model yet.");
    const instructions = withMemory(
      input.instructions?.trim() || DEFAULT_INSTRUCTIONS,
      memoryDir(project.workspaceRoot),
    );
    const first = input.firstMessage;
    const messageId = MessageId.make(first?.messageId ?? Crypto.randomUUID());
    if (first === undefined) await this.rememberBridgeMessage(messageId);
    const launched = await this.t3.launchThread({
      commandId: CommandId.make(Crypto.randomUUID()),
      creationSource: "mobile",
      projectId: ProjectId.make(input.projectId),
      title: input.title.trim() || "Orchestrator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId,
        text: first === undefined ? instructions : `${instructions}\n\n---\n\n${first.text}`,
        attachments: first?.attachments ?? [],
      },
    });
    if (input.pin !== false)
      await this.t3
        .dispatch({
          type: "thread.pin",
          commandId: CommandId.make(Crypto.randomUUID()),
          threadId: launched.threadId,
        })
        .catch((error: unknown) => this.log.warn("Pinning the new thread failed", error));
    return { threadId: launched.threadId };
  }

  private async sendInstructions(threadId: string, instructions: string) {
    const dir = await this.memoryDirForThread(threadId);
    const messageId = MessageId.make(Crypto.randomUUID());
    await this.rememberBridgeMessage(messageId);
    await this.t3.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(Crypto.randomUUID()),
      createdBy: "user",
      creationSource: "mobile",
      threadId: ThreadId.make(threadId),
      messageId,
      text: dir === null ? instructions : withMemory(instructions, dir),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
  }

  /** The memory folder of the project a thread belongs to; null when T3 no longer has it. */
  private async memoryDirForThread(threadId: string | null): Promise<string | null> {
    if (threadId === null) return null;
    const shell = await this.t3.getShell();
    const thread = shell.threads.find((candidate) => candidate.id === threadId);
    const project = shell.projects.find((candidate) => candidate.id === thread?.projectId);
    return project === undefined ? null : memoryDir(project.workspaceRoot);
  }

  /** The bot's project memory, for the control panel: the index first, then the files it links. */
  async memory(botId: string): Promise<{
    dir: string | null;
    files: MemoryFile[];
    lineLimit: number;
  }> {
    const bot = this.config.get().bots.find((candidate) => candidate.id === botId);
    if (bot === undefined) throw new NotFoundError("No such bot");
    const dir = await this.memoryDirForThread(bot.threadId);
    return {
      dir: dir === null ? null : displayPath(dir),
      files: dir === null ? [] : await readMemory(dir),
      lineLimit: MEMORY_LINE_LIMIT,
    };
  }

  async saveMemory(botId: string, input: { readonly name: string; readonly text: string }) {
    const bot = this.config.get().bots.find((candidate) => candidate.id === botId);
    if (bot === undefined) throw new NotFoundError("No such bot");
    const dir = await this.memoryDirForThread(bot.threadId);
    if (dir === null) throw new Error("Pick a thread first: memory belongs to its project.");
    await writeMemoryFile(dir, input.name, input.text);
    this.log.info(`[${bot.name}] Memory file ${input.name} saved from the control panel`);
    return this.memory(botId);
  }

  private async rememberBridgeMessage(messageId: string) {
    this.bridgeMessages.add(messageId);
    await writeJsonAtomic(this.bridgeMessagesFile, [...this.bridgeMessages].slice(-500));
  }

  // ── bots ────────────────────────────────────────────────────────────────

  async addBot(input: BotInput) {
    const id = Crypto.randomUUID();
    if (!(input.platform in PLATFORM_LABELS)) throw new Error(`Unknown platform ${input.platform}`);
    const saved =
      this.options.makeAdapter === undefined
        ? await this.saveCredentials(id, input.platform, input)
        : {};
    if (saved === null) throw new Error(`${PLATFORM_LABELS[input.platform]} bots need a token.`);
    const bot: BotConfig = {
      id,
      name: input.name.trim() || "T3 Bot",
      platform: input.platform,
      ...(saved.account ? { account: saved.account } : {}),
      enabled: input.enabled ?? true,
      threadId: input.threadId,
      allowedUserIds: input.allowedUserIds ?? [],
      instructions: input.instructions?.trim() || DEFAULT_INSTRUCTIONS,
      reminder: input.reminder ?? true,
      ...(input.platform === "slack" ? { manifestVersion: MANIFEST_VERSION } : {}),
      ...(input.conversationMode === undefined ? {} : { conversationMode: modeOf(input.conversationMode) }),
      ...(input.settleAfterDays === undefined ? {} : { settleAfterDays: daysOf(input.settleAfterDays) }),
      ...(input.announceChannels === undefined ? {} : { announceChannels: channelsOf(input.announceChannels) }),
      ...categoriesPatch(input.reactionCategories),
      createdAt: new Date().toISOString(),
    };
    await this.config.update((config) => ({ ...config, bots: [...config.bots, bot] }));
    if (input.sendInstructions && bot.threadId !== null)
      await this.sendInstructions(bot.threadId, bot.instructions);
    await this.startBot(bot);
    return publicBot(bot);
  }

  async updateBot(id: string, patch: Partial<BotInput>) {
    const current = this.config.get().bots.find((bot) => bot.id === id);
    if (current === undefined) throw new NotFoundError("No such bot");
    const saved = await this.saveCredentials(id, current.platform, patch);
    let next: BotConfig = {
      ...current,
      ...(saved?.account ? { account: saved.account } : {}),
      ...(patch.name === undefined ? {} : { name: patch.name.trim() || current.name }),
      ...(patch.threadId === undefined ? {} : { threadId: patch.threadId }),
      ...(patch.allowedUserIds === undefined
        ? {}
        : { allowedUserIds: patch.allowedUserIds.map((value) => value.trim()).filter(Boolean) }),
      ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
      ...(patch.reminder === undefined ? {} : { reminder: patch.reminder }),
      ...(patch.manifestVersion === undefined ? {} : { manifestVersion: patch.manifestVersion }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.conversationMode === undefined ? {} : { conversationMode: modeOf(patch.conversationMode) }),
      ...(patch.settleAfterDays === undefined ? {} : { settleAfterDays: daysOf(patch.settleAfterDays) }),
      ...(patch.announceChannels === undefined ? {} : { announceChannels: channelsOf(patch.announceChannels) }),
    };
    if (patch.reactionCategories !== undefined) {
      const { reactionCategories: _, ...rest } = next;
      next = { ...rest, ...categoriesPatch(patch.reactionCategories) };
    }
    await this.replaceBot(next);
    if (patch.sendInstructions && next.threadId !== null)
      await this.sendInstructions(next.threadId, next.instructions);
    return publicBot(next);
  }

  /** A new orchestrator thread in the same project, with the same model and instructions. */
  async createFreshThread(botId: string): Promise<{ threadId: string; title: string }> {
    return this.createLikeBotThread(botId, orchestratorTitle(this.botConfig(botId)), true);
  }

  async createConversationThread(botId: string, title: string, first?: FirstMessage) {
    return this.createLikeBotThread(botId, title, false, first);
  }

  private async createLikeBotThread(
    botId: string,
    title: string,
    pin: boolean,
    first?: FirstMessage,
  ): Promise<{ threadId: string; title: string }> {
    const bot = this.botConfig(botId);
    const { template, lost } = await this.resolveBotThread(bot);
    if (template === null) {
      this.log.error(
        `T3_BOT_THREAD_LOST bot=${bot.id} thread=${bot.threadId} reason=no project on record to replace it`,
      );
      throw new Error("The bot's orchestrator thread is gone and no project is on record to replace it.");
    }
    if (lost && !pin) await this.replaceBotThread(bot, template);
    const { threadId } = await this.createOrchestratorThread({
      projectId: template.projectId,
      title,
      instructions: bot.instructions,
      ...(template.modelSelection === undefined ? {} : { modelSelection: template.modelSelection }),
      pin,
      ...(first === undefined ? {} : { firstMessage: first }),
    });
    return { threadId, title };
  }

  private botConfig(botId: string): BotConfig {
    const bot = this.config.get().bots.find((candidate) => candidate.id === botId);
    if (bot === undefined) throw new NotFoundError("No such bot");
    return bot;
  }

  private async resolveBotThread(
    bot: BotConfig,
  ): Promise<{ readonly template: BotThreadTemplate | null; readonly lost: boolean }> {
    const shell = await this.t3.getShell();
    const live = shell.threads.find(
      (thread) => thread.id === bot.threadId && thread.archivedAt === null && thread.deletedAt === null,
    );
    if (live !== undefined)
      return { template: await this.rememberBotThread(bot.id, live.id, live), lost: false };
    const archived = bot.threadId === null ? undefined : await this.archivedThread(bot.threadId);
    if (archived !== undefined) {
      await this.restoreBotThread(bot, archived.id);
      return { template: await this.rememberBotThread(bot.id, archived.id, archived), lost: false };
    }
    return { template: await this.replacementTemplate(bot, shell), lost: true };
  }

  private async archivedThread(threadId: string) {
    const archived = await this.t3.getArchivedShell().catch((error: unknown) => {
      this.log.warn(`Looking up archived thread ${threadId} failed`, error);
      return null;
    });
    return archived?.threads.find((thread) => thread.id === threadId && thread.deletedAt === null);
  }

  private async restoreBotThread(bot: BotConfig, threadId: string) {
    const command = (type: "thread.unarchive" | "thread.pin") =>
      this.t3.dispatch({
        type,
        commandId: CommandId.make(Crypto.randomUUID()),
        threadId: ThreadId.make(threadId),
      });
    try {
      await command("thread.unarchive");
      await command("thread.pin").catch((error: unknown) =>
        this.log.warn(`[${bot.name}] Re-pinning ${threadId} failed`, error),
      );
      this.log.warn(`T3_BOT_THREAD_RECOVERED bot=${bot.id} action=unarchived thread=${threadId}`);
    } catch (error) {
      this.log.error(`[${bot.name}] Unarchiving its orchestrator thread ${threadId} failed`, error);
    }
  }

  private async replacementTemplate(
    bot: BotConfig,
    shell: OrchestrationV2ShellSnapshot,
  ): Promise<BotThreadTemplate | null> {
    const known = (projectId: string | undefined) =>
      shell.projects.some((project) => project.id === projectId);
    if (known(bot.projectId))
      return {
        projectId: bot.projectId!,
        ...(bot.modelSelection === undefined ? {} : { modelSelection: bot.modelSelection }),
      };
    const remembered =
      bot.threadId === null
        ? null
        : await this.t3
            .getThreadProjection(ThreadId.make(bot.threadId))
            .then((projection) => projection.thread)
            .catch(() => null);
    if (remembered !== null && known(remembered.projectId))
      return { projectId: remembered.projectId, modelSelection: remembered.modelSelection };
    const only = shell.projects.length === 1 ? shell.projects[0]! : null;
    if (only !== null)
      return {
        projectId: only.id,
        ...(only.defaultModelSelection === null ? {} : { modelSelection: only.defaultModelSelection }),
      };
    return null;
  }

  private async replaceBotThread(bot: BotConfig, template: BotThreadTemplate) {
    const { threadId } = await this.createOrchestratorThread({
      projectId: template.projectId,
      title: orchestratorTitle(bot),
      instructions: bot.instructions,
      ...(template.modelSelection === undefined ? {} : { modelSelection: template.modelSelection }),
      pin: true,
    });
    await this.rememberBotThread(bot.id, threadId, template);
    this.log.warn(
      `T3_BOT_THREAD_RECOVERED bot=${bot.id} action=replaced old=${bot.threadId} thread=${threadId}`,
    );
  }

  private async rememberBotThread(
    botId: string,
    threadId: string,
    template: BotThreadTemplate,
  ): Promise<BotThreadTemplate> {
    const current = this.config.get().bots.find((bot) => bot.id === botId);
    const sameModel =
      template.modelSelection === undefined ||
      (current?.modelSelection !== undefined &&
        modelKey(current.modelSelection) === modelKey(template.modelSelection));
    const unchanged =
      current?.threadId === threadId && current.projectId === template.projectId && sameModel;
    if (current !== undefined && !unchanged)
      await this.config.update((config) => ({
        ...config,
        bots: config.bots.map((bot) =>
          bot.id === botId
            ? {
                ...bot,
                threadId,
                projectId: template.projectId,
                ...(template.modelSelection === undefined
                  ? {}
                  : { modelSelection: template.modelSelection }),
              }
            : bot,
        ),
      }));
    return template;
  }

  private async settleThread(threadId: string) {
    await this.t3.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(Crypto.randomUUID()),
      threadId: ThreadId.make(threadId),
    });
  }

  /** Moves a bot to another thread; the one it leaves is unpinned so the pinned list stays current. */
  async switchThread(botId: string, threadId: string) {
    const previous = this.config.get().bots.find((bot) => bot.id === botId)?.threadId ?? null;
    await this.updateBot(botId, { threadId });
    if (previous !== null && previous !== threadId) {
      await this.t3
        .dispatch({
          type: "thread.unpin",
          commandId: CommandId.make(Crypto.randomUUID()),
          threadId: ThreadId.make(previous),
        })
        .catch((error: unknown) =>
          this.log.warn("Unpinning the old orchestrator thread failed", error),
        );
    }
  }

  async startFreshThread(botId: string) {
    const fresh = await this.createFreshThread(botId);
    await this.switchThread(botId, fresh.threadId);
    return fresh;
  }

  async announce(botId: string, input: Partial<AnnounceRequest>): Promise<AnnounceResult> {
    const bot = this.config.get().bots.find((candidate) => candidate.id === botId);
    if (bot === undefined) throw new NotFoundError("No such bot");
    const channel = text(input.channel);
    const threadId = text(input.threadId);
    const message = typeof input.text === "string" ? input.text.trim() : "";
    if (channel === "" || threadId === "") throw new RefusedError("Announce needs a channel and a T3 thread id.");
    if (message === "") throw new RefusedError("Announce needs some text to post.");
    if (bot.platform !== "slack") throw new RefusedError(`${bot.name} is a ${PLATFORM_LABELS[bot.platform]} bot; announcing works for Slack bots only.`);
    if (bot.conversationMode !== "per-thread")
      throw new RefusedError(
        `${bot.name} is in single mode, where every Slack thread shares the bot's one T3 thread, so a Slack thread cannot be bound to another T3 thread. Turn on "One T3 thread per conversation" for it in T3 Bridge.`,
      );
    const shell = await this.t3.getShell();
    const thread = shell.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null)
      throw new RefusedError(`T3 has no open thread ${threadId}.`);
    const runtime = this.bots.get(botId);
    if (!(runtime instanceof ConversationRouter)) throw new RefusedError(`${bot.name} is not running.`);
    const slackThreadTs = text(input.slackThreadTs);
    const title = text(input.title);
    return runtime.announce({
      channel,
      threadId,
      text: message,
      ...(title === "" ? {} : { title }),
      ...(slackThreadTs === "" ? {} : { slackThreadTs }),
      dryRun: input.dryRun === true,
    });
  }

  async stopAgent(botId: string) {
    const runtime = this.bots.get(botId);
    if (runtime === undefined) throw new NotFoundError("No such bot");
    await runtime.stopThread();
    this.log.info(`[${runtime.bot.name}] Stopped from the control panel`);
  }

  /** Replaces the control panel token; every link copied before stops working. */
  async rotateControlToken(): Promise<string> {
    const token = Crypto.randomBytes(24).toString("base64url");
    await this.config.update((config) => ({ ...config, controlToken: token }));
    this.log.info("Control panel link replaced; old links no longer work");
    return token;
  }

  async removeBot(id: string) {
    await this.bots.get(id)?.stop();
    this.bots.delete(id);
    await this.config.update((config) => ({
      ...config,
      bots: config.bots.filter((bot) => bot.id !== id),
    }));
    await this.options.secrets.delete(botSecret(id, "botToken"));
    await this.options.secrets.delete(botSecret(id, "appToken"));
  }

  /**
   * Checks and stores a bot's token(s) when the input carries them for its platform, with the
   * account they belong to (Slack keeps none). Null when the input has no tokens.
   */
  private async saveCredentials(
    id: string,
    platform: Platform,
    input: Partial<BotInput>,
  ): Promise<{ readonly account?: NonNullable<BotConfig["account"]> } | null> {
    const secrets = this.options.secrets;
    if (platform === "slack" && input.slack) {
      await testSlackTokens(input.slack);
      await secrets.set(botSecret(id, "botToken"), input.slack.botToken.trim());
      await secrets.set(botSecret(id, "appToken"), input.slack.appToken.trim());
      return {};
    }
    if (platform === "discord" && input.discord) {
      const checked = await testDiscordToken(input.discord);
      await secrets.set(botSecret(id, "botToken"), input.discord.botToken.trim());
      return { account: { username: checked.botUser, applicationId: checked.applicationId } };
    }
    if (platform === "telegram" && input.telegram) {
      const checked = await testTelegramToken(input.telegram);
      await secrets.set(botSecret(id, "botToken"), input.telegram.botToken.trim());
      return { account: { username: checked.botUser } };
    }
    return null;
  }

  private async replaceBot(next: BotConfig) {
    await this.config.update((config) => ({
      ...config,
      bots: config.bots.map((bot) => (bot.id === next.id ? next : bot)),
    }));
    await this.bots
      .get(next.id)
      ?.stop()
      .catch(() => {});
    this.bots.delete(next.id);
    await this.startBot(next);
  }

  private async startBot(bot: BotConfig) {
    if (!bot.enabled) return;
    const adapter = await this.makeAdapter(bot);
    if (adapter === null) return;
    const shared = {
      bot,
      adapter,
      t3: this.t3,
      dataDir: this.options.dataDir,
      log: this.log,
      platformLabel: PLATFORM_LABELS[bot.platform],
      claimOwner: async (userId: string) => {
        const latest = this.config.get().bots.find((candidate) => candidate.id === bot.id);
        if (latest === undefined || latest.allowedUserIds.length > 0) return;
        this.log.info(`[${bot.name}] claimed by ${userId}`);
        await this.config.update((config) => ({
          ...config,
          bots: config.bots.map((candidate) =>
            candidate.id === bot.id ? { ...candidate, allowedUserIds: [userId] } : candidate,
          ),
        }));
        // The runtime reads allowed users from its own copy; keep it in step without a restart.
        (runtime.bot as { allowedUserIds: ReadonlyArray<string> }).allowedUserIds = [userId];
      },
      isBridgeMessage: (messageId: string) => this.bridgeMessages.has(messageId),
      threaded: isAgentLayout(bot),
      memoryDir: () =>
        this.memoryDirForThread(
          this.config.get().bots.find((candidate) => candidate.id === bot.id)?.threadId ?? null,
        ),
    };
    const settleAfterDays = bot.settleAfterDays ?? DEFAULT_SETTLE_AFTER_DAYS;
    const runtime: BotRuntime | ConversationRouter =
      bot.conversationMode === "per-thread"
        ? new ConversationRouter({
            ...shared,
            openThread: (title, first) => this.createConversationThread(bot.id, title, first),
            settleThread: (threadId) => this.settleThread(threadId),
            settleAfterMs: settleAfterDays > 0 ? settleAfterDays * 24 * 60 * 60_000 : null,
          })
        : new BotRuntime({
            ...shared,
            createFreshThread: () => this.createFreshThread(bot.id),
            switchThread: (threadId) => this.switchThread(bot.id, threadId),
          });
    this.bots.set(bot.id, runtime);
    try {
      await runtime.start();
    } catch (error) {
      this.log.error(`[${bot.name}] could not start`, error);
      runtime.lastError = error instanceof Error ? error.message : String(error);
    }
    if (bot.threadId !== null)
      void this.resolveBotThread(bot).catch((error: unknown) =>
        this.log.warn(`[${bot.name}] Checking its orchestrator thread failed`, error),
      );
  }

  private async makeAdapter(bot: BotConfig): Promise<ChatAdapter | null> {
    if (this.options.makeAdapter) return this.options.makeAdapter(bot);
    const botToken = await this.options.secrets.get(botSecret(bot.id, "botToken"));
    if (bot.platform !== "slack") {
      if (!botToken) {
        this.log.warn(`[${bot.name}] has no ${PLATFORM_LABELS[bot.platform]} token; add it in T3 Bridge.`);
        return null;
      }
      const buttons = new ButtonStore(
        Path.join(this.options.dataDir, "state", `${bot.id}.buttons.json`),
      );
      return bot.platform === "discord"
        ? new DiscordAdapter(botToken, this.log, bot.name, buttons)
        : new TelegramAdapter(botToken, this.log, bot.name, buttons);
    }
    const appToken = await this.options.secrets.get(botSecret(bot.id, "appToken"));
    if (!botToken || !appToken) {
      this.log.warn(`[${bot.name}] has no Slack tokens; add them in T3 Bridge.`);
      return null;
    }
    return new SlackAdapter({ botToken, appToken }, this.log, bot.name, isAgentLayout(bot));
  }
}

export class NotFoundError extends Error {}

interface BotThreadTemplate {
  readonly projectId: string;
  readonly modelSelection?: ModelSelection;
}

function orchestratorTitle(bot: BotConfig) {
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${bot.name} orchestrator · ${day}`;
}

/** What the bot list shows: the request in progress, and how today went. */
function summarize(activity: ReadonlyArray<ActivityEntry>) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = activity.filter((entry) => Date.parse(entry.at) >= midnight.getTime());
  return {
    working: activity.findLast(isWorking) ?? null,
    today: today.length,
    problemsToday: today.filter((entry) => entry.error !== null || entry.status === "failed").length,
    lastAt: activity.at(-1)?.updatedAt ?? null,
  };
}

/** Bots set up with the agent manifest talk in Slack's AI-app layout, one thread per request. */
function isAgentLayout(bot: BotConfig) {
  return bot.platform === "slack" && (bot.manifestVersion ?? 1) >= AGENT_LAYOUT_MANIFEST_VERSION;
}

/** Where people find the bot: Discord's invite to a server, Telegram's t.me link. */
function chatLink(bot: BotConfig): string | null {
  if (bot.platform === "discord" && bot.account?.applicationId)
    return discordInviteUrl(bot.account.applicationId);
  if (bot.platform === "telegram" && bot.account?.username)
    return `https://t.me/${bot.account.username}`;
  return null;
}

function modeOf(mode: string): ConversationMode {
  return mode === "per-thread" ? "per-thread" : "single";
}

function channelsOf(channels: ReadonlyArray<string>): string[] {
  return [...new Set(channels.map((channel) => channel.trim()).filter(Boolean))];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function daysOf(days: number): number {
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function publicBot(bot: BotConfig) {
  return { ...bot, reactionCategories: categoriesFor(bot) };
}

function categoriesPatch(input: unknown): Pick<BotConfig, "reactionCategories"> {
  const categories = reactionCategoriesOf(input);
  return Object.keys(categories).length === 0 ? {} : { reactionCategories: categories };
}

function modelKey(selection: ModelSelection) {
  return `${selection.instanceId}/${selection.model}`;
}

function describeT3Status(status: T3ConnectionStatus, label: string) {
  if (status.state === "connected") return { state: "connected" as const, label };
  if (status.state === "connecting") return { state: "connecting" as const, label };
  return { state: "disconnected" as const, label, error: status.error };
}

/** The bot's instructions with where its project memory is and how to use it. */
function withMemory(instructions: string, dir: string): string {
  return `${instructions}\n\n${memoryInstructions(dir)}`;
}
