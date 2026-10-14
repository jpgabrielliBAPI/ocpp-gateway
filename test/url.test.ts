import { describe, expect, it } from "vitest";
import { maskUserinfo, redactUrl, redactUrlsInText } from "../src/utils/url";

describe("redactUrl", () => {
  it.each([
    [
      "leaves a URL without credentials unchanged",
      "wss://csms.example.com/ocpp/CP-001",
      "wss://csms.example.com/ocpp/CP-001",
    ],
    [
      "masks the userinfo",
      "wss://user:secret@csms.example.com/ocpp",
      "wss://***@csms.example.com/ocpp",
    ],
    [
      "masks a username alone",
      "wss://token@csms.example.com/ocpp",
      "wss://***@csms.example.com/ocpp",
    ],
    [
      "masks every query value, keeping the keys",
      "wss://csms.example.com/ocpp?token=secret&tenant=a&token=again",
      "wss://csms.example.com/ocpp?token=***&tenant=***",
    ],
    ["masks the fragment", "wss://csms.example.com/ocpp#secret", "wss://csms.example.com/ocpp#***"],
    ["does not echo an unparseable value", "not a url, secret", "<invalid url>"],
  ])("%s", (_description, input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe("maskUserinfo", () => {
  it("masks the credentials of every URL in a message", () => {
    expect(
      maskUserinfo(
        "failed mongodb://admin:s3cret@db-1.example.com:27017,db-2:27017/x and mongodb+srv://u:p@c.example.com",
      ),
    ).toBe(
      "failed mongodb://***@db-1.example.com:27017,db-2:27017/x and mongodb+srv://***@c.example.com",
    );
  });

  it("leaves a message without credentials unchanged", () => {
    expect(maskUserinfo("connect ECONNREFUSED 127.0.0.1:27017")).toBe(
      "connect ECONNREFUSED 127.0.0.1:27017",
    );
  });
});

describe("redactUrlsInText", () => {
  it("redacts every URL in a message, leaving the rest unchanged", () => {
    expect(
      redactUrlsInText(
        'cannot reach wss://user:s3cret@csms.example.com/ocpp?token=t0ken#f nor "mongodb://a:b@mongo.example.com:27017"',
      ),
    ).toBe(
      'cannot reach wss://***@csms.example.com/ocpp?token=***#*** nor "mongodb://***@mongo.example.com:27017"',
    );
  });

  it.each(['"', "'", "<", ">"])(
    "masks the whole userinfo even when the password holds a %s",
    (char) => {
      const redacted = redactUrlsInText(
        `cannot reach wss://user:pa${char}ss@csms.example.com/ocpp?token=t0ken`,
      );

      expect(redacted).not.toMatch(/pa|ss@|t0ken/);
      expect(redacted).toContain("***@csms.example.com");
    },
  );

  it.each(['"', "'", "<", ">", "`"])(
    "masks a whole query value or fragment even when it holds a %s",
    (char) => {
      const redacted = redactUrlsInText(
        `cannot reach wss://csms.example.com/ocpp?token=t0k${char}en&id=1#fr${char}ag done`,
      );

      expect(redacted).not.toMatch(/t0k|en&|fr|ag /);
      expect(redacted).toContain("wss://csms.example.com/ocpp?token=***");
      expect(redacted).toMatch(/ done$/);
    },
  );

  it.each([",", ";", ", "])("redacts each of two URLs separated by %j", (separator) => {
    const redacted = redactUrlsInText(
      `wss://host.example.com/path${separator}wss://alice:s3cret@other.example.com/path`,
    );

    expect(redacted).not.toMatch(/alice|s3cret/);
    expect(redacted).toBe(
      `wss://host.example.com/path${separator}wss://***@other.example.com/path`,
    );
  });

  it.each([
    // Split after the slash: the second URL is read with a "pathwss" scheme.
    ["/pathwss://", "wss://host.example.com/pathwss://***@other.example.com/path"],
    // No scheme can start after "1": the end of the first URL is unknown.
    ["/path?x=1wss://", "<invalid url>"],
  ])("never lets the credentials of a URL glued to another through (%s)", (glue, expected) => {
    const redacted = redactUrlsInText(
      `at wss://host.example.com${glue}alice:s3cret@other.example.com/path now`,
    );

    expect(redacted).not.toMatch(/alice|s3cret/);
    expect(redacted).toBe(`at ${expected} now`);
  });

  it.each([
    ["wss://csms.example.com/ocpp?token=!", "wss://csms.example.com/ocpp?token=***"],
    ["wss://csms.example.com/ocpp?token=s3cret).", "wss://csms.example.com/ocpp?token=***"],
    ["wss://csms.example.com/ocpp#s3cret!", "wss://csms.example.com/ocpp#***"],
  ])("masks a query value or fragment ending in punctuation (%s)", (url, expected) => {
    expect(redactUrlsInText(`see ${url}`)).toBe(`see ${expected}`);
  });

  it.each(["/", "?", "#", "\\"])(
    "masks a password holding a %s, which the URL parser would read as the host's end",
    (char) => {
      const redacted = redactUrlsInText(
        `cannot reach wss://user:123${char}s3cret@csms.example.com/ocpp now`,
      );

      expect(redacted).not.toMatch(/user|123|s3cret/);
      expect(redacted).toBe("cannot reach wss://***@csms.example.com/ocpp now");
    },
  );

  it("masks up to the last @ when one may be in a query value (fails closed)", () => {
    expect(redactUrlsInText("wss://csms.example.com/ocpp?email=a@b.example.com")).toBe(
      "wss://***@b.example.com/",
    );
  });

  it("keeps the punctuation closing a URL without query nor fragment", () => {
    expect(redactUrlsInText("see (wss://user:s3cret@csms.example.com/ocpp).")).toBe(
      "see (wss://***@csms.example.com/ocpp).",
    );
  });

  it("takes linear time, even on long runs of letters or punctuation", () => {
    const start = performance.now();
    redactUrlsInText("a".repeat(200_000));
    redactUrlsInText(`wss://csms.example.com/${"!".repeat(200_000)}x`);
    redactUrlsInText("a.".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("leaves text without URLs unchanged", () => {
    expect(redactUrlsInText("connect ECONNREFUSED 127.0.0.1:27017")).toBe(
      "connect ECONNREFUSED 127.0.0.1:27017",
    );
  });
});
