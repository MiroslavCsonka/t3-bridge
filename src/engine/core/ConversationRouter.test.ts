import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeLogger } from "../log.ts";
import type { BotConfig } from "../store.ts";
import type { T3Client } from "../t3/T3Client.ts";
import { ConversationRouter } from "./ConversationRouter.ts";
import {
  RefusedError,
  type ChatAdapter,
  type ConversationRef,
  type InboundMessage,
  type InboundReaction,
  type OutboundPost,
} from "./types.ts";

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
    announceTarget: async (channel, recipient) => {
      if (!memberOf.includes(channel)) throw new RefusedError(`Developer is not a member of channel ${channel}. Invite it there with /invite @Developer`);
      return { id: channel, label: `<#${channel}>`, meta: { user: recipient ?? "", team: "T1" } };
    },
    permalink: async (message) => `https://team.slack.com/archives/${message.channel}/p${message.ts!.replace(".", "")}`,
  };
  const memberOf = ["C9", "C10"];
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
  options: {
    dataDir?: string;
    gate?: Promise<void>;
    platform?: BotConfig["platform"];
    announceChannels?: ReadonlyArray<string>;
    reactionCategories?: BotConfig["reactionCategories"];
  } = {},
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
    announceChannels: options.announceChannels ?? ["C9"],
    ...(options.reactionCategories === undefined ? {} : { reactionCategories: options.reactionCategories }),
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

  describe("announce", () => {
    const snapshot = { kind: "snapshot", snapshotSequence: 1, projection: { nodes: [], runtimeRequests: [], messages: [], runs: [], subagents: [], turnItems: [] } };
    const requested = (id: string, userMessageId: string, status: string, requestedAt: string) =>
      event("run.updated", { id, userMessageId, status, requestedAt });
    const inChannel = (text: string, ts: string, threadTs: string): InboundMessage => ({
      conversation: { id: "C9", label: "#alerts", meta: { user: "U1" } },
      ref: { channel: "C9", ts },
      userId: "U1",
      userName: "Miro",
      isDirect: false,
      mentionsBot: false,
      text,
      files: [],
      replyTo: { channel: "C9", ts: threadTs },
    });
    const assistantPosts = (upserts: ReturnType<typeof world>["upserts"]) =>
      upserts
        .filter(({ post }) => post.kind === "assistant")
        .map(({ conversation, post }) => [conversation.id, conversation.threadTs, (post as { markdown: string }).markdown]);

    it("posts as the bot and binds the new Slack thread to the T3 thread", async () => {
      const { router, upserts, subscribed, opened } = await setup();
      const result = await router.announce({ channel: "C9", text: "Sentry: checkout errors doubled", threadId: "t-alert", title: "Checkout errors" });

      expect(result).toEqual({
        ok: true,
        dryRun: false,
        channel: "C9",
        ts: "900.1",
        threadTs: "900.1",
        threadId: "t-alert",
        permalink: "https://team.slack.com/archives/C9/p9001",
      });
      expect(upserts).toEqual([
        {
          conversation: { id: "C9", label: "<#C9>", meta: { user: "U1", team: "T1" } },
          post: { kind: "assistant", markdown: "Sentry: checkout errors doubled", streaming: false, images: [] },
        },
      ]);
      expect(router.conversations["C9:900.1"]).toMatchObject({
        threadId: "t-alert",
        title: "Checkout errors",
        conversation: { id: "C9", threadTs: "900.1" },
        announcedAt: expect.any(String),
      });
      expect(subscribed).toEqual(["t-alert"]);
      expect(opened).toEqual([]);
      await router.stop();
    });

    it("routes a reply in the announced Slack thread to the bound T3 thread", async () => {
      const { router, sent, opened } = await setup();
      await router.announce({ channel: "C9", text: "Sentry: checkout errors doubled", threadId: "t-alert" });
      await router.handleMessage(inChannel("Is it the new deploy?", "950.1", "900.1"));

      expect(opened).toEqual([]);
      expect(sent("t-alert").map((command) => command.text)).toEqual([expect.stringMatching(/Is it the new deploy\?$/)]);
      await router.stop();
    });

    it("posts the T3 thread's later output and reports into the announced Slack thread", async () => {
      const { router, upserts, feed } = await setup();
      const before = new Date(Date.now() - 60_000).toISOString();
      await router.announce({ channel: "C9", text: "Sentry: checkout errors doubled", threadId: "t-alert" });
      await feed("t-alert", snapshot);
      await feed("t-alert", requested("run-announcing", "m-webhook", "completed", before));
      await feed("t-alert", reply("a-announcing", "run-announcing", "Announced in Slack."));
      await feed("t-alert", event("message.updated", { id: "m-timer", scheduledTaskId: "task-1" }));
      await feed("t-alert", requested("run-timer", "m-timer", "completed", later(500)));
      await feed("t-alert", reply("a-timer", "run-timer", "Follow-up: errors back to normal"));
      await feed("t-alert", event("message.updated", { id: "m-report", senderThreadId: "worker-3" }));
      await feed("t-alert", requested("run-report", "m-report", "completed", later(600)));
      await feed("t-alert", reply("a-report", "run-report", "Worker found the bad migration"));
      await settle();

      expect(assistantPosts(upserts)).toEqual([
        ["C9", undefined, "Sentry: checkout errors doubled"],
        ["C9", "900.1", "Follow-up: errors back to normal"],
        ["C9", "900.1", "Worker found the bad migration"],
      ]);
      await router.stop();
    });

    it("refuses channels that are not allowed and channels the bot is not in", async () => {
      const { router, upserts, subscribed } = await setup({ announceChannels: ["C9", "C11"] });
      await expect(router.announce({ channel: "C10", text: "Hi", threadId: "t-alert" })).rejects.toThrow(
        /may not announce to channel C10\. Allowed: C9, C11/,
      );
      await expect(router.announce({ channel: "C11", text: "Hi", threadId: "t-alert" })).rejects.toThrow(
        /not a member of channel C11.*\/invite/,
      );
      expect(upserts).toEqual([]);
      expect(subscribed).toEqual([]);
      expect(router.conversationCount).toBe(0);
      await router.stop();
    });

    it("validates a dry run without posting or binding", async () => {
      const { router, upserts, subscribed } = await setup();
      const result = await router.announce({ channel: "C9", text: "Hi", threadId: "t-alert", dryRun: true });
      expect(result).toMatchObject({ ok: true, dryRun: true, channel: "C9", ts: null });
      expect(upserts).toEqual([]);
      expect(subscribed).toEqual([]);
      await router.stop();
    });

    it("posts into an existing Slack thread and binds that one", async () => {
      const { router, upserts, sent } = await setup();
      const result = await router.announce({ channel: "C9", text: "I looked into this alert", threadId: "t-alert", slackThreadTs: "555.1" });

      expect(result).toMatchObject({ ts: "900.1", threadTs: "555.1", permalink: "https://team.slack.com/archives/C9/p9001" });
      expect(upserts[0]!.conversation).toMatchObject({ id: "C9", threadTs: "555.1" });
      expect(router.conversations["C9:555.1"]).toMatchObject({ threadId: "t-alert", conversation: { threadTs: "555.1" } });
      await router.handleMessage(inChannel("Thanks, roll it back", "556.1", "555.1"));
      expect(sent("t-alert")).toHaveLength(1);

      await router.announce({ channel: "C9", text: "Rolled back", threadId: "t-alert", slackThreadTs: "555.1" });
      expect(upserts.at(-1)!.conversation).toMatchObject({ threadTs: "555.1" });
      await expect(router.announce({ channel: "C9", text: "Again", threadId: "t-alert" })).rejects.toThrow(
        /already bound to Slack thread 555\.1.*--slack-thread 555\.1/,
      );
      await expect(router.announce({ channel: "C9", text: "Other", threadId: "t-other", slackThreadTs: "555.1" })).rejects.toThrow(
        /already bound to T3 thread t-alert/,
      );
      await router.stop();
    });

    it("keeps the binding across a restart", async () => {
      const first = await setup();
      await first.router.announce({ channel: "C9", text: "Sentry: checkout errors doubled", threadId: "t-alert" });
      await first.router.stop();

      const again = world();
      const second = await setup({ dataDir: first.dataDir }, again);
      expect(again.subscribed).toEqual(["t-alert"]);
      await second.router.handleMessage(inChannel("Any update?", "960.1", "900.1"));
      expect(second.opened).toEqual([]);
      expect(again.sent("t-alert")).toHaveLength(1);

      await again.feed("t-alert", requested("run-old", "m-old", "completed", new Date(Date.now() - 60_000).toISOString()));
      await again.feed("t-alert", reply("a-old", "run-old", "Announced in Slack."));
      await again.feed("t-alert", requested("run-1", again.sent("t-alert")[0]!.messageId!, "completed", later(100)));
      await again.feed("t-alert", reply("a-1", "run-1", "Still quiet since the rollback"));
      await settle();
      expect(assistantPosts(again.upserts)).toEqual([["C9", "900.1", "Still quiet since the rollback"]]);
      await second.router.stop();
    });
  });

  describe("feedback reactions", () => {
    const thumb = (messageTs: string, threadTs: string | null, userId = "U1"): InboundReaction => ({
      at: "2026-11-23T10:00:00.000Z",
      channel: "C9",
      messageTs,
      reaction: "+1",
      userId,
      change: "added",
      details: async () => ({ threadTs, permalink: null, text: "Sentry: checkout errors doubled" }),
    });
    const recorded = async (dataDir: string) =>
      (await FS.readFile(Path.join(dataDir, "feedback.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    it("records the T3 thread bound to the reacted message's Slack thread", async () => {
      const { router, dataDir } = await setup();
      await router.announce({ channel: "C9", text: "Sentry: checkout errors doubled", threadId: "t-alert" });
      await router.handleReaction(thumb("900.1", null));
      await router.handleReaction(thumb("901.5", "900.1"));
      await router.handleReaction(thumb("777.1", null));
      await router.handleReaction(thumb("900.1", null, "U2"));

      expect((await recorded(dataDir)).map((entry) => [entry.messageTs, entry.threadId, entry.botName])).toEqual([
        ["900.1", "t-alert", "Developer"],
        ["901.5", "t-alert", "Developer"],
        ["777.1", null, "Developer"],
      ]);
      await router.stop();
    });

    const react = (
      emoji: string,
      channel: string,
      messageTs: string,
      threadTs: string | null,
      change: "added" | "removed" = "added",
    ): InboundReaction => ({
      at: "2026-11-23T10:00:00.000Z",
      channel,
      messageTs,
      reaction: emoji,
      userId: "U1",
      change,
      details: async () => ({ threadTs, permalink: null, text: `Alert in ${channel}: disk is 91% full`, userName: "Miro" }),
    });
    const announced = async (options: Parameters<typeof setup>[0] = {}) => {
      const harness = await setup({ announceChannels: ["C9", "C10"], ...options });
      await harness.router.announce({ channel: "C9", text: "Alert in C9: disk is 91% full", threadId: "t-disk" });
      await harness.router.announce({ channel: "C10", text: "Alert in C10: disk is 91% full", threadId: "t-db" });
      return harness;
    };
    const notes = (harness: Awaited<ReturnType<typeof announced>>, threadId: string) =>
      harness.sent(threadId).map((command) => command.text!.slice(command.text!.indexOf("\n") + 1));

    it("tells the bound T3 thread about too_noisy, wrong, escalate and ack reactions", async () => {
      const harness = await announced();
      await harness.router.handleReaction(react("mute", "C9", "900.1", null));
      await harness.router.handleReaction(react("eyes::skin-tone-2", "C10", "900.2", null));
      await harness.router.handleReaction(react("x", "C10", "900.2", null));
      await harness.router.handleReaction(react("rotating_light", "C9", "900.1", null));

      expect(notes(harness, "t-disk")).toEqual([
        '[Slack reaction · Miro reacted :mute: (too_noisy) to your message "Alert in C9: disk is 91% full"]\n' +
          "Stop posting about this issue unless it becomes urgent; record the mute in ~/ops-notes/known-issues.md.",
        '[Slack reaction · Miro reacted :rotating_light: (escalate) to your message "Alert in C9: disk is 91% full"]\n' +
          "Treat as urgent: re-investigate now and post an update in this Slack thread regardless of the daily cap.",
      ]);
      expect(notes(harness, "t-db")).toEqual([
        '[Slack reaction · Miro reacted :eyes: (ack) to your message "Alert in C10: disk is 91% full"]\n' +
          "A human is handling this; don't send reminders or follow-up nudges about it. Reply NO_REPLY.",
        '[Slack reaction · Miro reacted :x: (wrong) to your message "Alert in C10: disk is 91% full"]\n' +
          "Re-check the claim in that message read-only; if it was wrong, post a short correction in this Slack thread; otherwise reply NO_REPLY.",
      ]);
      expect(harness.sent("t-disk")[0]!.text).toMatch(/^\[Slack · Miro · /);
      expect(harness.opened).toEqual([]);
      await harness.router.stop();
    });

    it("routes the thread's answer back to the reacted Slack thread and keeps NO_REPLY quiet", async () => {
      const harness = await announced();
      await harness.feed("t-disk", { kind: "snapshot", snapshotSequence: 1, projection: { nodes: [], runtimeRequests: [], messages: [], runs: [], subagents: [], turnItems: [] } });
      await harness.router.handleReaction(react("thinking_face", "C9", "901.5", "900.1"));
      await harness.router.handleReaction(react("eyes", "C9", "901.5", "900.1"));
      const [wrong, ack] = harness.sent("t-disk");
      const requested = (id: string, messageId: string, ms: number) =>
        event("run.updated", { id, userMessageId: messageId, status: "completed", requestedAt: later(ms) });
      await harness.feed("t-disk", requested("run-wrong", wrong!.messageId!, 100));
      await harness.feed("t-disk", reply("a-wrong", "run-wrong", "Correction: it is 81%, not 91%."));
      await harness.feed("t-disk", requested("run-ack", ack!.messageId!, 200));
      await harness.feed("t-disk", reply("a-ack", "run-ack", "NO_REPLY"));
      await settle();

      expect(
        harness.upserts
          .filter(({ post }) => post.kind === "assistant")
          .map(({ conversation, post }) => [conversation.id, conversation.threadTs, (post as { markdown: string }).markdown]),
      ).toEqual([
        ["C9", undefined, "Alert in C9: disk is 91% full"],
        ["C10", undefined, "Alert in C10: disk is 91% full"],
        ["C9", "900.1", "Correction: it is 81%, not 91%."],
      ]);
      await harness.router.stop();
    });

    it("only logs reactions on unbound messages, removals and logged-only categories", async () => {
      const harness = await announced();
      await harness.router.handleReaction(react("mute", "C9", "777.1", null));
      await harness.router.handleReaction(react("mute", "C9", "900.1", null, "removed"));
      for (const emoji of ["+1", "-1", "nerd_face", "octopus"])
        await harness.router.handleReaction(react(emoji, "C9", "900.1", null));

      expect(harness.sent("t-disk")).toEqual([]);
      expect(harness.opened).toEqual([]);
      expect((await recorded(harness.dataDir)).map((entry) => [entry.reaction, entry.category, entry.change, entry.threadId])).toEqual([
        ["mute", "too_noisy", "added", null],
        ["mute", "too_noisy", "removed", "t-disk"],
        ["+1", "useful", "added", "t-disk"],
        ["-1", "not_useful", "added", "t-disk"],
        ["nerd_face", "too_technical", "added", "t-disk"],
        ["octopus", "other", "added", "t-disk"],
      ]);
      await harness.router.stop();
    });

    it("acts once on the same emoji repeated on a message, but on each different one", async () => {
      const harness = await announced();
      await harness.router.handleReaction(react("mute", "C9", "900.1", null));
      await harness.router.handleReaction(react("mute", "C9", "900.1", null, "removed"));
      await harness.router.handleReaction(react("mute::skin-tone-3", "C9", "900.1", null));
      await harness.router.handleReaction(react("zzz", "C9", "900.1", null));
      await harness.router.handleReaction(react("mute", "C10", "900.2", null));

      expect(notes(harness, "t-disk").map((note) => /:(\w+): \(/.exec(note)![1])).toEqual(["mute", "zzz"]);
      expect(notes(harness, "t-db").map((note) => /:(\w+): \(/.exec(note)![1])).toEqual(["mute"]);
      expect(await recorded(harness.dataDir)).toHaveLength(5);
      await harness.router.stop();
    });

    it("follows the bot's own category map", async () => {
      const harness = await announced({ reactionCategories: { escalate: ["octopus"], useful: ["mute"] } });
      await harness.router.handleReaction(react("octopus", "C9", "900.1", null));
      await harness.router.handleReaction(react("mute", "C9", "900.1", null));
      await harness.router.handleReaction(react("rotating_light", "C9", "900.1", null));

      expect(notes(harness, "t-disk")).toEqual([
        '[Slack reaction · Miro reacted :octopus: (escalate) to your message "Alert in C9: disk is 91% full"]\n' +
          "Treat as urgent: re-investigate now and post an update in this Slack thread regardless of the daily cap.",
      ]);
      await harness.router.stop();
    });
  });
});
