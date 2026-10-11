import { readFileSync } from "node:fs";
import { type FSWatcher, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createLogger } from "./logger";
import { type TenantId, isTenantId, parseHostname } from "./tenants";
import { isPlainObject } from "./utils/objects";
import { redactUrl } from "./utils/url";

const log = createLogger("routes");

/**
 * One upstream CSMS endpoint. By default the chargeBoxId is appended to `url`
 * as a path segment when a charger connects (see {@link buildTargetUrl}); set
 * `appendChargeBoxId: false` for backends that expose a fixed endpoint URL.
 */
export interface Backend {
  /**
   * Stable name of the logical CSMS (not of a connection), used by trace
   * archiving instead of the URL, which may carry credentials.
   */
  id?: string;
  url: string;
  appendChargeBoxId: boolean;
}

export interface RouteTableOptions {
  /** Every backend must have an `id` (trace archiving needs one per CSMS). */
  requireBackendIds?: boolean;
}

const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A single routing target: one bidirectional primary CSMS and zero or more
 * read-only secondary mirrors. Different backends may use entirely different
 * base paths.
 */
export interface Route {
  primary: Backend;
  secondaries: Backend[];
}

/**
 * One routing scope: an optional `default` route plus exact-match overrides
 * keyed by chargeBoxId. Maps, so no id can collide with `Object.prototype`.
 */
export interface RouteScope {
  default?: Route;
  chargers: Map<string, Route>;
}

/**
 * The full routing table. Its own `default`/`chargers` form the global scope,
 * serving connections that resolve no tenant (the single-tenant setup);
 * `tenants` holds one scope per tenant, and `hostnames` maps each explicit
 * hostname (custom domain) to the tenant that claims it. Resolution never
 * falls back from one scope to another.
 */
export interface RouteTable extends RouteScope {
  tenants: Map<TenantId, RouteScope>;
  hostnames: Map<string, TenantId>;
}

const DIALABLE_PROTOCOLS = new Set(["ws:", "wss:", "http:", "https:"]);

function parseUrl(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must have a non-empty string url`);
  }
  const url = URL.parse(value);
  if (!url) {
    throw new Error(`${where} url is not a valid URL`);
  }
  // Early feedback only: connection setup also survives URLs ws refuses to dial.
  if (!DIALABLE_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${where} url "${redactUrl(value)}" must use ws:, wss:, http: or https:`);
  }
  return value;
}

/** Accept either a bare URL string or `{ id?, url, appendChargeBoxId? }`. */
function parseBackend(value: unknown, where: string, options: RouteTableOptions): Backend {
  const missingId = () =>
    new Error(`${where} must have an "id" (required when trace archiving is enabled)`);
  if (typeof value === "string") {
    if (options.requireBackendIds) throw missingId();
    return { url: parseUrl(value, where), appendChargeBoxId: true };
  }
  if (!isPlainObject(value)) {
    throw new Error(`${where} must be a URL string or an object with a "url"`);
  }

  const append = value.appendChargeBoxId ?? true;
  if (typeof append !== "boolean") {
    throw new Error(`${where} "appendChargeBoxId" must be a boolean`);
  }

  const { id } = value;
  if (id === undefined) {
    if (options.requireBackendIds) throw missingId();
  } else if (typeof id !== "string" || !BACKEND_ID.test(id)) {
    throw new Error(
      `${where} "id" must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  }

  return {
    ...(id !== undefined && { id }),
    url: parseUrl(value.url, where),
    appendChargeBoxId: append,
  };
}

function parseRoute(value: unknown, where: string, options: RouteTableOptions): Route {
  if (!isPlainObject(value)) {
    throw new Error(`route "${where}" must be an object`);
  }

  if (value.primary === undefined) {
    throw new Error(`route "${where}" must define a "primary"`);
  }
  const primary = parseBackend(value.primary, `route "${where}" primary`, options);

  let secondaries: Backend[] = [];
  if (value.secondaries !== undefined) {
    if (!Array.isArray(value.secondaries)) {
      throw new Error(`route "${where}" "secondaries" must be an array`);
    }
    secondaries = value.secondaries.map((s, i) =>
      parseBackend(s, `route "${where}" secondary #${i}`, options),
    );
  }

  // Trace deliveries are keyed by backend id: it must be unambiguous in a route.
  const ids = new Set<string>();
  for (const { id } of [primary, ...secondaries]) {
    if (id === undefined) continue;
    if (ids.has(id)) throw new Error(`backend id "${id}" is used twice in route "${where}"`);
    ids.add(id);
  }

  return { primary, secondaries };
}

