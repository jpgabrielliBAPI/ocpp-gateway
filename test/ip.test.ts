import { describe, expect, it } from "vitest";
import { clientSource } from "../src/utils/ip";

describe("clientSource", () => {
  it.each([
    { address: "198.51.100.7", expected: "198.51.100.7" },
    { address: " 198.51.100.7 ", expected: "198.51.100.7" },
    // IPv4-mapped IPv6 (a dual-stack socket's view of an IPv4 client) is that IPv4 client.
    { address: "::ffff:198.51.100.7", expected: "198.51.100.7" },
    { address: "::FFFF:c633:6407", expected: "198.51.100.7" },
    // IPv6 clients are bucketed per /64: one subscriber usually holds a whole /64.
    { address: "2001:db8:1:2::1", expected: "2001:db8:1:2::/64" },
    { address: "2001:0DB8:0001:0002:ffff:0:0:9", expected: "2001:db8:1:2::/64" },
    { address: "2001:db8::", expected: "2001:db8:0:0::/64" },
    { address: "::1", expected: "0:0:0:0::/64" },
    { address: "fe80::1%eth0", expected: "fe80:0:0:0::/64" },
    { address: "64:ff9b::198.51.100.7", expected: "64:ff9b:0:0::/64" },
  ])("keys $address as $expected", ({ address, expected }) => {
    expect(clientSource(address)).toBe(expected);
  });

  it.each([
    "",
    "not-an-ip",
    // A proxy that appends to a client-supplied value instead of overwriting it.
    "203.0.113.9, 198.51.100.7",
    "198.51.100.7:5678",
    "[2001:db8::1]",
    "999.1.1.1",
  ])("rejects %j", (address) => {
    expect(clientSource(address)).toBeNull();
  });
});
