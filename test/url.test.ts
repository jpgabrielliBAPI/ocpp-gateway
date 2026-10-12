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

  it("leaves text without URLs unchanged", () => {
    expect(redactUrlsInText("connect ECONNREFUSED 127.0.0.1:27017")).toBe(
      "connect ECONNREFUSED 127.0.0.1:27017",
    );
  });
});
