import { beforeEach, describe, expect, it, type Mock } from "vitest";

import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from "../mock-adapter";
import { ThreadHistoryCache } from "../thread-history";
import type { Adapter } from "../types";
import { ThreadHistoryApiImpl } from "./thread";

const NO_THREAD_HISTORY_CACHE_RE = /no ThreadHistoryCache/;
const NO_ADAPTER_RE = /no adapter registered/;

function createPersistAdapter(name = "telegram"): Adapter {
  return Object.assign(createMockAdapter(name), {
    persistThreadHistory: true,
  });
}

describe("ThreadHistoryApiImpl", () => {
  let mockAdapter: Adapter;
  let persistAdapter: Adapter;
  let cache: ThreadHistoryCache;
  let api: ThreadHistoryApiImpl;

  const resolver = (name: string) => {
    if (name === "slack") {
      return mockAdapter;
    }
    if (name === "telegram") {
      return persistAdapter;
    }
    return undefined;
  };

  beforeEach(() => {
    mockAdapter = createMockAdapter("slack");
    persistAdapter = createPersistAdapter();
    cache = new ThreadHistoryCache(createMockState());
    api = new ThreadHistoryApiImpl(resolver, cache);
  });

  it("list delegates to adapter.fetchMessages when messages exist", async () => {
    const msg = createTestMessage("m1", "hello");
    (mockAdapter.fetchMessages as Mock).mockResolvedValue({
      messages: [msg],
      nextCursor: "cursor-1",
    });

    const result = await api.list("slack:C123:1234.5678", { limit: 10 });

    expect(mockAdapter.fetchMessages).toHaveBeenCalledWith(
      "slack:C123:1234.5678",
      { limit: 10 }
    );
    expect(result.messages).toEqual([msg]);
    expect(result.nextCursor).toBe("cursor-1");
  });

  it("list throws for an unregistered adapter prefix", async () => {
    await expect(api.list("slcak:C123:1234.5678")).rejects.toThrow(
      NO_ADAPTER_RE
    );
  });

  it("list returns the adapter's empty page for non-persisting adapters", async () => {
    (mockAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });
    await cache.append(
      "slack:C123:1234.5678",
      createTestMessage("c1", "cached")
    );

    const result = await api.list("slack:C123:1234.5678", { limit: 5 });

    expect(result.messages).toEqual([]);
  });

  it("list falls back to cache for adapters with persistThreadHistory", async () => {
    (persistAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });

    const cached = createTestMessage("c1", "cached");
    await cache.append("telegram:C123:42", cached);

    const result = await api.list("telegram:C123:42", { limit: 5 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("cached");
  });

  it("list does not substitute the cache on a continuation page", async () => {
    (persistAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });
    await cache.append("telegram:C123:42", createTestMessage("c1", "cached"));

    const result = await api.list("telegram:C123:42", {
      limit: 5,
      cursor: "page-2",
    });

    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("list cache fallback windows by direction: backward newest-N, forward oldest-N", async () => {
    (persistAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });
    for (const [id, text] of [
      ["c1", "one"],
      ["c2", "two"],
      ["c3", "three"],
    ] as const) {
      await cache.append("telegram:C123:42", createTestMessage(id, text));
    }

    const backward = await api.list("telegram:C123:42", { limit: 2 });
    expect(backward.messages.map((m) => m.text)).toEqual(["two", "three"]);

    const forward = await api.list("telegram:C123:42", {
      limit: 2,
      direction: "forward",
    });
    expect(forward.messages.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("collect yields adapter messages when available", async () => {
    const m1 = createTestMessage("m1", "one");
    const m2 = createTestMessage("m2", "two");
    (mockAdapter.fetchMessages as Mock)
      .mockResolvedValueOnce({ messages: [m1], nextCursor: "c2" })
      .mockResolvedValueOnce({ messages: [m2] });

    const collected: string[] = [];
    for await (const msg of api.collect("slack:C123:1234.5678")) {
      collected.push(msg.text);
    }

    expect(collected).toEqual(["one", "two"]);
  });

  it("collect throws for an unregistered adapter prefix", async () => {
    const iterate = async () => {
      const collected: string[] = [];
      for await (const msg of api.collect("slcak:C123:1234.5678")) {
        collected.push(msg.text);
      }
      return collected;
    };

    await expect(iterate()).rejects.toThrow(NO_ADAPTER_RE);
  });

  it("collect stops when a page is empty even if the adapter echoes a cursor", async () => {
    const m1 = createTestMessage("m1", "one");
    (mockAdapter.fetchMessages as Mock)
      .mockResolvedValueOnce({ messages: [m1], nextCursor: "c2" })
      .mockResolvedValue({ messages: [], nextCursor: "c2" });

    const collected: string[] = [];
    for await (const msg of api.collect("slack:C123:1234.5678")) {
      collected.push(msg.text);
    }

    expect(collected).toEqual(["one"]);
    expect(mockAdapter.fetchMessages).toHaveBeenCalledTimes(2);
  });

  it("collect falls back to cache for adapters with persistThreadHistory", async () => {
    (persistAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });

    const cached = createTestMessage("c1", "from cache");
    await cache.append("telegram:C123:42", cached);

    const collected: string[] = [];
    for await (const msg of api.collect("telegram:C123:42")) {
      collected.push(msg.text);
    }

    expect(collected).toEqual(["from cache"]);
  });

  it("collect does not fall back to cache for non-persisting adapters", async () => {
    (mockAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });
    await cache.append(
      "slack:C123:1234.5678",
      createTestMessage("c1", "cached")
    );

    const collected: string[] = [];
    for await (const msg of api.collect("slack:C123:1234.5678")) {
      collected.push(msg.text);
    }

    expect(collected).toEqual([]);
  });

  it("collect cache fallback yields the oldest N, matching the adapter path", async () => {
    (persistAdapter.fetchMessages as Mock).mockResolvedValue({ messages: [] });
    for (const [id, text] of [
      ["c1", "one"],
      ["c2", "two"],
      ["c3", "three"],
    ] as const) {
      await cache.append("telegram:C123:42", createTestMessage(id, text));
    }

    const collected: string[] = [];
    for await (const msg of api.collect("telegram:C123:42", { limit: 2 })) {
      collected.push(msg.text);
    }

    expect(collected).toEqual(["one", "two"]);
  });

  it("append writes to the thread history cache", async () => {
    const msg = createTestMessage("m1", "stored");
    await api.append("slack:C123:1234.5678", msg);

    const stored = await cache.getMessages("slack:C123:1234.5678");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("stored");
  });

  it("collect returns immediately when limit is 0", async () => {
    const collected: string[] = [];
    for await (const msg of api.collect("slack:C123:1234.5678", { limit: 0 })) {
      collected.push(msg.text);
    }

    expect(collected).toEqual([]);
    expect(mockAdapter.fetchMessages).not.toHaveBeenCalled();
  });

  it("append throws when no cache was provided", async () => {
    const noCacheApi = new ThreadHistoryApiImpl(resolver);
    const msg = createTestMessage("m1", "x");

    await expect(
      noCacheApi.append("slack:C123:1234.5678", msg)
    ).rejects.toThrow(NO_THREAD_HISTORY_CACHE_RE);
  });
});
