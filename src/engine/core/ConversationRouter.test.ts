import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeLogger } from "../log.ts";
import type { BotConfig } from "../store.ts";
import type { T3Client } from "../t3/T3Client.ts";
import { ConversationRouter } from "./ConversationRouter.ts";
import type { ChatAdapter, ConversationRef, InboundMessage, OutboundPost } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;

interface Command {
  readonly type: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly launched?: boolean;
}

function world() {
  const commands: Command[] = [];
  const feeds = new Map<string, (item: unknown) => Promise<void>>();
  const subscribed: string[] = [];
  const t3 = {
    subscribeThread: (input: { threadId: string; onItem: (item: unknown) => Promise<void> }) => {
      feeds.set(input.threadId, input.onItem);
      subscribed.push(input.threadId);
      return () => feeds.delete(input.threadId);
    },
    dispatch: async (command: Command) => {
      commands.push(command);
      return { sequence: 1 };
    },
    uploadAttachment: async () => ({ type: "file", attachmentId: "att" }),
  } as unknown as T3Client;
  const upserts: Array<{ conversation: ConversationRef; post: OutboundPost }> = [];
  const replies: string[] = [];
  let posted = 0;
  const adapter: ChatAdapter = {
    start: async () => {},
    stop: async () => {},
    upsert: async (conversation, post, existing) => {
      upserts.push({ conversation, post });
      posted += 1;
      return existing ?? { channel: conversation.id, ts: `900.${posted}` };
    },
    setRunStatus: async () => {},
    reply: async (_message, text) => {
      replies.push(text);
    },
  };
  return {
    t3,
    adapter,
    commands,
    upserts,
    replies,
    subscribed,
    feed: (threadId: string, item: unknown) => feeds.get(threadId)!(item),
    sent: (threadId: string) =>
      commands.filter((command) => command.type === "message.dispatch" && command.threadId === threadId),
    stops: () => commands.filter((command) => command.type === "thread.stop").map((command) => command.threadId),
  };
}

