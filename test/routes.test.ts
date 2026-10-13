import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RouteStore,
  buildTargetUrl,
  isTraced,
  loadRouteTable,
  parseRouteTable,
  resolveRoute,
  untracedScopes,
} from "../src/routes";

const TABLE = {
  default: {
    primary: "wss://csms.example.com/ocpp",
    secondaries: [],
  },
  chargers: {
    "CP-001": {
      primary: "wss://primary-csms.example.com/ocpp",
      secondaries: ["wss://csms.example.com/ocpp"],
    },
  },
};

describe("parseRouteTable", () => {
  it("accepts a well-formed table", () => {
    const t = parseRouteTable(TABLE);
    expect(t.default.primary.url).toBe(TABLE.default.primary);
    expect(t.chargers.get("CP-001")?.secondaries).toHaveLength(1);
  });

  it("normalises string backends to { url, appendChargeBoxId: true }", () => {
    const t = parseRouteTable(TABLE);
    expect(t.chargers.get("CP-001")?.primary).toEqual({
      url: "wss://primary-csms.example.com/ocpp",
      appendChargeBoxId: true,
    });
    expect(t.chargers.get("CP-001")?.secondaries).toEqual([
      { url: "wss://csms.example.com/ocpp", appendChargeBoxId: true },
    ]);
  });

  it("accepts object backends with an explicit appendChargeBoxId", () => {
    const t = parseRouteTable({
      default: {
        primary: { url: "wss://fixed-csms.example.com/XXXXXXXX", appendChargeBoxId: false },
        secondaries: ["wss://a.example.com/ocpp", { url: "wss://b.example.com/ocpp" }],
      },
    });
    expect(t.default.primary).toEqual({
      url: "wss://fixed-csms.example.com/XXXXXXXX",
      appendChargeBoxId: false,
    });
    expect(t.default.secondaries).toEqual([
      { url: "wss://a.example.com/ocpp", appendChargeBoxId: true },
      { url: "wss://b.example.com/ocpp", appendChargeBoxId: true },
    ]);
  });

  it("rejects an object backend without a url", () => {
    expect(() => parseRouteTable({ default: { primary: { appendChargeBoxId: true } } })).toThrow(
      /url/,
    );
  });

  it("rejects a backend url that cannot be parsed", () => {
    expect(() => parseRouteTable({ default: { primary: "not a url" } })).toThrow(/valid URL/);
  });

  it.each(["htps://csms.example.com/ocpp", "mailto:ops@example.com"])(
    "rejects a backend url with a scheme ws cannot dial (%s)",
    (url) => {
      // ws throws synchronously on these at connect time, which would crash the gateway.
      expect(() =>
        parseRouteTable({ default: { primary: "ws://x/y", secondaries: [url] } }),
      ).toThrow(/ws:, wss:, http: or https:/);
    },
  );

  it.each(["ws://x/y", "wss://x/y", "http://x/y", "https://x/y"])(
    "accepts a backend url with a dialable scheme (%s)",
    (url) => {
      expect(parseRouteTable({ default: { primary: url } }).default.primary.url).toBe(url);
    },
  );

  it("rejects a non-boolean appendChargeBoxId", () => {
    expect(() =>
      parseRouteTable({ default: { primary: { url: "ws://x/y", appendChargeBoxId: "no" } } }),
    ).toThrow(/appendChargeBoxId/);
  });

  it("defaults missing secondaries to an empty array", () => {
    const t = parseRouteTable({ default: { primary: "ws://x/y" } });
    expect(t.default.secondaries).toEqual([]);
    expect(t.chargers.size).toBe(0);
  });

  it("rejects a table without a default route", () => {
    expect(() => parseRouteTable({ chargers: {} })).toThrow();
  });

  it("rejects a default route without a primary", () => {
    expect(() => parseRouteTable({ default: { secondaries: [] } })).toThrow();
  });

  it("rejects a charger route without a primary", () => {
    expect(() =>
      parseRouteTable({
        default: { primary: "ws://x/y" },
        chargers: { A: { secondaries: [] } },
      }),
    ).toThrow();
  });

  it("rejects non-string secondaries", () => {
    expect(() =>
      parseRouteTable({ default: { primary: "ws://x/y", secondaries: [42] } }),
    ).toThrow();
  });

  it("rejects a non-object root", () => {
    expect(() => parseRouteTable(null)).toThrow();
    expect(() => parseRouteTable("nope")).toThrow();
  });
});

