import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BotConfig } from "../store.ts";
import { feedbackFile, isFeedbackReaction, recordFeedback } from "./feedback.ts";
import type { InboundReaction } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

async function dataDir() {
  const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-feedback-"));
  dirs.push(dir);
  return dir;
}

const bot: BotConfig = {
  id: "bot-1",
  name: "MoMi",
  platform: "slack",
  enabled: true,
  threadId: null,
  allowedUserIds: ["U1"],
  instructions: "",
  reminder: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};

function reaction(overrides: Partial<InboundReaction> = {}): InboundReaction & { lookups: number } {
  const result = {
    lookups: 0,
    at: "2026-11-23T10:00:00.000Z",
    channel: "C9",
    messageTs: "100.2",
    reaction: "+1",
    userId: "U1",
    change: "added" as const,
    details: async () => {
      result.lookups += 1;
      return {
        threadTs: "100.1",
        permalink: "https://team.slack.com/archives/C9/p1002?thread_ts=100.1&cid=C9",
        text: "x".repeat(300),
      };
    },
    ...overrides,
  };
  return result;
}

async function lines(dir: string) {
  return (await FS.readFile(feedbackFile(dir), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("isFeedbackReaction", () => {
  it("accepts thumbs up and down with any skin tone", () => {
    for (const name of ["+1", "-1", "thumbsup", "thumbsdown", "+1::skin-tone-2", "thumbsdown::skin-tone-6"])
      expect(isFeedbackReaction(name)).toBe(true);
    for (const name of ["eyes", "white_check_mark", "+1::skin-tone-9", "heavy_plus_sign", "thumbsup_all"])
      expect(isFeedbackReaction(name)).toBe(false);
  });
});

describe("recordFeedback", () => {
  it("appends one JSON line per event in the documented shape", async () => {
    const dir = await dataDir();
    await recordFeedback({ dataDir: dir, bot, reaction: reaction(), threadIdOf: (threadTs) => `t-${threadTs}` });

    expect(feedbackFile(dir)).toBe(Path.join(dir, "feedback.jsonl"));
    const [entry] = await lines(dir);
    expect(entry).toEqual({
      ts: "2026-11-23T10:00:00.000Z",
      botId: "bot-1",
      botName: "MoMi",
      channel: "C9",
      messageTs: "100.2",
      threadTs: "100.1",
      permalink: "https://team.slack.com/archives/C9/p1002?thread_ts=100.1&cid=C9",
      threadId: "t-100.1",
      reaction: "+1",
      userId: "U1",
      change: "added",
      text: "x".repeat(200),
    });
    expect((await FS.stat(feedbackFile(dir))).mode & 0o777).toBe(0o600);
  });

  it("records a removal as its own line after the addition", async () => {
    const dir = await dataDir();
    await recordFeedback({ dataDir: dir, bot, reaction: reaction({ reaction: "-1::skin-tone-3" }), threadIdOf: () => null });
    await recordFeedback({
      dataDir: dir,
      bot,
      reaction: reaction({ reaction: "-1::skin-tone-3", change: "removed" }),
      threadIdOf: () => null,
    });

    expect((await lines(dir)).map((entry) => [entry.reaction, entry.change, entry.threadId])).toEqual([
      ["-1::skin-tone-3", "added", null],
      ["-1::skin-tone-3", "removed", null],
    ]);
  });

  it("ignores people who are not allowed to use the bot without looking the message up", async () => {
    const dir = await dataDir();
    const stranger = reaction({ userId: "U2" });
    const result = await recordFeedback({ dataDir: dir, bot, reaction: stranger, threadIdOf: () => null });

    expect(result).toBeNull();
    expect(stranger.lookups).toBe(0);
    await expect(FS.access(feedbackFile(dir))).rejects.toThrow();
  });

  it("keeps a null text when the message could not be read", async () => {
    const dir = await dataDir();
    await recordFeedback({
      dataDir: dir,
      bot,
      reaction: reaction({ details: async () => ({ threadTs: null, permalink: null, text: null }) }),
      threadIdOf: () => null,
    });

    expect((await lines(dir))[0]).toMatchObject({ threadTs: null, permalink: null, text: null });
  });
});