async function setup(
  options: { dataDir?: string; gate?: Promise<void>; platform?: BotConfig["platform"] } = {},
  shared: ReturnType<typeof world> = world(),
) {
  const dataDir = options.dataDir ?? (await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-router-")));
  if (options.dataDir === undefined) dirs.push(dataDir);
  const opened: string[] = [];
  const settled: string[] = [];
  let next = 0;
  const bot: BotConfig = {
    id: "bot-1",
    name: "Developer",
    platform: options.platform ?? "slack",
    enabled: true,
    threadId: "template",
    allowedUserIds: ["U1"],
    instructions: "",
    reminder: false,
    conversationMode: "per-thread",
    createdAt: new Date().toISOString(),
  };
  const router = new ConversationRouter({
    bot,
    adapter: shared.adapter,
    t3: shared.t3,
    dataDir,
    log: makeLogger(() => {}),
    platformLabel: "Slack",
    claimOwner: async () => {},
    isBridgeMessage: () => false,
    threaded: false,
    memoryDir: async () => Path.join(dataDir, "memory"),
    openThread: async (title, first) => {
      opened.push(title);
      next += 1;
      const threadId = `t-${next}`;
      if (next === 1 && options.gate !== undefined) await options.gate;
      if (first !== undefined)
        shared.commands.push({
          type: "message.dispatch",
          threadId,
          messageId: first.messageId,
          text: first.text,
          launched: true,
        });
      return { threadId, title };
    },
    settleThread: async (threadId) => {
      settled.push(threadId);
    },
    settleAfterMs: 7 * DAY,
  });
  await router.start();
  return { router, dataDir, opened, settled, ...shared };
}

function dm(text: string, ts: string, threadTs?: string): InboundMessage {
  return {
    conversation: { id: "D1", label: "Direct message" },
    ref: { channel: "D1", ts },
    userId: "U1",
    userName: "Miro",
    isDirect: true,
    mentionsBot: false,
    text,
    files: [],
    replyTo: threadTs === undefined ? null : { channel: "D1", ts: threadTs },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
let sequence = 10;
const event = (type: string, payload: unknown) => ({ kind: "event", sequence: (sequence += 1), event: { type, payload } });
const run = (id: string, userMessageId: string, status: string) => event("run.updated", { id, userMessageId, status });
const reply = (id: string, runId: string, text: string) =>
  event("turn-item.updated", {
    type: "assistant_message",
    id,
    runId,
    nodeId: null,
    text,
    streaming: false,
    updatedAt: later(1000),
  });

describe("ConversationRouter", () => {
  it("starts a T3 thread for each new conversation and keeps replies in theirs", async () => {
    const { router, opened, sent } = await setup();
    await router.handleMessage(dm("Fix the login bug", "100.1"));
    await router.handleMessage(dm("Write the release notes", "200.1"));
    await router.handleMessage(dm("Also check Safari", "100.2", "100.1"));

    expect(opened).toEqual(["Fix the login bug", "Write the release notes"]);
    expect(sent("t-1").map((command) => command.text)).toEqual([
      expect.stringMatching(/Fix the login bug$/),
      expect.stringMatching(/Also check Safari$/),
    ]);
    expect(sent("t-2").map((command) => command.text)).toEqual([expect.stringMatching(/Write the release notes$/)]);
    expect(router.conversationCount).toBe(2);
    expect(router.conversations["D1:100.1"]).toMatchObject({
      threadId: "t-1",
      title: "Fix the login bug",
      conversation: { id: "D1", threadTs: "100.1" },
    });
    await router.stop();
  });

  it("puts the first message in the new thread's only turn and relays just its reply", async () => {
    const { router, commands, sent, upserts, feed } = await setup();
    await router.handleMessage(dm("Fix the login bug", "100.1"));

    expect(commands).toEqual([
      expect.objectContaining({ threadId: "t-1", launched: true, text: expect.stringMatching(/Fix the login bug$/) }),
    ]);
    await feed("t-1", { kind: "snapshot", snapshotSequence: 1, projection: { nodes: [], runtimeRequests: [], messages: [], runs: [], subagents: [], turnItems: [] } });
    await feed("t-1", run("run-1", sent("t-1")[0]!.messageId!, "completed"));
    await feed("t-1", reply("a-1", "run-1", "On it: the login fix"));
    await settle();

    expect(
      upserts.filter(({ post }) => post.kind === "assistant").map(({ post }) => (post as { markdown: string }).markdown),
    ).toEqual(["On it: the login fix"]);
    await router.stop();
  });

  it("does not open a thread for commands or strangers' channel chatter", async () => {
    const { router, opened, commands } = await setup();
    await router.handleMessage(dm("!stop", "100.1"));
    await router.handleMessage(dm("!remember Deploys go through CI", "100.2"));
    await router.handleMessage({ ...dm("lunch?", "300.1"), conversation: { id: "C1", label: "#general" }, isDirect: false });
    expect(opened).toEqual([]);
    expect(commands).toEqual([]);
    expect(router.conversationCount).toBe(0);
    await router.stop();
  });

  it("stops every conversation on a stop outside any of them", async () => {
    const { router, stops, replies } = await setup();
    await router.handleMessage(dm("Fix the login bug", "100.1"));
    await router.handleMessage(dm("Write the release notes", "200.1"));
    await router.handleMessage(dm("/stop", "300.1"));
    expect(stops().sort()).toEqual(["t-1", "t-2"]);
    expect(replies.at(-1)).toBe("⏹ Stopping every conversation.");
    await router.stop();
  });

  it("keeps the conversations across a restart", async () => {
    const first = await setup();
    await first.router.handleMessage(dm("Fix the login bug", "100.1"));
    await first.router.handleMessage(dm("Write the release notes", "200.1"));
    await first.router.stop();

    const again = world();
    const second = await setup({ dataDir: first.dataDir }, again);
    expect(again.subscribed.sort()).toEqual(["t-1", "t-2"]);
    await second.router.handleMessage(dm("Any news on the login?", "100.5", "100.1"));
    expect(second.opened).toEqual([]);
    expect(again.sent("t-1").map((command) => command.text)).toEqual([expect.stringMatching(/Any news on the login\?$/)]);

    await again.feed("t-1", run("run-1", again.sent("t-1")[0]!.messageId!, "completed"));
    await again.feed("t-1", reply("a-1", "run-1", "Fixed in PR #12"));
    await settle();
    expect(again.upserts.map(({ conversation, post }) => [conversation.threadTs, post.kind])).toEqual([
      ["100.1", "assistant"],
    ]);
    await second.router.stop();
  });

  it("runs conversations side by side while one is still opening its thread", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { router, opened, sent } = await setup({ gate });
    const slow = router.handleMessage(dm("Fix the login bug", "100.1"));
    await settle();
    await router.handleMessage(dm("Write the release notes", "200.1"));
    expect(sent("t-2")).toHaveLength(1);
    expect(sent("t-1")).toHaveLength(0);

    const followUp = router.handleMessage(dm("Also check Safari", "100.2", "100.1"));
    release();
    await Promise.all([slow, followUp]);
    expect(opened).toEqual(["Fix the login bug", "Write the release notes"]);
    expect(sent("t-1")).toHaveLength(2);
    await router.stop();
  });

  it("scopes !stop, stop reactions and !new to one conversation", async () => {
    const { router, opened, sent, stops, replies, commands } = await setup();
    await router.handleMessage(dm("Fix the login bug", "100.1"));
    await router.handleMessage(dm("Write the release notes", "200.1"));

    await router.handleMessage(dm("!stop", "100.2", "100.1"));
    expect(stops()).toEqual(["t-1"]);
    await router.handleAction({ type: "stop", userId: "U1", message: { channel: "D1", ts: "200.1" } });
    expect(stops()).toEqual(["t-1", "t-2"]);

    await router.handleMessage(dm("!new", "100.3", "100.1"));
    await settle();
    expect(opened).toEqual(["Fix the login bug", "Write the release notes", "Fix the login bug"]);
    expect(replies.at(-1)).toContain("is ready");
    expect(router.conversations["D1:100.1"]!.threadId).toBe("t-3");
    expect(router.conversations["D1:200.1"]!.threadId).toBe("t-2");

    await router.handleMessage(dm("Start over please", "100.4", "100.1"));
    await router.handleMessage(dm("Add the changelog", "200.2", "200.1"));
    expect(sent("t-3").map((command) => command.text)).toEqual([expect.stringMatching(/Start over please$/)]);
    expect(sent("t-2")).toHaveLength(2);
    expect(sent("t-1")).toHaveLength(1);

    await router.handleAction({ type: "approval", userId: "U1", threadId: "t-2", requestId: "r-1", decision: "accept" });
    expect(commands.at(-1)).toMatchObject({ type: "runtime-request.respond", threadId: "t-2" });
    await router.stop();
  });

  it("posts each thread's replies and reports in its own conversation", async () => {
    const { router, sent, upserts, feed } = await setup();
    await router.handleMessage(dm("Fix the login bug", "100.1"));
    await router.handleMessage(dm("Write the release notes", "200.1"));

    await feed("t-1", run("run-a", sent("t-1")[0]!.messageId!, "completed"));
    await feed("t-1", reply("a-a", "run-a", "Login fixed"));
    await feed("t-2", run("run-b", sent("t-2")[0]!.messageId!, "completed"));
    await feed("t-2", event("message.updated", { id: "m-report", senderThreadId: "worker-9" }));
    await feed("t-2", run("run-report", "m-report", "completed"));
    await feed("t-2", reply("a-report", "run-report", "Worker finished the notes"));
    await feed("t-1", event("message.updated", { id: "m-wake", delegatedCompletion: { parentRunId: "run-a", generation: 1, taskIds: [] } }));
    await feed("t-1", run("run-wake", "m-wake", "completed"));
    await feed("t-1", reply("a-wake", "run-wake", "NO_REPLY"));
    await settle();

    const shown = upserts
      .filter(({ post }) => post.kind === "assistant")
      .map(({ conversation, post }) => [conversation.threadTs, (post as { markdown: string }).markdown])
      .sort();
    expect(shown).toEqual([
      ["100.1", "Login fixed"],
      ["200.1", "Worker finished the notes"],
    ]);
    await router.stop();
  });

  it("follows reply chains and forum topics on Discord and Telegram", async () => {
    const { router, opened, sent, upserts, feed } = await setup({ platform: "discord" });
    await router.handleMessage(dm("Fix the login bug", "100.1"));
    await feed("t-1", run("run-a", sent("t-1")[0]!.messageId!, "completed"));
    await feed("t-1", reply("a-a", "run-a", "Which browser?"));
    await settle();
    expect(upserts[0]!.conversation.threadTs).toBeUndefined();

    await router.handleMessage(dm("Safari", "100.2", "900.1"));
    await router.handleMessage(dm("Unrelated question", "100.3"));
    const topic = (text: string, ts: string): InboundMessage => ({
      ...dm(text, ts),
      conversation: { id: "G1", label: "Group", meta: { topic: "7" } },
      ref: { channel: "G1", ts, topic: "7" },
      isDirect: false,
      mentionsBot: true,
    });
    await router.handleMessage(topic("Deploy status?", "50"));
    await router.handleMessage(topic("And staging?", "51"));

    expect(opened).toEqual(["Fix the login bug", "Unrelated question", "Deploy status?"]);
    expect(sent("t-1")).toHaveLength(2);
    expect(sent("t-3")).toHaveLength(2);
    await router.stop();
  });

  it("settles idle conversations and wakes them on the next message", async () => {
    const { router, opened, settled, sent } = await setup();
    await router.handleMessage(dm("Fix the login bug", "100.1"));
    await router.settleIdle(Date.now() + 8 * 24 * 60 * 60_000);
    expect(settled).toEqual(["t-1"]);
    expect(router.conversationCount).toBe(0);

    await router.handleMessage(dm("One more thing", "100.2", "100.1"));
    expect(opened).toEqual(["Fix the login bug"]);
    expect(sent("t-1")).toHaveLength(2);
    expect(router.conversationCount).toBe(1);
    await router.stop();
  });
});