describe("resolveRoute", () => {
  const table = parseRouteTable(TABLE);

  it("returns the charger-specific route when the id matches", () => {
    const r = resolveRoute(table, null, "CP-001");
    expect(r?.primary.url).toBe("wss://primary-csms.example.com/ocpp");
    expect(r?.secondaries.map((b) => b.url)).toEqual(["wss://csms.example.com/ocpp"]);
  });

  it("falls back to the default route for an unknown id", () => {
    const r = resolveRoute(table, null, "SIMULATOR-001");
    expect(r?.primary.url).toBe("wss://csms.example.com/ocpp");
    expect(r?.secondaries).toEqual([]);
  });

  it("matches charger ids exactly (case-sensitive)", () => {
    expect(resolveRoute(table, null, "cp-001")?.primary).toBe(table.default?.primary);
  });

  it("keeps a charger route whose id is an Object.prototype key", () => {
    const t = parseRouteTable(
      JSON.parse(
        '{"default":{"primary":"ws://x/d"},"chargers":{"__proto__":{"primary":"ws://x/p"}}}',
      ),
    );
    expect(resolveRoute(t, null, "__proto__")?.primary.url).toBe("ws://x/p");
  });

  it.each(["constructor", "__proto__", "toString"])(
    "does not resolve inherited object properties as charger ids (%s)",
    (id) => {
      expect(resolveRoute(table, null, id)).toBe(table.default);
    },
  );
});

const TENANT_TABLE = {
  default: { primary: "wss://csms.example.com/ocpp" },
  tenants: {
    "tenant-a": {
      default: { primary: "wss://csms-a.example.com/ocpp" },
      chargers: { "CP-001": { primary: "wss://csms-a.example.com/special" } },
    },
    "tenant-b": {
      hostnames: ["OCPP.Customer-B.example"],
      chargers: { "CP-001": { primary: "wss://csms-b.example.com/ocpp" } },
    },
  },
};

describe("parseRouteTable with tenants", () => {
  it("parses per-tenant routes and normalises their hostnames", () => {
    const t = parseRouteTable(TENANT_TABLE);
    expect(t.tenants.get("tenant-a")?.default?.primary.url).toBe("wss://csms-a.example.com/ocpp");
    expect(t.tenants.get("tenant-b")?.default).toBeUndefined();
    expect([...t.hostnames]).toEqual([["ocpp.customer-b.example", "tenant-b"]]);
  });

  it("defaults to no tenants for a legacy table", () => {
    expect(parseRouteTable(TABLE).tenants.size).toBe(0);
  });

  it("accepts a table with tenants only (no global default route)", () => {
    const t = parseRouteTable({ tenants: TENANT_TABLE.tenants });
    expect(t.default).toBeUndefined();
  });

  it("rejects a table with neither a default route nor a tenant", () => {
    expect(() => parseRouteTable({ tenants: {} })).toThrow(/"default" route or at least one/);
  });

  it.each(["Tenant-A", "tenant_a", "-a", "a.b", ""])("rejects tenant id %j", (id) => {
    expect(() =>
      parseRouteTable({ tenants: { [id]: { default: { primary: "ws://x/y" } } } }),
    ).toThrow(/tenant id/);
  });

  it("rejects a tenant without any route", () => {
    expect(() => parseRouteTable({ tenants: { acme: { hostnames: [] } } })).toThrow(
      /tenant "acme" must define a "default" route or at least one charger/,
    );
  });

  it.each([
    ["a non-array", "ocpp.acme.example"],
    ["a malformed hostname", ["ac_me.example"]],
    ["a hostname with a port", ["ocpp.acme.example:443"]],
  ])("rejects %s for hostnames", (_description, hostnames) => {
    expect(() =>
      parseRouteTable({ tenants: { acme: { hostnames, default: { primary: "ws://x/y" } } } }),
    ).toThrow(/hostnames/);
  });

  it("rejects a hostname claimed by two tenants", () => {
    expect(() =>
      parseRouteTable({
        tenants: {
          acme: { hostnames: ["ocpp.shared.example"], default: { primary: "ws://x/y" } },
          globex: { hostnames: ["OCPP.shared.example"], default: { primary: "ws://x/y" } },
        },
      }),
    ).toThrow(/"ocpp.shared.example" is claimed by tenants "acme" and "globex"/);
  });
});

