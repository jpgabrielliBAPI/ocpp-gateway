/**
 * A FIFO of messages bounded both by count and by total UTF-8 size; the oldest
 * messages are dropped first to make room. The incoming message is always kept,
 * even alone above `maxBytes`, so a message is never dropped on its own.
 * Messages carry their text as `raw`, which sets their size.
 */
export class BoundedQueue<T extends { raw: string }> {
  private messages: T[] = [];
  /** `Buffer.byteLength` of each message, measured once on push. */
  private sizes: number[] = [];
  private totalBytes = 0;

  constructor(
    readonly maxCount: number,
    readonly maxBytes: number,
  ) {}

  get length(): number {
    return this.messages.length;
  }

  /** Total size of the queued messages, in bytes. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Append `message`, dropping the oldest messages to fit; returns the dropped ones. */
  push(message: T): T[] {
    const size = Buffer.byteLength(message.raw);
    const dropped: T[] = [];
    while (
      this.messages.length > 0 &&
      (this.messages.length >= this.maxCount || this.totalBytes + size > this.maxBytes)
    ) {
      dropped.push(this.messages.shift()!);
      this.totalBytes -= this.sizes.shift()!;
    }
    this.messages.push(message);
    this.sizes.push(size);
    this.totalBytes += size;
    return dropped;
  }

  /** Remove and return every queued message, oldest first. */
  drain(): T[] {
    const messages = this.messages;
    this.clear();
    return messages;
  }

  clear(): void {
    this.messages = [];
    this.sizes = [];
    this.totalBytes = 0;
  }
}
