import { isIP } from "node:net";

/**
 * The key a client is counted under by per-source limits, or `null` when
 * `address` is not a bare IP address (a list, a port, brackets…): such a value
 * must never become a key of its own, or each connection could pick one.
 *
 * IPv4-mapped IPv6 addresses count as their IPv4 address, and IPv6 clients
 * are grouped per /64, the block a single subscriber usually holds: keying on
 * the full address would hand anyone with a /64 billions of sources.
 */
export function clientSource(address: string): string | null {
  const trimmed = address.trim();
  const version = isIP(trimmed);
  if (version === 4) return trimmed;
  if (version !== 6) return null;

  const hextets = expandIpv6(trimmed.split("%")[0].toLowerCase());
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join(".");
  }
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (already checked by `isIP`). */
function expandIpv6(address: string): number[] {
  let text = address;
  // A trailing dotted IPv4 (`::ffff:1.2.3.4`) stands for the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((h) => parseInt(h, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  if (tail === undefined) return left;
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}