describe("resolveRoute with tenants", () => {
  const table = parseRouteTable(TENANT_TABLE);

  it("routes the same chargeBoxId to a different CSMS per tenant", () => {
    expect(resolveRoute(table, "tenant-a", "CP-001")?.primary.url).toBe(
      "wss://csms-a.example.com/special",
    );
    expect(resolveRoute(table, "tenant-b", "CP-001")?.primary.url).toBe(
      "wss://csms-b.example.com/ocpp",
    );
  });

  it("falls back to the tenant's own default route", () => {
    expect(resolveRoute(table, "tenant-a", "CP-999")?.primary.url).toBe(
      "wss://csms-a.example.com/ocpp",
    );
  });

  it("never falls back to the global routes for a tenant", () => {
    expect(resolveRoute(table, "tenant-b", "CP-999")).toBeNull();
  });

  it("resolves nothing for an unknown tenant", () => {
    expect(resolveRoute(table, "tenant-c", "CP-001")).toBeNull();
    expect(resolveRoute(table, "constructor", "CP-001")).toBeNull();
  });

  it("uses the global routes when no tenant was resolved", () => {
    expect(resolveRoute(table, null, "CP-001")?.primary.url).toBe("wss://csms.example.com/ocpp");
  });

  it("resolves nothing without a tenant when there is no global default", () => {
    const tenantsOnly = parseRouteTable({ tenants: TENANT_TABLE.tenants });
    expect(resolveRoute(tenantsOnly, null, "CP-001")).toBeNull();
  });
});

describe("buildTargetUrl", () => {
  const backend = (url: string, appendChargeBoxId = true) => ({ url, appendChargeBoxId });

  it.each([
    {
      description: "appends the chargeBoxId as a path segment",
      url: "wss://csms.example.com/ws",
      expected: "wss://csms.example.com/ws/CP-001",
    },
    {
      description: "trims a single trailing slash on the base url",
      url: "wss://csms.example.com/ws/",
      expected: "wss://csms.example.com/ws/CP-001",
    },
    {
      description: "trims repeated trailing slashes on the base url",
      url: "wss://csms.example.com/ws///",
      expected: "wss://csms.example.com/ws/CP-001",
    },
    {
      description: "preserves query parameters",
      url: "wss://csms.example.com/endpoint?tenant=emea",
      expected: "wss://csms.example.com/endpoint/CP-001?tenant=emea",
    },
    {
      description: "appends to a bare host",
      url: "wss://csms.example.com",
      expected: "wss://csms.example.com/CP-001",
    },
  ])("$description", ({ url, expected }) => {
    expect(buildTargetUrl(backend(url), "CP-001")).toBe(expected);
  });

  it("url-encodes ids containing reserved characters", () => {
    expect(buildTargetUrl(backend("ws://csms/ocpp"), "CP 01/ä")).toBe(
      "ws://csms/ocpp/CP%2001%2F%C3%A4",
    );
  });

  it("returns the url unchanged when appendChargeBoxId is false", () => {
    expect(
      buildTargetUrl(backend("wss://fixed-csms.example.com/XXXXXXXX?tenant=emea", false), "CP-001"),
    ).toBe("wss://fixed-csms.example.com/XXXXXXXX?tenant=emea");
  });
});

