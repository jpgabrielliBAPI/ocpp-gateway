import { describe, expect, it } from "vitest";
import { type SessionKey, SessionRegistry, formatSessionKey } from "../src/sessions";

class FakeSession {
  tornDown = false;
  onEnd: () => void = () => undefined;

  teardown() {
    if (this.tornDown) return;
    this.tornDown = true;
    this.onEnd();
  }
}

function key(chargeBoxId: string, tenantId: string | null = null): SessionKey {
  return { tenantId, chargeBoxId };
}

/** Register a fake session the way proxy.ts does: evict, create with onEnd, add. */
function open(
  registry: SessionRegistry<FakeSession>,
  sessionKey: SessionKey,
  auth: string | undefined,
) {
  const result = registry.evict(sessionKey, auth);
  const session = new FakeSession();
  session.onEnd = () => registry.remove(sessionKey, session);
  registry.add(sessionKey, auth, session);
  return { session, ...result };
}

describe("SessionRegistry", () => {
  it("replaces a live session opened with the same Authorization header", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");

    const second = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");

    expect(first.session.tornDown).toBe(true);
    expect(second).toMatchObject({ replaced: 1, kept: 0 });
    expect(second.session.tornDown).toBe(false);
  });

  it("replaces a live session when neither connection sends credentials", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, key("CP-001"), undefined);

    const second = open(registry, key("CP-001"), undefined);

    expect(first.session.tornDown).toBe(true);
    expect(second).toMatchObject({ replaced: 1, kept: 0 });
  });

  it.each([
    { description: "different credentials", auth: "Basic b3RoZXI6b3RoZXI=" },
    { description: "no credentials", auth: undefined },
  ])("keeps a live session when the newcomer sends $description", ({ auth }) => {
    const registry = new SessionRegistry<FakeSession>();
    const legit = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");

    const intruder = open(registry, key("CP-001"), auth);

    expect(legit.session.tornDown).toBe(false);
    expect(intruder).toMatchObject({ replaced: 0, kept: 1 });
  });

  it("does not touch sessions of other charge points", () => {
    const registry = new SessionRegistry<FakeSession>();
    const other = open(registry, key("CP-002"), "Basic dXNlcjpwYXNz");

    const result = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");

    expect(other.session.tornDown).toBe(false);
    expect(result).toMatchObject({ replaced: 0, kept: 0 });
  });

  it("still replaces the matching session when a mismatched one runs alongside", () => {
    const registry = new SessionRegistry<FakeSession>();
    const legit = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");
    const intruder = open(registry, key("CP-001"), "Basic b3RoZXI6b3RoZXI=");

    const reconnect = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");

    expect(legit.session.tornDown).toBe(true);
    expect(intruder.session.tornDown).toBe(false);
    expect(reconnect).toMatchObject({ replaced: 1, kept: 1 });
  });

  it("forgets a session once it has ended", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");
    first.session.teardown();

    const second = open(registry, key("CP-001"), "Basic dXNlcjpwYXNz");

    expect(second).toMatchObject({ replaced: 0, kept: 0 });
  });

  it("isolates the same chargeBoxId across tenants", () => {
    const registry = new SessionRegistry<FakeSession>();
    const tenantA = open(registry, key("CP-001", "tenant-a"), undefined);

    const tenantB = open(registry, key("CP-001", "tenant-b"), undefined);
    const global = open(registry, key("CP-001"), undefined);

    expect(tenantA.session.tornDown).toBe(false);
    expect(tenantB).toMatchObject({ replaced: 0, kept: 0 });
    expect(tenantB.session.tornDown).toBe(false);
    expect(global).toMatchObject({ replaced: 0, kept: 0 });
  });

  it("still replaces a reconnecting charger within its own tenant", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, key("CP-001", "tenant-a"), undefined);

    const second = open(registry, key("CP-001", "tenant-a"), undefined);

    expect(first.session.tornDown).toBe(true);
    expect(second).toMatchObject({ replaced: 1, kept: 0 });
  });

  it("does not confuse keys whose parts would collide once concatenated", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, key("b/c", "a"), undefined);

    const second = open(registry, key("a/b/c"), undefined);

    expect(first.session.tornDown).toBe(false);
    expect(second).toMatchObject({ replaced: 0, kept: 0 });
  });
});

describe("SessionRegistry.teardownAll", () => {
  it("tears down every live session, across charge points and tenants", () => {
    const registry = new SessionRegistry<FakeSession>();
    const sessions = [
      open(registry, key("CP-1"), "a").session,
      open(registry, key("CP-1"), "b").session,
      open(registry, key("CP-2"), undefined).session,
      open(registry, key("CP-1", "acme"), "a").session,
    ];

    registry.teardownAll();
    expect(sessions.every((session) => session.tornDown)).toBe(true);
    // Each session left the registry as it ended.
    expect(registry.evict(key("CP-1"), "a")).toEqual({ replaced: 0, kept: 0 });
  });
});

describe("formatSessionKey", () => {
  it("is the bare chargeBoxId without a tenant, tenant/chargeBoxId otherwise", () => {
    expect(formatSessionKey(key("CP-001"))).toBe("CP-001");
    expect(formatSessionKey(key("CP-001", "tenant-a"))).toBe("tenant-a/CP-001");
  });
});
