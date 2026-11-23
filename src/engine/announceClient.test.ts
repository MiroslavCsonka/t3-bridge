import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAnnounce } from "./announceClient.ts";
import { writeJsonAtomic } from "./store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

const TOKEN = "secret-control-token";

async function bridgeDir() {
  const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-announce-"));
  dirs.push(dir);
  await writeJsonAtomic(Path.join(dir, "config.json"), { version: 1, controlToken: TOKEN, controlPort: 47999, t3: {}, bots: [] });
  return dir;
}

function bridge(announce: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; authorization: string; body: Record<string, unknown> | null }> = [];
  const fetcher = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const body = init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ url, method: init.method ?? "GET", authorization: init.headers.authorization ?? "", body });
    const answer = url.endsWith("/api/status")
      ? { status: 200, body: { bots: [{ id: "bot-1", name: "MoMi" }] } }
      : announce(body!);
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  return { calls, fetcher };
}

describe("t3-bridge announce", () => {
  it("authenticates with the bridge's own control token and never prints it", async () => {
    const dir = await bridgeDir();
    const { calls, fetcher } = bridge(() => ({
      status: 200,
      body: { ok: true, channel: "C9", ts: "900.1", permalink: "https://team.slack.com/archives/C9/p9001" },
    }));
    const outcome = await runAnnounce(
      dir,
      { bot: "momi", channel: "C9", thread: "t-alert", slackThread: "555.1", title: "Checkout" },
      "Errors doubled\n",
      fetcher,
    );

    expect(outcome).toEqual({
      exitCode: 0,
      output: { ok: true, channel: "C9", ts: "900.1", permalink: "https://team.slack.com/archives/C9/p9001" },
    });
    expect(calls.map(({ url, method, authorization }) => [url, method, authorization])).toEqual([
      ["http://127.0.0.1:47999/api/status", "GET", `Bearer ${TOKEN}`],
      ["http://127.0.0.1:47999/api/bots/bot-1/announce", "POST", `Bearer ${TOKEN}`],
    ]);
    expect(calls[1]!.body).toEqual({
      channel: "C9",
      threadId: "t-alert",
      text: "Errors doubled\n",
      slackThreadTs: "555.1",
      title: "Checkout",
      dryRun: false,
    });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("passes a dry run through and reports refusals as JSON errors", async () => {
    const dir = await bridgeDir();
    const { calls, fetcher } = bridge((body) =>
      body.dryRun === true
        ? { status: 200, body: { ok: true, dryRun: true, channel: "C9", ts: null, permalink: null } }
        : { status: 400, body: { error: "MoMi may not announce to channel C10." } },
    );
    const dry = await runAnnounce(dir, { bot: "bot-1", channel: "C9", thread: "t-alert", dryRun: true }, "Hi", fetcher);
    expect(dry).toMatchObject({ exitCode: 0, output: { ok: true, dryRun: true } });
    expect(calls[1]!.body).toMatchObject({ dryRun: true });

    const refused = await runAnnounce(dir, { bot: "MoMi", channel: "C10", thread: "t-alert" }, "Hi", fetcher);
    expect(refused).toEqual({ exitCode: 1, output: { ok: false, error: "MoMi may not announce to channel C10." } });
  });

  it("explains what is missing without calling the bridge", async () => {
    const dir = await bridgeDir();
    const { calls, fetcher } = bridge(() => ({ status: 200, body: {} }));
    expect(await runAnnounce(dir, { bot: "MoMi", channel: "C9" }, "Hi", fetcher)).toMatchObject({
      exitCode: 1,
      output: { ok: false, error: expect.stringContaining("Usage: t3-bridge announce") },
    });
    expect(await runAnnounce(dir, { bot: "MoMi", channel: "C9", thread: "t" }, "  ", fetcher)).toMatchObject({
      output: { error: "Pass the text to post on stdin." },
    });
    expect(await runAnnounce(dir, { bot: "Nobody", channel: "C9", thread: "t" }, "Hi", fetcher)).toMatchObject({
      output: { error: "No bot named Nobody. Bots: MoMi." },
    });
    expect(calls.every(({ url }) => url.endsWith("/api/status"))).toBe(true);

    const empty = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-announce-"));
    dirs.push(empty);
    expect(await runAnnounce(empty, { bot: "MoMi", channel: "C9", thread: "t" }, "Hi", fetcher)).toMatchObject({
      output: { error: "T3 Bridge is not set up on this computer." },
    });
    const down = await runAnnounce(dir, { bot: "MoMi", channel: "C9", thread: "t" }, "Hi", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(down).toMatchObject({ exitCode: 1, output: { error: "T3 Bridge is not running." } });
  });
});
