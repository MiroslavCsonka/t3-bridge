import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import type { ModelSelection } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Engine } from "./Engine.ts";
import type { BotConfig, SecretStore } from "./store.ts";
import type { T3Client } from "./t3/T3Client.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

const MODEL = { instanceId: "claude", model: "claude-opus" } as ModelSelection;
const OTHER_MODEL = { instanceId: "codex", model: "gpt" } as ModelSelection;

function project(id: string) {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: OTHER_MODEL,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function thread(id: string, projectId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    projectId,
    modelSelection: MODEL,
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    status: "idle",
    lineage: { relationshipToParent: null },
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...extra,
  };
}

interface World {
  projects: ReturnType<typeof project>[];
  threads: ReturnType<typeof thread>[];
  archived: ReturnType<typeof thread>[];
  projection?: ReturnType<typeof thread>;
}

async function setup(world: World, botExtra: Partial<BotConfig> = {}) {
  const dataDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-engine-"));
  dirs.push(dataDir);
  const lines: string[] = [];
  const secrets: SecretStore = { get: async () => null, set: async () => {}, delete: async () => {} };
  const engine = new Engine({ dataDir, secrets, logSink: (line) => lines.push(line) });
  await engine.config.load();
  const bot: BotConfig = {
    id: "bot-1",
    name: "MoMi",
    platform: "slack",
    enabled: false,
    threadId: "orchestrator-old",
    allowedUserIds: ["U1"],
    instructions: "Be the orchestrator",
    reminder: false,
    conversationMode: "per-thread",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...botExtra,
  };
  await engine.config.update((config) => ({ ...config, bots: [bot] }));
  const commands: Array<{ type: string; threadId?: string }> = [];
  const launches: Array<{ projectId: string; title: string; modelSelection: unknown }> = [];
  engine.t3 = {
    getShell: async () => ({ projects: world.projects, threads: world.threads }),
    getArchivedShell: async () => ({ projects: world.projects, threads: world.archived }),
    getThreadProjection: async () => {
      if (world.projection === undefined) throw new Error("Thread not found");
      return { thread: world.projection };
    },
    dispatch: async (command: { type: string; threadId?: string }) => {
      commands.push(command);
      if (command.type === "thread.unarchive") {
        const index = world.archived.findIndex((candidate) => candidate.id === command.threadId);
        const [restored] = world.archived.splice(index, 1);
        world.threads.push({ ...restored!, archivedAt: null });
      }
      return { sequence: 1 };
    },
    launchThread: async (input: { projectId: string; title: string; modelSelection: unknown }) => {
      launches.push(input);
      const threadId = `launched-${launches.length}`;
      world.threads.push(thread(threadId, input.projectId));
      return { threadId };
    },
  } as unknown as T3Client;
  const storedBot = () => engine.config.get().bots[0]!;
  return { engine, lines, commands, launches, storedBot };
}

const first = { messageId: "m-1", text: "hello", attachments: [] };

describe("Engine recovering the bot's orchestrator thread", () => {
  it("unarchives and re-pins an archived orchestrator, then opens the conversation like before", async () => {
    const world: World = {
      projects: [project("p1"), project("p2")],
      threads: [],
      archived: [thread("orchestrator-old", "p1", { archivedAt: "2026-11-23T00:00:00.000Z" })],
    };
    const { engine, lines, commands, launches, storedBot } = await setup(world);

    const opened = await engine.createConversationThread("bot-1", "Deploy question", first);

    expect(opened.threadId).toBe("launched-1");
    expect(commands.map((command) => [command.type, command.threadId])).toEqual([
      ["thread.unarchive", "orchestrator-old"],
      ["thread.pin", "orchestrator-old"],
    ]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ projectId: "p1", title: "Deploy question", modelSelection: MODEL });
    expect(storedBot()).toMatchObject({ threadId: "orchestrator-old", projectId: "p1", modelSelection: MODEL });
    expect(lines.some((line) => /WARN .*T3_BOT_THREAD_RECOVERED bot=bot-1 .*unarchived/.test(line))).toBe(true);
  });

  it("replaces a deleted orchestrator from the stored project and model", async () => {
    const world: World = { projects: [project("p1"), project("p2")], threads: [], archived: [] };
    const { engine, lines, launches, storedBot } = await setup(world, {
      projectId: "p2",
      modelSelection: MODEL,
    });

    const opened = await engine.createConversationThread("bot-1", "Deploy question", first);

    expect(launches.map((launch) => [launch.projectId, launch.title.startsWith("MoMi orchestrator · ")])).toEqual([
      ["p2", true],
      ["p2", false],
    ]);
    expect(launches.every((launch) => launch.modelSelection === MODEL)).toBe(true);
    expect(opened.threadId).toBe("launched-2");
    expect(storedBot()).toMatchObject({ threadId: "launched-1", projectId: "p2", modelSelection: MODEL });
    expect(lines.some((line) => /WARN .*T3_BOT_THREAD_RECOVERED bot=bot-1 .*replaced/.test(line))).toBe(true);
  });

  it("replaces a deleted orchestrator with no stored config from what T3 still remembers of it", async () => {
    const world: World = {
      projects: [project("p1"), project("p2")],
      threads: [],
      archived: [],
      projection: thread("orchestrator-old", "p2", { deletedAt: "2026-11-23T00:00:00.000Z" }),
    };
    const { engine, launches, storedBot } = await setup(world);

    await engine.createConversationThread("bot-1", "Deploy question", first);

    expect(launches.map((launch) => launch.projectId)).toEqual(["p2", "p2"]);
    expect(storedBot()).toMatchObject({ threadId: "launched-1", projectId: "p2", modelSelection: MODEL });
  });

  it("replaces a deleted orchestrator with no stored config in the only project there is", async () => {
    const world: World = { projects: [project("p1")], threads: [], archived: [] };
    const { engine, launches, storedBot } = await setup(world);

    await engine.createConversationThread("bot-1", "Deploy question", first);

    expect(launches.map((launch) => [launch.projectId, launch.modelSelection])).toEqual([
      ["p1", OTHER_MODEL],
      ["p1", OTHER_MODEL],
    ]);
    expect(storedBot()).toMatchObject({ threadId: "launched-1", projectId: "p1" });
  });

  it("logs an error and never asks the user to pick a thread when nothing is left to recover from", async () => {
    const world: World = { projects: [project("p1"), project("p2")], threads: [], archived: [] };
    const { engine, lines, launches } = await setup(world);

    const failure = await engine.createConversationThread("bot-1", "Deploy question", first).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).not.toMatch(/pick one/i);
    expect(launches).toHaveLength(0);
    expect(lines.some((line) => /ERROR .*bot=bot-1/.test(line))).toBe(true);
  });

  it("uses a settled orchestrator as it is and stores its project and model", async () => {
    const world: World = {
      projects: [project("p1")],
      threads: [thread("orchestrator-old", "p1", { settledAt: "2026-11-23T00:00:00.000Z" })],
      archived: [],
    };
    const { engine, commands, launches, storedBot } = await setup(world);

    await engine.createConversationThread("bot-1", "Deploy question", first);

    expect(commands).toEqual([]);
    expect(launches).toHaveLength(1);
    expect(storedBot()).toMatchObject({ threadId: "orchestrator-old", projectId: "p1", modelSelection: MODEL });
  });
});
