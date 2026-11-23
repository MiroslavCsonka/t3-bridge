import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { BotConfig } from "../store.ts";
import type { InboundReaction } from "./types.ts";

const MAX_TEXT = 200;
const MAX_QUOTE = 120;

export type ReactionCategories = Readonly<Record<string, ReadonlyArray<string>>>;

export const DEFAULT_REACTION_CATEGORIES: ReactionCategories = {
  useful: ["+1", "thumbsup", "heart", "tada", "raised_hands", "100", "white_check_mark"],
  not_useful: ["-1", "thumbsdown"],
  too_technical: ["nerd_face", "face_with_monocle", "robot_face"],
  too_noisy: ["mute", "zzz", "sleeping", "no_bell"],
  wrong: ["x", "warning", "thinking_face"],
  escalate: ["rotating_light", "sos", "fire"],
  ack: ["eyes"],
};

export const OTHER_CATEGORY = "other";

export const REACTION_EFFECTS: Readonly<Record<string, string>> = {
  too_noisy:
    "Stop posting about this issue unless it becomes urgent; record the mute in ~/ops-notes/known-issues.md.",
  wrong:
    "Re-check the claim in that message read-only; if it was wrong, post a short correction in this Slack thread; otherwise reply NO_REPLY.",
  escalate:
    "Treat as urgent: re-investigate now and post an update in this Slack thread regardless of the daily cap.",
  ack: "A human is handling this; don't send reminders or follow-up nudges about it. Reply NO_REPLY.",
};

export function emojiName(reaction: string) {
  return reaction.trim().replace(/^:|:$/g, "").replace(/::skin-tone-[2-6]$/, "").toLowerCase();
}

export function reactionCategory(reaction: string, categories: ReactionCategories = DEFAULT_REACTION_CATEGORIES) {
  const name = emojiName(reaction);
  return Object.entries(categories).find(([, names]) => names.includes(name))?.[0] ?? OTHER_CATEGORY;
}

export function reactionCategoriesOf(input: unknown): Record<string, string[]> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  const result: Record<string, string[]> = {};
  for (const [category, names] of Object.entries(input)) {
    const key = category.trim().toLowerCase().replace(/\s+/g, "_");
    if (!key || key === OTHER_CATEGORY || !Array.isArray(names)) continue;
    const emoji = [
      ...new Set(names.filter((name): name is string => typeof name === "string").map(emojiName).filter(Boolean)),
    ];
    if (emoji.length > 0) result[key] = [...new Set([...(result[key] ?? []), ...emoji])];
  }
  return result;
}

export function categoriesFor(bot: BotConfig): ReactionCategories {
  return bot.reactionCategories ?? DEFAULT_REACTION_CATEGORIES;
}

export function reactionNote(entry: FeedbackEntry, userName: string): string | null {
  const instruction = REACTION_EFFECTS[entry.category];
  if (instruction === undefined) return null;
  const quote = (entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE);
  return `[Slack reaction · ${userName} reacted :${emojiName(entry.reaction)}: (${entry.category}) to your message "${quote}"]\n${instruction}`;
}

export function feedbackFile(dataDir: string) {
  return Path.join(dataDir, "feedback.jsonl");
}

export interface FeedbackEntry {
  readonly ts: string;
  readonly botId: string;
  readonly botName: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly threadTs: string | null;
  readonly permalink: string | null;
  readonly threadId: string | null;
  readonly reaction: string;
  readonly category: string;
  readonly userId: string;
  readonly change: "added" | "removed";
  readonly text: string | null;
}

export async function recordFeedback(options: {
  readonly dataDir: string;
  readonly bot: BotConfig;
  readonly reaction: InboundReaction;
  readonly threadIdOf: (threadTs: string | null) => string | null;
}): Promise<FeedbackEntry | null> {
  const { bot, reaction } = options;
  if (!bot.allowedUserIds.includes(reaction.userId)) return null;
  const details = await reaction.details();
  const entry: FeedbackEntry = {
    ts: reaction.at,
    botId: bot.id,
    botName: bot.name,
    channel: reaction.channel,
    messageTs: reaction.messageTs,
    threadTs: details.threadTs,
    permalink: details.permalink,
    threadId: options.threadIdOf(details.threadTs),
    reaction: reaction.reaction,
    category: reactionCategory(reaction.reaction, categoriesFor(bot)),
    userId: reaction.userId,
    change: reaction.change,
    text: details.text === null ? null : details.text.slice(0, MAX_TEXT),
  };
  const file = feedbackFile(options.dataDir);
  await FS.mkdir(Path.dirname(file), { recursive: true });
  await FS.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}
