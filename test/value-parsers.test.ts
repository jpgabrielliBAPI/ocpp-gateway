import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseBoolean,
  parseEnv,
  parseInteger,
  parseIntegerInRange,
  parseOptionalIntegerInRange,
  parsePositiveInteger,
  parseOptionalHeaderName,
  parseOptionalPositiveInteger,
  parseOptionalString,
  parseStringUnion,
} from "../src/utils/value-parsers";

describe("parseInteger", () => {
  it("parses an integer", () => {
    expect(parseInteger("42")).toBe(42);
  });

  it.each(["42px", "3.14"])('rejects invalid integer "%s"', (value) => {
    expect(() => parseInteger(value)).toThrow(`Invalid integer: "${value}"`);
  });
});

describe("parseIntegerInRange", () => {
  it.each(["1", "10"])("parses inclusive boundary %s", (value) => {
    expect(parseIntegerInRange(value, 1, 10)).toBe(Number(value));
  });

  it("throws when value is outside the range", () => {
    expect(() => parseIntegerInRange("11", 1, 10)).toThrow(
      'Value must be an integer between 1 and 10: "11"',
    );
  });
});

describe("parseOptionalIntegerInRange", () => {
  it.each([undefined, "", "  "])("returns the fallback for %j", (value) => {
    expect(parseOptionalIntegerInRange(value, 7, 1, 10)).toBe(7);
  });

  it("parses a value within the bounds", () => {
    expect(parseOptionalIntegerInRange(" 10 ", 7, 1, 10)).toBe(10);
  });

  it("rejects a value outside the bounds", () => {
    expect(() => parseOptionalIntegerInRange("11", 7, 1, 10)).toThrow(
      'Value must be an integer between 1 and 10: "11"',
    );
  });
});

describe("parseOptionalString", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    [" staging ", "staging"],
  ])("parses %j as %j", (value, expected) => {
    expect(parseOptionalString(value)).toBe(expected);
  });
});

describe("parsePositiveInteger", () => {
  it.each([
    { value: "7", expected: 7 },
    { value: "1e3", expected: 1000 },
    { value: "  13  ", expected: 13 },
  ])("parses $value as $expected", ({ value, expected }) => {
    expect(parsePositiveInteger(value)).toBe(expected);
  });

  it("throws when value is blank", () => {
    expect(() => parsePositiveInteger("   ")).toThrow("Value cannot be empty");
  });

  it.each(["0", "-8"])('rejects non-positive integer "%s"', (value) => {
    expect(() => parsePositiveInteger(value)).toThrow(
      `Value must be a positive integer: "${value}"`,
    );
  });

  it.each(["abc", "3.14"])('rejects invalid integer "%s"', (value) => {
    expect(() => parsePositiveInteger(value)).toThrow(`Invalid integer: "${value}"`);
  });
});

describe("parseOptionalPositiveInteger", () => {
  it("returns fallback when value is undefined", () => {
    expect(parseOptionalPositiveInteger(undefined, 42)).toBe(42);
    expect(parseOptionalPositiveInteger(undefined)).toBeUndefined();
  });

  it.each([
    { description: "spaces", value: "   " },
    { description: "a tab", value: "\t" },
  ])("returns undefined when value contains $description", ({ value }) => {
    expect(parseOptionalPositiveInteger(value, 42)).toBeUndefined();
  });

  it.each([
    { value: "7", expected: 7 },
    { value: "  13  ", expected: 13 },
  ])("parses valid value $value", ({ value, expected }) => {
    expect(parseOptionalPositiveInteger(value, 42)).toBe(expected);
  });

  it.each([
    {
      value: "0",
      expectedError: 'Value must be a positive integer: "0"',
    },
    { value: "abc", expectedError: 'Invalid integer: "abc"' },
  ])("rejects invalid value $value", ({ value, expectedError }) => {
    expect(() => parseOptionalPositiveInteger(value, 42)).toThrow(expectedError);
  });
});

describe("parseBoolean", () => {
  it.each([
    {
      description: "a missing value with a true default",
      value: undefined,
      defaultValue: true,
      expected: true,
    },
    {
      description: "a missing value with a false default",
      value: undefined,
      defaultValue: false,
      expected: false,
    },
    {
      description: "a blank value with a true default",
      value: "   ",
      defaultValue: true,
      expected: true,
    },
    {
      description: "a blank value with a false default",
      value: "   ",
      defaultValue: false,
      expected: false,
    },
    {
      description: "true",
      value: "true",
      defaultValue: false,
      expected: true,
    },
    {
      description: "false",
      value: "false",
      defaultValue: true,
      expected: false,
    },
    {
      description: "true with whitespace and uppercase letters",
      value: "  TRUE ",
      defaultValue: false,
      expected: true,
    },
    {
      description: "false with whitespace and mixed-case letters",
      value: "  fAlSe ",
      defaultValue: true,
      expected: false,
    },
  ])("parses $description", ({ value, defaultValue, expected }) => {
    expect(parseBoolean(value, defaultValue)).toBe(expected);
  });

  it("throws when value is invalid", () => {
    expect(() => parseBoolean("yes", false)).toThrow(
      'Invalid boolean value: "yes". Expected one of: true, false.',
    );
  });
});

describe("parseStringUnion", () => {
  const values = ["first", "second"] as const;

  it.each([
    {
      description: "missing",
      value: undefined,
      fallback: "first",
    },
    {
      description: "blank",
      value: "   ",
      fallback: "second",
    },
  ] as const)("returns the fallback for a $description value", ({ value, fallback }) => {
    expect(parseStringUnion(value, values, fallback)).toBe(fallback);
  });

  it("normalizes and parses an allowed value", () => {
    expect(parseStringUnion(" SECOND ", values, "first")).toBe("second");
  });

  it("throws for a value outside the union", () => {
    expect(() => parseStringUnion("third", values, "first")).toThrow(
      'Invalid value: "third". Expected one of: first, second.',
    );
  });
});

describe("parseOptionalHeaderName", () => {
  it.each([undefined, "", "   "])("treats %j as unset", (value) => {
    expect(parseOptionalHeaderName(value)).toBeUndefined();
  });

  it("trims and lowercases a header name", () => {
    expect(parseOptionalHeaderName(" X-Forwarded-Host ")).toBe("x-forwarded-host");
  });

  it.each(["X Forwarded Host", "x-host:", "x-höst"])("rejects %j", (value) => {
    expect(() => parseOptionalHeaderName(value)).toThrow(`Invalid HTTP header name: "${value}"`);
  });
});

describe("parseEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads and parses an environment variable", () => {
    vi.stubEnv("TEST_VALUE_PARSER", "true");

    expect(parseEnv("TEST_VALUE_PARSER", (value) => parseBoolean(value, false))).toBe(true);
  });

  it("wraps parser errors with the environment variable name", () => {
    vi.stubEnv("TEST_VALUE_PARSER", "abc");

    expect(() =>
      parseEnv("TEST_VALUE_PARSER", (value) => parseOptionalPositiveInteger(value, 10)),
    ).toThrow('Invalid value for environment variable TEST_VALUE_PARSER: Invalid integer: "abc"');
  });
});
