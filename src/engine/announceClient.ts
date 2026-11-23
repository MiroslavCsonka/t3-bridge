import * as Path from "node:path";

import { readJson, type BridgeConfig } from "./store.ts";

export interface AnnounceArgs {
  readonly bot?: string | undefined;
  readonly channel?: string | undefined;
  readonly thread?: string | undefined;
  readonly slackThread?: string | undefined;
  readonly title?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface AnnounceOutcome {
  readonly exitCode: number;
  readonly output: Record<string, unknown>;
}

type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function runAnnounce(
  dataDir: string,
  args: AnnounceArgs,
  text: string,
  fetcher: Fetch = fetch as unknown as Fetch,
): Promise<AnnounceOutcome> {
  const fail = (error: string) => ({ exitCode: 1, output: { ok: false, error } });
  if (!args.bot || !args.channel || !args.thread)
    return fail("Usage: t3-bridge announce --bot <name|id> --channel <id> --thread <t3ThreadId> [--slack-thread <ts>] [--title <title>] [--dry-run] < text");
  if (text.trim() === "") return fail("Pass the text to post on stdin.");
  const config = await readJson<BridgeConfig>(Path.join(dataDir, "config.json"));
  if (config === null) return fail("T3 Bridge is not set up on this computer.");
  const base = `http://127.0.0.1:${config.controlPort}`;
  const headers = { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" };
  const call = async (path: string, body?: unknown) => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => null);
    if (response === null) return { ok: false, body: { error: "T3 Bridge is not running." } as Record<string, unknown> };
    return { ok: response.ok, body: ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  };
  const status = await call("/api/status");
  if (!status.ok) return fail(String(status.body.error ?? "T3 Bridge did not answer."));
  const bots = (status.body.bots ?? []) as Array<{ id: string; name: string }>;
  const wanted = args.bot.trim().toLowerCase();
  const bot =
    bots.find((candidate) => candidate.id === args.bot) ??
    bots.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
  if (bot === undefined) return fail(`No bot named ${args.bot}. Bots: ${bots.map((candidate) => candidate.name).join(", ") || "none"}.`);
  const result = await call(`/api/bots/${bot.id}/announce`, {
    channel: args.channel,
    threadId: args.thread,
    text,
    ...(args.slackThread ? { slackThreadTs: args.slackThread } : {}),
    ...(args.title ? { title: args.title } : {}),
    dryRun: args.dryRun === true,
  });
  if (!result.ok) return fail(String(result.body.error ?? "Announce failed."));
  return { exitCode: 0, output: result.body };
}
