import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BotConfig } from "../store.ts";
import {
  DEFAULT_REACTION_CATEGORIES,
  feedbackFile,
  reactionCategoriesOf,
  reactionCategory,
  reactionNote,
  recordFeedback,
  type FeedbackEntry,
} from "./feedback.ts";
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

describe("reactionCategory", () => {
  it("sorts the default emoji into their categories, ignoring skin tones and colons", () => {
    expect(
      ["+1", "thumbsup::skin-tone-4", "heart", "100", "white_check_mark", ":tada:", "raised_hands::skin-tone-2"].map(
        (name) => reactionCategory(name),
      ),
    ).toEqual(Array(7).fill("useful"));
    expect(["-1::skin-tone-6", "thumbsdown"].map((name) => reactionCategory(name))).toEqual(["not_useful", "not_useful"]);
    expect(reactionCategory("face_with_monocle")).toBe("too_technical");
    expect(reactionCategory("no_bell")).toBe("too_noisy");
    expect(reactionCategory("thinking_face")).toBe("wrong");
    expect(reactionCategory("sos")).toBe("escalate");
    expect(reactionCategory("eyes")).toBe("ack");
  });

  it("files unknown emoji under other", () => {
    for (const name of ["octopus", "thumbsup_all", "+1::skin-tone-9", "party_parrot"])
      expect(reactionCategory(name)).toBe("other");
  });

  it("uses a bot's own map instead of the defaults", () => {
    const categories = { useful: ["rocket"], escalate: ["fire"] };
    expect(reactionCategory("rocket", categories)).toBe("useful");
    expect(reactionCategory("+1", categories)).toBe("other");
    expect(reactionCategory("fire::skin-tone-3", categories)).toBe("escalate");
  });
});

describe("reactionCategoriesOf", () => {
  it("normalises names and emoji and drops what cannot be used", () => {
    expect(
      reactionCategoriesOf({
        " Too Noisy ": [":mute:", "zzz::skin-tone-2", "mute", 7],
        other: ["octopus"],
        empty: [],
        broken: "fire",
      }),
    ).toEqual({ too_noisy: ["mute", "zzz"] });
    expect(reactionCategoriesOf(null)).toEqual({});
    expect(reactionCategoriesOf(["fire"])).toEqual({});
  });
});

describe("reactionNote", () => {
  const entry = (category: string, text: string | null = "Disk is 91% full\non db-1"): FeedbackEntry => ({
    ts: "2026-11-23T10:00:00.000Z",
    botId: "bot-1",
    botName: "MoMi",
    channel: "C9",
    messageTs: "100.2",
    threadTs: "100.1",
    permalink: null,
    threadId: "t-1",
    reaction: "mute::skin-tone-2",
    category,
    userId: "U1",
    change: "added",
    text,
  });

  it("quotes the first 120 characters of the message with the category's instruction", () => {
    expect(reactionNote(entry("too_noisy"), "Miro")).toBe(
      '[Slack reaction · Miro reacted :mute: (too_noisy) to your message "Disk is 91% full on db-1"]\n' +
        "Stop posting about this issue unless it becomes urgent; record the mute in ~/ops-notes/known-issues.md.",
    );
    expect(reactionNote(entry("wrong", "y".repeat(300)), "Miro")).toContain(`"${"y".repeat(120)}"]`);
    expect(reactionNote(entry("escalate"), "Miro")).toMatch(/regardless of the daily cap\.$/);
    expect(reactionNote(entry("ack", null), "Miro")).toMatch(/message ""\]\nA human is handling this; .* Reply NO_REPLY\.$/);
  });

  it("has nothing to say for logged-only categories", () => {
    for (const category of ["useful", "not_useful", "too_technical", "other"]) expect(reactionNote(entry(category), "Miro")).toBeNull();
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
      category: "useful",
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

    expect((await lines(dir)).map((entry) => [entry.reaction, entry.category, entry.change, entry.threadId])).toEqual([
      ["-1::skin-tone-3", "not_useful", "added", null],
      ["-1::skin-tone-3", "not_useful", "removed", null],
    ]);
  });

  it("categorises with the bot's own map and records unknown emoji as other", async () => {
    const dir = await dataDir();
    const custom = { ...bot, reactionCategories: { too_noisy: ["octopus"] } };
    await recordFeedback({ dataDir: dir, bot: custom, reaction: reaction({ reaction: "octopus" }), threadIdOf: () => null });
    await recordFeedback({ dataDir: dir, bot: custom, reaction: reaction({ reaction: "mute" }), threadIdOf: () => null });
    await recordFeedback({ dataDir: dir, bot, reaction: reaction({ reaction: "mute" }), threadIdOf: () => null });

    expect((await lines(dir)).map((entry) => [entry.reaction, entry.category])).toEqual([
      ["octopus", "too_noisy"],
      ["mute", "other"],
      ["mute", "too_noisy"],
    ]);
    expect(DEFAULT_REACTION_CATEGORIES.too_noisy).toEqual(["mute", "zzz", "sleeping", "no_bell"]);
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
