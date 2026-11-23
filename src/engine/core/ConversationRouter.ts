import * as Path from "node:path";

import { readJson, writeJsonAtomic } from "../store.ts";
import { MAX_ACTIVITY, type ActivityEntry } from "./activity.ts";
import { BotRuntime, errorText, STOP_COMMAND, type BotRuntimeOptions } from "./BotRuntime.ts";
import type {
  AdapterStatus,
  ChatAdapter,
  ConversationRef,
  InboundAction,
  InboundMessage,
  MessageRef,
} from "./types.ts";

export interface ConversationRecord {
  readonly threadId: string;
  readonly conversation: ConversationRef;
  readonly title: string;
  readonly createdAt: string;
  readonly activeAt: string;
  readonly settledAt?: string;
}

interface RouterState {
  conversations: Record<string, ConversationRecord>;
  messages: Record<string, string>;
}

export type ConversationRouterOptions = Omit<
  BotRuntimeOptions,
  "createFreshThread" | "switchThread" | "session"
> & {
  readonly openThread: (title: string) => Promise<{ threadId: string; title: string }>;
  readonly settleThread: (threadId: string) => Promise<void>;
  readonly settleAfterMs: number | null;
};

interface Session {
  readonly runtime: BotRuntime;
  readonly ready: Promise<void>;
}

const MAX_MESSAGES = 5000;
const SETTLE_CHECK_MS = 60 * 60_000;

export class ConversationRouter {
  private state: RouterState = { conversations: {}, messages: {} };
  private readonly sessions = new Map<string, Session>();
  private saveTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ownError: string | null = null;
  adapterStatus: AdapterStatus = { state: "connecting" };

  private readonly options: ConversationRouterOptions;

  constructor(options: ConversationRouterOptions) {
    this.options = options;
  }

  get bot() {
    return this.options.bot;
  }

  get lastError(): string | null {
    return (
      this.ownError ??
      [...this.sessions.values()].map((session) => session.runtime.lastError).find(Boolean) ??
      null
    );
  }

  set lastError(error: string | null) {
    this.ownError = error;
  }

  get conversationCount() {
    return Object.values(this.state.conversations).filter((record) => record.settledAt === undefined)
      .length;
  }

  get conversations(): Readonly<Record<string, ConversationRecord>> {
    return this.state.conversations;
  }

  get activity(): ReadonlyArray<ActivityEntry> {
    return [...this.sessions.values()]
      .flatMap((session) => session.runtime.activity)
      .sort((left, right) => left.at.localeCompare(right.at))
      .slice(-MAX_ACTIVITY);
  }

  private get file() {
    return Path.join(this.options.dataDir, "state", `${this.bot.id}.conversations.json`);
  }

  async start(): Promise<void> {
    this.state = (await readJson<RouterState>(this.file)) ?? this.state;
    for (const [key, record] of Object.entries(this.state.conversations))
      if (record.settledAt === undefined) this.open(key, record.conversation);
    await Promise.all([...this.sessions.values()].map((session) => session.ready));
    if (this.options.settleAfterMs !== null) {
      this.settleTimer = setInterval(() => void this.settleIdle(), SETTLE_CHECK_MS);
      this.settleTimer.unref();
    }
    void this.startAdapter();
  }

