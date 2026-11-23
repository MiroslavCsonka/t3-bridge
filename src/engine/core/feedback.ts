import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { BotConfig } from "../store.ts";
import type { InboundReaction } from "./types.ts";

const FEEDBACK_REACTION = /^(\+1|-1|thumbsup|thumbsdown)(::skin-tone-[2-6])?$/;
const MAX_TEXT = 200;

export function isFeedbackReaction(reaction: string) {
  return FEEDBACK_REACTION.test(reaction);
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
    userId: reaction.userId,
    change: reaction.change,
    text: details.text === null ? null : details.text.slice(0, MAX_TEXT),
  };
  const file = feedbackFile(options.dataDir);
  await FS.mkdir(Path.dirname(file), { recursive: true });
  await FS.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}
