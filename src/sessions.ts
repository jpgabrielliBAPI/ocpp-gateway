import { createHash, timingSafeEqual } from "node:crypto";
import type { TenantId } from "./tenants";

/**
 * Identifies a charger session. The same chargeBoxId may live in several
 * tenants (and in the tenant-less global scope) without colliding.
 */
export interface SessionKey {
  tenantId: TenantId | null;
  chargeBoxId: string;
}

/** Collision-free string form of a key: a chargeBoxId may contain any character. */
function canonical(key: SessionKey): string {
  return JSON.stringify([key.tenantId, key.chargeBoxId]);
}

/** Human-readable form of a key, for logs: `CP-001` or `acme/CP-001`. */
export function formatSessionKey(key: SessionKey): string {
  return key.tenantId === null ? key.chargeBoxId : `${key.tenantId}/${key.chargeBoxId}`;
}

/**
 * Tracks the live charger sessions per (tenant, chargeBoxId) so a reconnecting charger
 * can replace its own stale session (some CSMS reject a second connection for
 * the same id while the old one is still open).
 *
 * The gateway does not authenticate chargers itself, so a session is only
 * replaced by a newcomer presenting the *same* `Authorization` header.
 * Otherwise anyone who knows a chargeBoxId could disconnect the real charger
 * before the CSMS gets a chance to reject the intruder's credentials. A
 * mismatched newcomer runs alongside the existing session, and the CSMS decides.
 */
export class SessionRegistry<T extends { teardown(): void }> {
  /** canonical key → (live session → the Authorization header it was opened with). */
  private readonly sessions = new Map<string, Map<T, string | undefined>>();

  /**
   * The live sessions for `key` a newcomer with `authHeader` would replace
   * (opened with the same credentials), and how many it would keep because
   * their credentials differ. Nothing is torn down.
   */
  replaceable(key: SessionKey, authHeader: string | undefined): { sessions: T[]; kept: number } {
    const sessions: T[] = [];
    let kept = 0;
    for (const [session, sessionAuth] of this.sessions.get(canonical(key)) ?? []) {
      if (sameCredentials(sessionAuth, authHeader)) sessions.push(session);
      else kept += 1;
    }
    return { sessions, kept };
  }

  /**
   * Tear down the live sessions for `key` that were opened with the same
   * credentials. Returns how many were replaced and how many were kept
   * because their credentials differ.
   */
  evict(key: SessionKey, authHeader: string | undefined): { replaced: number; kept: number } {
    // teardown() calls remove(): `replaceable` returns a snapshot.
    const { sessions, kept } = this.replaceable(key, authHeader);
    for (const session of sessions) session.teardown();
    return { replaced: sessions.length, kept };
  }

  add(key: SessionKey, authHeader: string | undefined, session: T): void {
    const id = canonical(key);
    let entries = this.sessions.get(id);
    if (!entries) {
      entries = new Map();
      this.sessions.set(id, entries);
    }
    entries.set(session, authHeader);
  }

  /** Tear down every live session (gateway shutdown). */
  teardownAll(): void {
    // teardown() calls remove(): iterate over a snapshot.
    const all = [...this.sessions.values()].flatMap((entries) => [...entries.keys()]);
    for (const session of all) session.teardown();
  }

  remove(key: SessionKey, session: T): void {
    const id = canonical(key);
    const entries = this.sessions.get(id);
    if (!entries) return;
    entries.delete(session);
    if (entries.size === 0) this.sessions.delete(id);
  }
}

/** Constant-time comparison, so response timing does not leak the stored credentials. */
function sameCredentials(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return timingSafeEqual(digest(a), digest(b));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