  private async startAdapter() {
    for (let attempt = 0; !this.stopped; attempt += 1) {
      try {
        await this.options.adapter.start({
          onMessage: (message) => this.handleMessage(message),
          onAction: (action) => this.handleAction(action),
          onStatus: (status) => {
            this.adapterStatus = status;
          },
        });
        return;
      } catch (error) {
        this.ownError = `${this.options.platformLabel}: ${errorText(error)}`;
        this.options.log.warn(
          `[${this.bot.name}] could not connect to ${this.options.platformLabel}`,
          error,
        );
        await this.options.adapter.stop().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2000 * 2 ** attempt)));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.settleTimer !== null) clearInterval(this.settleTimer);
    for (const session of this.sessions.values()) await session.runtime.stop().catch(() => {});
    this.sessions.clear();
    await this.saveNow();
    await this.options.adapter.stop();
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const key = this.keyOf(message);
    const record = this.state.conversations[key];
    if (
      record === undefined &&
      !this.sessions.has(key) &&
      !message.isDirect &&
      !message.mentionsBot
    )
      return;
    if (
      record === undefined &&
      STOP_COMMAND.test(message.text.trim()) &&
      this.bot.allowedUserIds.includes(message.userId)
    ) {
      await this.stopThread();
      await this.options.adapter.reply(message, "⏹ Stopping every conversation.");
      return;
    }
    if (record?.settledAt !== undefined) {
      const { settledAt: _, ...active } = record;
      this.state.conversations[key] = active;
    }
    const session = this.open(key, record?.conversation ?? this.conversationOf(message));
    this.remember(message.ref, key);
    this.touch(key);
    await session.ready;
    await session.runtime.handleMessage(message);
  }

  async handleAction(action: InboundAction): Promise<void> {
    const sessions = [...this.sessions.values()];
    if (action.type === "stop") {
      const key = action.message === undefined ? undefined : this.lookup(action.message);
      const session = key === undefined ? undefined : this.sessions.get(key);
      for (const target of session === undefined ? sessions : [session])
        await target.runtime.handleAction(action);
      return;
    }
    const owner = sessions.find((session) => session.runtime.watches(action.threadId)) ?? sessions[0];
    await owner?.runtime.handleAction(action);
  }

  async stopThread() {
    for (const session of this.sessions.values()) await session.runtime.stopThread();
  }

  async settleIdle(now = Date.now()) {
    const limit = this.options.settleAfterMs;
    if (limit === null) return;
    for (const [key, record] of Object.entries(this.state.conversations)) {
      if (record.settledAt !== undefined || now - Date.parse(record.activeAt) < limit) continue;
      const session = this.sessions.get(key);
      this.sessions.delete(key);
      await session?.runtime.stop().catch(() => {});
      await this.options
        .settleThread(record.threadId)
        .catch((error: unknown) =>
          this.options.log.warn(`[${this.bot.name}] settling "${record.title}" failed`, error),
        );
      this.state.conversations[key] = { ...record, settledAt: new Date(now).toISOString() };
      this.options.log.info(`[${this.bot.name}] Settled idle conversation "${record.title}"`);
    }
    await this.saveNow();
  }

  private keyOf(message: InboundMessage): string {
    const known = message.replyTo === null ? undefined : this.lookup(message.replyTo);
    if (known !== undefined) return known;
    const thread = message.conversation.meta?.topic ?? message.conversation.meta?.thread;
    if (thread !== undefined) return `${message.conversation.id}:${thread}`;
    return `${message.conversation.id}:${message.replyTo?.ts ?? message.ref.ts}`;
  }

  private conversationOf(message: InboundMessage): ConversationRef {
    return this.bot.platform === "slack"
      ? { ...message.conversation, threadTs: message.replyTo?.ts ?? message.ref.ts! }
      : message.conversation;
  }

  private open(key: string, conversation: ConversationRef): Session {
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const runtime = new BotRuntime({
      ...this.options,
      adapter: this.sharedAdapter(key),
      createFreshThread: () =>
        this.options.openThread(this.state.conversations[key]?.title ?? "Conversation"),
      switchThread: (threadId) => this.switchThread(key, conversation, threadId),
      session: {
        key,
        threadId: this.state.conversations[key]?.threadId ?? null,
        conversation,
        openThread: (title) => this.openThread(key, conversation, title),
      },
    });
    const session = { runtime, ready: runtime.start() };
    this.sessions.set(key, session);
    return session;
  }

  private async openThread(key: string, conversation: ConversationRef, title: string) {
    const { threadId } = await this.options.openThread(title);
    const now = new Date().toISOString();
    this.state.conversations[key] = { threadId, conversation, title, createdAt: now, activeAt: now };
    await this.saveNow();
    this.options.log.info(`[${this.bot.name}] Conversation "${title}" started in T3 thread ${threadId}`);
    return threadId;
  }

  private async switchThread(key: string, conversation: ConversationRef, threadId: string) {
    const now = new Date().toISOString();
    const record = this.state.conversations[key];
    this.state.conversations[key] = {
      threadId,
      conversation,
      title: record?.title ?? "Conversation",
      createdAt: record?.createdAt ?? now,
      activeAt: now,
    };
    await this.saveNow();
    const previous = this.sessions.get(key);
    this.sessions.delete(key);
    await previous?.runtime.stop().catch(() => {});
    if (!this.stopped) await this.open(key, conversation).ready;
  }

  private sharedAdapter(key: string): ChatAdapter {
    const adapter = this.options.adapter;
    return {
      ...(adapter.mentionHint === undefined ? {} : { mentionHint: adapter.mentionHint }),
      start: async () => {},
      stop: async () => {},
      upsert: async (conversation, post, existing) => {
        const ref = await adapter.upsert(conversation, post, existing);
        if (existing === null) {
          this.remember(ref, key);
          this.touch(key);
        }
        return ref;
      },
      setRunStatus: (message, status, previous, sessionThreadTs) =>
        adapter.setRunStatus(message, status, previous, sessionThreadTs),
      reply: (message, text) => adapter.reply(message, text),
      ...(adapter.setThreadTitle === undefined
        ? {}
        : {
            setThreadTitle: (conversation: ConversationRef, title: string) =>
              adapter.setThreadTitle!(conversation, title),
          }),
    };
  }

  private lookup(ref: MessageRef): string | undefined {
    const id = refKey(ref);
    return id === null ? undefined : this.state.messages[id];
  }

  private remember(ref: MessageRef, key: string) {
    const id = refKey(ref);
    if (id === null) return;
    delete this.state.messages[id];
    this.state.messages[id] = key;
    const ids = Object.keys(this.state.messages);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_MESSAGES)))
      delete this.state.messages[old];
    this.scheduleSave();
  }

  private touch(key: string) {
    const record = this.state.conversations[key];
    if (record === undefined) return;
    this.state.conversations[key] = { ...record, activeAt: new Date().toISOString() };
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 1000);
  }

  private async saveNow() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await writeJsonAtomic(this.file, this.state).catch((error: unknown) =>
      this.options.log.error(`[${this.bot.name}] saving conversations failed`, error),
    );
  }
}

function refKey(ref: MessageRef): string | null {
  return ref.channel && ref.ts ? `${ref.channel}:${ref.ts}` : null;
}