describe("backend ids", () => {
  const withIds = {
    default: {
      primary: { id: "csms-main", url: "wss://csms.example.com/ocpp" },
      secondaries: [{ id: "mirror", url: "wss://mirror.example.com/ocpp" }],
    },
  };

  it("keeps an explicit backend id", () => {
    const t = parseRouteTable(withIds);
    expect(t.default?.primary).toEqual({
      id: "csms-main",
      url: "wss://csms.example.com/ocpp",
      appendChargeBoxId: true,
    });
    expect(t.default?.secondaries[0].id).toBe("mirror");
  });

  it("leaves the id out when none is given", () => {
    expect(parseRouteTable(TABLE).default?.primary).not.toHaveProperty("id");
  });

  it.each([["", "has space", "a/b", "-leading-dash", "x".repeat(65), 42]].flat())(
    "rejects the id %j",
    (id) => {
      expect(() =>
        parseRouteTable({ default: { primary: { id, url: "wss://csms.example.com/ocpp" } } }),
      ).toThrow(/route "default" primary "id"/);
    },
  );

  it("accepts ids made of letters, digits, '.', '_' and '-'", () => {
    const id = `A1.b_c-${"x".repeat(57)}`;
    expect(
      parseRouteTable({ default: { primary: { id, url: "wss://csms.example.com/ocpp" } } }).default
        ?.primary.id,
    ).toBe(id);
  });

  it("rejects an id used twice in the same route", () => {
    expect(() =>
      parseRouteTable({
        default: {
          primary: { id: "csms", url: "wss://a.example.com/ocpp" },
          secondaries: [{ id: "csms", url: "wss://b.example.com/ocpp" }],
        },
      }),
    ).toThrow(/backend id "csms" is used twice in route "default"/);
  });

  it("rejects an id naming two different URLs within a scope", () => {
    expect(() =>
      parseRouteTable({
        default: { primary: { id: "csms", url: "wss://a.example.com/ocpp" } },
        chargers: { "CP-1": { primary: { id: "csms", url: "wss://b.example.com/ocpp" } } },
      }),
    ).toThrow(/backend id "csms" names different servers/);
    expect(() =>
      parseRouteTable({
        tenants: {
          acme: {
            default: { primary: { id: "csms", url: "wss://a.example.com/ocpp" } },
            chargers: {
              "CP-1": {
                primary: { id: "other", url: "wss://c.example.com/ocpp" },
                secondaries: [{ id: "csms", url: "wss://b.example.com/ocpp" }],
              },
            },
          },
        },
      }),
    ).toThrow(/backend id "csms" names different servers in tenant "acme"/);
  });

  it("does not leak backend URLs in id errors", () => {
    expect(() =>
      parseRouteTable({
        default: { primary: { id: "csms", url: "wss://user:secret@a.example.com/ocpp" } },
        chargers: { "CP-1": { primary: { id: "csms", url: "wss://b.example.com/ocpp" } } },
      }),
    ).toThrow(/^(?!.*secret).*$/);
  });

  it("lets one CSMS id name per-charger endpoints of the same server", () => {
    const t = parseRouteTable({
      default: { primary: { id: "csms", url: "wss://csms.example.com/ocpp" } },
      chargers: {
        "CP-1": {
          primary: { id: "csms", url: "wss://csms.example.com/ep/AAAA", appendChargeBoxId: false },
        },
        "CP-2": {
          primary: {
            id: "csms",
            url: "wss://user:token@csms.example.com/ep/BBBB?key=1",
            appendChargeBoxId: false,
          },
        },
      },
    });
    expect(t.chargers.get("CP-2")?.primary.id).toBe("csms");
  });

  it("rejects an id naming another server, even on another port or scheme", () => {
    for (const url of [
      "wss://other.example.com/ocpp",
      "wss://csms.example.com:8443/ocpp",
      "ws://csms.example.com/ocpp",
    ]) {
      expect(() =>
        parseRouteTable({
          default: { primary: { id: "csms", url: "wss://csms.example.com/ocpp" } },
          chargers: { "CP-1": { primary: { id: "csms", url } } },
        }),
      ).toThrow(/backend id "csms" names different servers in the global routes/);
    }
  });

  it("lets routes of a scope share an id for the same URL", () => {
    const t = parseRouteTable({
      default: { primary: { id: "csms", url: "wss://a.example.com/ocpp" } },
      chargers: {
        "CP-1": {
          primary: { id: "other", url: "wss://b.example.com/ocpp" },
          secondaries: [{ id: "csms", url: "wss://a.example.com/ocpp" }],
        },
      },
    });
    expect(t.chargers.get("CP-1")?.secondaries[0].id).toBe("csms");
  });

  it("scopes ids per tenant", () => {
    expect(() =>
      parseRouteTable({
        default: { primary: { id: "csms", url: "wss://a.example.com/ocpp" } },
        tenants: {
          acme: { default: { primary: { id: "csms", url: "wss://acme.example.com/ocpp" } } },
          beta: { default: { primary: { id: "csms", url: "wss://beta.example.com/ocpp" } } },
        },
      }),
    ).not.toThrow();
  });

  describe("when required", () => {
    const options = { requireBackendIds: true };

    it("accepts a table where every backend has an id", () => {
      expect(() => parseRouteTable(withIds, options)).not.toThrow();
    });

    it("rejects a URL-string backend", () => {
      expect(() =>
        parseRouteTable(
          {
            default: {
              primary: { id: "a", url: "wss://a.example.com" },
              secondaries: ["wss://b.example.com"],
            },
          },
          options,
        ),
      ).toThrow(
        /route "default" secondary #0 must have an "id" \(required when trace archiving is enabled\)/,
      );
    });

    it("rejects an object backend without id, in a tenant too", () => {
      expect(() =>
        parseRouteTable(
          {
            tenants: {
              acme: { chargers: { "CP-1": { primary: { url: "wss://a.example.com" } } } },
            },
          },
          options,
        ),
      ).toThrow(/route "tenants.acme.chargers.CP-1" primary must have an "id"/);
    });
  });
});