/**
 * Within a scope, a backend id names one logical CSMS: always the same server
 * (scheme, host and port). Paths, queries and credentials may differ, e.g.
 * per-charger endpoints with `appendChargeBoxId: false`.
 */
function checkBackendIds(scope: RouteScope, label: string): void {
  const servers = new Map<string, string>();
  const routes = [...(scope.default ? [scope.default] : []), ...scope.chargers.values()];
  for (const route of routes) {
    for (const { id, url } of [route.primary, ...route.secondaries]) {
      if (id === undefined) continue;
      const server = new URL(url).origin;
      const known = servers.get(id);
      if (known !== undefined && known !== server) {
        throw new Error(`backend id "${id}" names different servers in ${label}`);
      }
      servers.set(id, server);
    }
  }
}

/** Parse the `default` and `chargers` of a scope found at `path` ("" for the root). */
function parseScope(
  value: Record<string, unknown>,
  path: string,
  options: RouteTableOptions,
): RouteScope {
  const chargersPath = `${path}chargers`;
  const scope: RouteScope = { chargers: new Map() };
  if (value.chargers !== undefined) {
    if (!isPlainObject(value.chargers)) {
      throw new Error(`"${chargersPath}" must be an object keyed by chargeBoxId`);
    }
    for (const [id, route] of Object.entries(value.chargers)) {
      scope.chargers.set(id, parseRoute(route, `${chargersPath}.${id}`, options));
    }
  }
  if (value.default !== undefined) {
    scope.default = parseRoute(value.default, `${path}default`, options);
  }
  return scope;
}

function parseHostnames(value: unknown, tenantId: string): string[] {
  if (value === undefined) return [];
  const where = `tenant "${tenantId}" "hostnames"`;
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array of hostnames`);
  }
  return value.map((entry) => {
    const hostname = typeof entry === "string" ? parseHostname(entry) : null;
    if (hostname === null) {
      throw new Error(`${where} entry ${JSON.stringify(entry)} is not a valid hostname`);
    }
    return hostname;
  });
}

function parseTenants(value: unknown, table: RouteTable, options: RouteTableOptions): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error('"tenants" must be an object keyed by tenant id');
  }

  for (const [tenantId, tenant] of Object.entries(value)) {
    if (!isTenantId(tenantId)) {
      throw new Error(
        `tenant id ${JSON.stringify(tenantId)} must be a lowercase DNS label (a-z, 0-9, "-")`,
      );
    }
    if (!isPlainObject(tenant)) {
      throw new Error(`tenant "${tenantId}" must be an object`);
    }
    const scope = parseScope(tenant, `tenants.${tenantId}.`, options);
    checkBackendIds(scope, `tenant "${tenantId}"`);
    if (!scope.default && scope.chargers.size === 0) {
      throw new Error(`tenant "${tenantId}" must define a "default" route or at least one charger`);
    }
    table.tenants.set(tenantId, scope);

    for (const hostname of parseHostnames(tenant.hostnames, tenantId)) {
      const owner = table.hostnames.get(hostname);
      if (owner !== undefined && owner !== tenantId) {
        throw new Error(
          `hostname "${hostname}" is claimed by tenants "${owner}" and "${tenantId}"`,
        );
      }
      table.hostnames.set(hostname, tenantId);
    }
  }
}

/**
 * Validate and normalise an arbitrary parsed-JSON value into a RouteTable.
 * Throws with a descriptive message on any structural problem (fail-fast).
 */
export function parseRouteTable(value: unknown, options: RouteTableOptions = {}): RouteTable {
  if (!isPlainObject(value)) {
    throw new Error("routes file must be a JSON object");
  }

  const table: RouteTable = {
    ...parseScope(value, "", options),
    tenants: new Map(),
    hostnames: new Map(),
  };
  checkBackendIds(table, "the global routes");
  parseTenants(value.tenants, table, options);
  if (!table.default && table.tenants.size === 0) {
    throw new Error('routes file must define a "default" route or at least one tenant');
  }
  return table;
}

/**
 * Resolve the route for a charger. Without a tenant (`null`), the global
 * scope applies; with one, only that tenant's scope does. In both, an exact
 * match in `chargers` wins, otherwise the scope's `default` is used.
 * Returns `null` when the tenant is unknown or the scope has no match.
 */
export function resolveRoute(
  table: RouteTable,
  tenantId: TenantId | null,
  chargeBoxId: string,
): Route | null {
  const scope = tenantId === null ? table : table.tenants.get(tenantId);
  if (!scope) return null;
  return scope.chargers.get(chargeBoxId) ?? scope.default ?? null;
}

/**
 * Build the final upstream URL for a charger. Unless the backend opts out via
 * `appendChargeBoxId: false`, the (url-encoded) chargeBoxId is appended as a
 * path segment, trailing slashes are collapsed, and query parameters are kept.
 */
export function buildTargetUrl(backend: Backend, chargeBoxId: string): string {
  if (!backend.appendChargeBoxId) return backend.url;

  const url = new URL(backend.url);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${encodeURIComponent(chargeBoxId)}`;
  return url.toString();
}

