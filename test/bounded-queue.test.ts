import { describe, expect, it } from "vitest";

import { BoundedQueue } from "../src/utils/bounded-queue";

/** A queued message whose text is `raw`. */
const m = (raw: string) => ({ raw });

describe("BoundedQueue", () => {
  it("keeps messages in order and tracks their total size in bytes", () => {
    const queue = new BoundedQueue<{ raw: string }>(10, 100);

    expect(queue.push(m("m-1"))).toEqual([]);
    expect(queue.push(m("é"))).toEqual([]);

    expect(queue.length).toBe(2);
    // "é" is one character but two UTF-8 bytes.
    expect(queue.bytes).toBe(5);
    expect(queue.drain()).toEqual([m("m-1"), m("é")]);
  });

  it("drops the oldest message when the count bound is reached", () => {
    const queue = new BoundedQueue<{ raw: string }>(2, 100);

    queue.push(m("m-1"));
    queue.push(m("m-2"));

    expect(queue.push(m("m-3"))).toEqual([m("m-1")]);
    expect(queue.drain()).toEqual([m("m-2"), m("m-3")]);
  });

  it("drops the oldest messages until a new one fits the byte bound", () => {
    const queue = new BoundedQueue<{ raw: string }>(10, 10);

    queue.push(m("aaa"));
    queue.push(m("bbb"));
    queue.push(m("ccc"));

    expect(queue.push(m("dddddd"))).toEqual([m("aaa"), m("bbb")]);
    expect(queue.bytes).toBe(9);
    expect(queue.drain()).toEqual([m("ccc"), m("dddddd")]);
  });

  it("keeps a single message larger than the byte bound on its own", () => {
    const queue = new BoundedQueue<{ raw: string }>(10, 4);

    queue.push(m("aa"));

    expect(queue.push(m("bbbbbb"))).toEqual([m("aa")]);
    expect(queue.drain()).toEqual([m("bbbbbb")]);
  });

  it("is empty after drain and clear", () => {
    const queue = new BoundedQueue<{ raw: string }>(10, 100);

    queue.push(m("m-1"));
    queue.drain();
    expect(queue.length).toBe(0);
    expect(queue.bytes).toBe(0);

    queue.push(m("m-2"));
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
