import { describe, expect, it } from "vitest";

import { BoundedQueue } from "../src/utils/bounded-queue";

describe("BoundedQueue", () => {
  it("keeps messages in order and tracks their total size in bytes", () => {
    const queue = new BoundedQueue(10, 100);

    expect(queue.push("m-1")).toEqual([]);
    expect(queue.push("é")).toEqual([]);

    expect(queue.length).toBe(2);
    // "é" is one character but two UTF-8 bytes.
    expect(queue.bytes).toBe(5);
    expect(queue.drain()).toEqual(["m-1", "é"]);
  });

  it("drops the oldest message when the count bound is reached", () => {
    const queue = new BoundedQueue(2, 100);

    queue.push("m-1");
    queue.push("m-2");

    expect(queue.push("m-3")).toEqual(["m-1"]);
    expect(queue.drain()).toEqual(["m-2", "m-3"]);
  });

  it("drops the oldest messages until a new one fits the byte bound", () => {
    const queue = new BoundedQueue(10, 10);

    queue.push("aaa");
    queue.push("bbb");
    queue.push("ccc");

    expect(queue.push("dddddd")).toEqual(["aaa", "bbb"]);
    expect(queue.bytes).toBe(9);
    expect(queue.drain()).toEqual(["ccc", "dddddd"]);
  });

  it("keeps a single message larger than the byte bound on its own", () => {
    const queue = new BoundedQueue(10, 4);

    queue.push("aa");

    expect(queue.push("bbbbbb")).toEqual(["aa"]);
    expect(queue.drain()).toEqual(["bbbbbb"]);
  });

  it("is empty after drain and clear", () => {
    const queue = new BoundedQueue(10, 100);

    queue.push("m-1");
    queue.drain();
    expect(queue.length).toBe(0);
    expect(queue.bytes).toBe(0);

    queue.push("m-2");
    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.bytes).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("holds messages with metadata, sized by their raw text", () => {
    const queue = new BoundedQueue<{ raw: string; tag: number }>(10, 4);

    queue.push({ raw: "aa", tag: 1 });

    expect(queue.push({ raw: "bbb", tag: 2 })).toEqual([{ raw: "aa", tag: 1 }]);
    expect(queue.bytes).toBe(3);
    expect(queue.drain()).toEqual([{ raw: "bbb", tag: 2 }]);
  });
});