/**
 * Loads a RouteTable from disk and validates it. Throws (fail-fast) if the
 * file is missing or invalid.
 */
export function loadRouteTable(path: string, options: RouteTableOptions = {}): RouteTable {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read routes file "${path}": ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`routes file "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  return parseRouteTable(json, options);
}

/**
 * Holds the active RouteTable and, optionally, watches the routes file so it
 * can be reloaded at runtime. A reload that fails validation is logged and
 * ignored — the previously-valid table stays in effect, and existing charger
 * sessions are never disturbed (each captures its route at connect time).
 */
export class RouteStore {
  private table: RouteTable;
  private watcher: FSWatcher | null = null;
  private readonly path: string;
  private readonly options: RouteTableOptions;

  private constructor(path: string, table: RouteTable, options: RouteTableOptions) {
    this.path = path;
    this.table = table;
    this.options = options;
  }

  /** Whether every backend of every table this store holds has an `id`. */
  get requiresBackendIds(): boolean {
    return this.options.requireBackendIds === true;
  }

  /** Load and validate the routes file (fail-fast on error); reloads apply the same options. */
  static load(path: string, options: RouteTableOptions = {}): RouteStore {
    const absolute = resolvePath(path);
    return new RouteStore(absolute, loadRouteTable(absolute, options), options);
  }

  resolve(tenantId: TenantId | null, chargeBoxId: string): Route | null {
    return resolveRoute(this.table, tenantId, chargeBoxId);
  }

  /** The tenant that explicitly claims `hostname` (a custom domain), if any. */
  findTenantByHostname(hostname: string): TenantId | null {
    return this.table.hostnames.get(hostname) ?? null;
  }

  /** Re-read the routes file; keep the current table if the new one is invalid. */
  reload(): void {
    try {
      this.table = loadRouteTable(this.path, this.options);
      log.info("routes reloaded", {
        path: this.path,
        chargers: this.table.chargers.size,
        tenants: this.table.tenants.size,
      });
    } catch (err) {
      log.error("routes reload failed, keeping previous table", {
        path: this.path,
        error: (err as Error).message,
      });
    }
  }

  /** Start watching the routes file for changes and hot-reload on write. */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        this.reload();
      });
      log.info("watching routes file for changes", { path: this.path });
    } catch (err) {
      log.warn("could not watch routes file; hot reload disabled", {
        path: this.path,
        error: (err as Error).message,
      });
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
