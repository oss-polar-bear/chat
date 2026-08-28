import { beforeEach, describe, expect, it, type Mock } from "vitest";

import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from "../mock-adapter";
import { ThreadHistoryCache } from "../thread-history";
import type { Adapter } from "../types";
import { ChannelHistoryApiImpl } from "./channel";
import { ThreadHistoryApiImpl } from "./thread";

const LIST_THREADS_UNSUPPORTED_RE = /does not implement listThreads/;
const CHANNEL_MESSAGES_UNSUPPORTED_RE =
  /does not support fetching channel messages/;
const NO_ADAPTER_RE = /no adapter registered/;

describe("ChannelHistoryApiImpl", () => {
  let mockAdapter: Adapter;
  let cache: ThreadHistoryCache;
  let api: ChannelHistoryApiImpl;

  const buildApi = (resolver: (name: string) => Adapter | undefined) =>
    new ChannelHistoryApiImpl(
      resolver,
      new ThreadHistoryApiImpl(resolver, cache),
      cache
    );

  beforeEach(() => {
    mockAdapter = createMockAdapter("slack");
    cache = new ThreadHistoryCache(createMockState());
    api = buildApi((name) => (name === "slack" ? mockAdapter : undefined));
  });

  it("listMessages uses fetchChannelMessages when available", async () => {
    const msg = createTestMessage("m1", "channel msg");
    (mockAdapter.fetchChannelMessages as Mock).mockResolvedValue({
      messages: [msg],
      nextCursor: "next",
    });

    const result = await api.listMessages("slack:C123", { limit: 10 });

    expect(mockAdapter.fetchChannelMessages).toHaveBeenCalledWith(
      "slack:C123",
      {
        limit: 10,
      }
    );
    expect(result.messages).toEqual([msg]);
  });

  it("listMessages throws when fetchChannelMessages is absent", async () => {
    mockAdapter.fetchChannelMessages = undefined;

    await expect(api.listMessages("slack:C123")).rejects.toThrow(
      CHANNEL_MESSAGES_UNSUPPORTED_RE
    );
    expect(mockAdapter.fetchMessages).not.toHaveBeenCalled();
  });

  it("listMessages throws for an unregistered adapter prefix", async () => {
    await expect(api.listMessages("github:owner/repo")).rejects.toThrow(
      NO_ADAPTER_RE
    );
  });

  it("listMessages serves persisting adapters from the channel-keyed cache", async () => {
    const persistAdapter = Object.assign(createMockAdapter("whatsapp"), {
      persistThreadHistory: true,
      fetchChannelMessages: undefined,
    });
    const persistApi = buildApi((name) =>
      name === "whatsapp" ? persistAdapter : undefined
    );
    for (const [id, text] of [
      ["c1", "one"],
      ["c2", "two"],
      ["c3", "three"],
    ] as const) {
      await cache.append("whatsapp:123", createTestMessage(id, text));
    }

    const backward = await persistApi.listMessages("whatsapp:123", {
      limit: 2,
    });
    expect(backward.messages.map((m) => m.text)).toEqual(["two", "three"]);

    const forward = await persistApi.listMessages("whatsapp:123", {
      limit: 2,
      direction: "forward",
    });
    expect(forward.messages.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("listThreads delegates to adapter.listThreads", async () => {
    const root = createTestMessage("root", "thread root");
    (mockAdapter.listThreads as Mock).mockResolvedValue({
      threads: [
        {
          id: "slack:C123:1111.2222",
          rootMessage: root,
          replyCount: 3,
        },
      ],
      nextCursor: "t-cursor",
    });

    const result = await api.listThreads("slack:C123", { limit: 5 });

    expect(mockAdapter.listThreads).toHaveBeenCalledWith("slack:C123", {
      limit: 5,
    });
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.id).toBe("slack:C123:1111.2222");
    expect(result.nextCursor).toBe("t-cursor");
  });

  it("listThreads throws when adapter does not implement listThreads", async () => {
    mockAdapter.listThreads = undefined;

    await expect(api.listThreads("slack:C123")).rejects.toThrow(
      LIST_THREADS_UNSUPPORTED_RE
    );
  });

  it("listThreadsWithMessages fetches messages for each thread", async () => {
    const root = createTestMessage("root", "root text");
    (mockAdapter.listThreads as Mock).mockResolvedValue({
      threads: [
        { id: "slack:C123:1111.2222", rootMessage: root },
        { id: "slack:C123:3333.4444", rootMessage: root },
      ],
    });
    (mockAdapter.fetchMessages as Mock).mockImplementation(
      async (threadId: string) => ({
        messages: [createTestMessage(`${threadId}-r`, `reply for ${threadId}`)],
      })
    );

    const result = await api.listThreadsWithMessages("slack:C123", {
      maxThreads: 2,
      messagesPerThread: 1,
    });

    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]?.threadId).toBe("slack:C123:1111.2222");
    expect(result.threads[0]?.messages[0]?.text).toContain("1111.2222");
  });

  it("listThreadsWithMessages bounds per-thread fetch concurrency", async () => {
    const root = createTestMessage("root", "root text");
    (mockAdapter.listThreads as Mock).mockResolvedValue({
      threads: Array.from({ length: 10 }, (_, i) => ({
        id: `slack:C123:${i}.0`,
        rootMessage: root,
      })),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    (mockAdapter.fetchMessages as Mock).mockImplementation(
      async (threadId: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return {
          messages: [createTestMessage(`${threadId}-r`, "reply")],
        };
      }
    );

    const result = await api.listThreadsWithMessages("slack:C123", {
      maxThreads: 10,
    });

    expect(result.threads).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});
