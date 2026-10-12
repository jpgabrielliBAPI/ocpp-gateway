export function parseInteger(value: string): number {
  const input = value.trim();

  if (input === "") {
    throw new TypeError("Value cannot be empty");
  }

  const result = Number(input);

  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`Invalid integer: "${value}"`);
  }

  return result;
}

export function parseIntegerInRange(value: string, minimum: number, maximum: number): number {
  const result = parseInteger(value);

  if (result < minimum || result > maximum) {
    throw new RangeError(
      `Value must be an integer between ${String(minimum)} and ${String(maximum)}: "${value}"`,
    );
  }

  return result;
}

/** The trimmed value; unset or blank means undefined. */
export function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/** An integer in [`minimum`, `maximum`]; unset or empty means `fallbackValue`. */
export function parseOptionalIntegerInRange(
  value: string | undefined,
  fallbackValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallbackValue;
  return parseIntegerInRange(value, minimum, maximum);
}

export function parsePositiveInteger(value: string): number {
  const result = parseInteger(value);

  if (result <= 0) {
    throw new RangeError(`Value must be a positive integer: "${value}"`);
  }

  return result;
}

export function parseOptionalPositiveInteger(
  value: string | undefined,
  fallbackValue?: number,
): number | undefined {
  if (value === undefined) {
    return fallbackValue;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  return parsePositiveInteger(trimmed);
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`Invalid boolean value: "${value}". Expected one of: true, false.`);
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** An optional HTTP header name, lowercased; empty means unset. */
export function parseOptionalHeaderName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const name = value.trim().toLowerCase();
  if (!HTTP_TOKEN.test(name)) throw new Error(`Invalid HTTP header name: "${value}"`);
  return name;
}

function isAllowedValue<T extends string>(value: string, allowedValues: readonly T[]): value is T {
  return allowedValues.some((allowedValue) => allowedValue === value);
}

export function parseStringUnion<const AllowedValues extends readonly string[]>(
  value: string | undefined,
  allowedValues: AllowedValues,
  fallbackValue: AllowedValues[number],
): AllowedValues[number] {
  if (value === undefined || value.trim() === "") {
    return fallbackValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!isAllowedValue(normalized, allowedValues)) {
    throw new Error(`Invalid value: "${value}". Expected one of: ${allowedValues.join(", ")}.`);
  }

  return normalized;
}

export function parseEnv<T>(envName: string, parser: (value: string | undefined) => T): T {
  try {
    return parser(process.env[envName]);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid value for environment variable ${envName}: ${error.message}`, {
        cause: error,
      });
    }

    throw new Error(`Invalid value for environment variable ${envName}.`, {
      cause: error,
    });
  }
}
