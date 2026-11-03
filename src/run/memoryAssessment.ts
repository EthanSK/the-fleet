// Ethan's "leaks or sus things" is an inspection request, not kill authority.
// RSS is a point-in-time resident-memory measure; neither it nor raw swap use
// proves a leak. Keep these observations separate from admission/ownership.
import type { PreflightReport } from './preflight.ts';

export function assessMemory(report: PreflightReport) {
  const thresholdKiB = Math.max(512 * 1024, (report.memTotalBytes ?? 0) / 1024 * 0.1);
  return {
    basis: 'resident-memory-snapshot' as const,
    leakAssessment: 'not-established-by-snapshot' as const,
    swapPolicy: 'report-only' as const,
    processSampleComplete: report.processSampleComplete === true,
    highResidentThresholdKiB: thresholdKiB,
    highResidentProcesses: (report.processes ?? []).filter((process) => process.rssKiB >= thresholdKiB)
      .map((process) => ({ ...process, ownership: 'unverified' as const })),
  };
}
