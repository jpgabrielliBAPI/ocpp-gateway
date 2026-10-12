import type { ErrorReport } from "../src/error-reporter";
import { configureLogger } from "../src/logger";

/**
 * Silence the logger and collect what it reports, until the next
 * `configureLogger` (`test/setup.ts` resets it before each test).
 */
export function captureReports(): ErrorReport[] {
  const reports: ErrorReport[] = [];
  configureLogger({
    sink: { stdout: () => undefined, stderr: () => undefined },
    reporter: { report: (report) => reports.push(report) },
  });
  return reports;
}