describe("RouteStore with required backend ids", () => {
  function writeRoutes(dir: string, table: object): string {
    const path = join(dir, "routes.json");
    writeFileSync(path, JSON.stringify(table));
    return path;
  }

  it("refuses to load a table without backend ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-routes-"));
    try {
      const path = writeRoutes(dir, TABLE);
      expect(() => RouteStore.load(path, { requireBackendIds: true })).toThrow(/must have an "id"/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("keeps the previous table when a reload drops the ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-routes-"));
    try {
      const path = writeRoutes(dir, {
        default: { primary: { id: "csms", url: "wss://a.example.com/ocpp" } },
      });
      const store = RouteStore.load(path, { requireBackendIds: true });
      writeRoutes(dir, { default: { primary: "wss://b.example.com/ocpp" } });
      store.reload();
      expect(store.resolve(null, "CP-1")?.primary).toEqual({
        id: "csms",
        url: "wss://a.example.com/ocpp",
        appendChargeBoxId: true,
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("trace selection per scope", () => {
  const scoped = (root: object = {}, demo: object = {}) => ({
    default: { primary: "wss://csms.example.com/ocpp" },
    ...root,
    tenants: {
      "tenant-a": { default: { primary: "wss://csms-a.example.com/ocpp" } },
      demo: { default: { primary: "wss://demo.example.com/ocpp" }, ...demo },
    },
  });

  it("traces every scope by default", () => {
    const table = parseRouteTable(scoped());
    expect(isTraced(table, null)).toBe(true);
    expect(isTraced(table, "tenant-a")).toBe(true);
    expect(isTraced(table, "demo")).toBe(true);
    expect(untracedScopes(table)).toEqual([]);
  });

  it("excludes only the tenant with trace: false", () => {
    const table = parseRouteTable(scoped({}, { trace: false }));
    expect(isTraced(table, "demo")).toBe(false);
    expect(isTraced(table, "tenant-a")).toBe(true);
    expect(isTraced(table, null)).toBe(true);
    expect(untracedScopes(table)).toEqual(["demo"]);
  });

  it("applies a root trace: false to the global scope only, never to tenants", () => {
    const table = parseRouteTable(scoped({ trace: false }));
    expect(isTraced(table, null)).toBe(false);
    expect(isTraced(table, "tenant-a")).toBe(true);
    expect(isTraced(table, "demo")).toBe(true);
    expect(untracedScopes(table)).toEqual([null]);
  });

  it("accepts an explicit trace: true", () => {
    const table = parseRouteTable(scoped({ trace: true }, { trace: true }));
    expect(untracedScopes(table)).toEqual([]);
  });

  it.each([["false"], [0], [null]])("rejects a non-boolean trace (%j)", (value) => {
    expect(() => parseRouteTable(scoped({ trace: value }))).toThrow(/"trace" must be a boolean/);
    expect(() => parseRouteTable(scoped({}, { trace: value }))).toThrow(
      /"tenants.demo.trace" must be a boolean/,
    );
  });

  describe("RouteStore", () => {
    it("follows a reload, and keeps the previous selection when the reload is invalid", () => {
      const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-routes-"));
      try {
        const path = join(dir, "routes.json");
        writeFileSync(path, JSON.stringify(scoped()));
        const store = RouteStore.load(path);
        expect(store.isTraced("demo")).toBe(true);

        writeFileSync(path, JSON.stringify(scoped({}, { trace: false })));
        store.reload();
        expect(store.isTraced("demo")).toBe(false);
        expect(store.untracedScopes()).toEqual(["demo"]);

        writeFileSync(path, JSON.stringify(scoped({}, { trace: "yes" })));
        store.reload();
        expect(store.isTraced("demo")).toBe(false);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});

describe("committed examples", () => {
  it.each(["routes.example.json", "routes.multi-tenant.example.json"])(
    "%s is a valid routing table, ready for trace archiving",
    (file) => {
      expect(() =>
        loadRouteTable(join(__dirname, "..", file), { requireBackendIds: true }),
      ).not.toThrow();
    },
  );
});
