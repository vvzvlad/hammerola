/**
 * Temporary parse timing for JTYU-OBC benchmarks.
 * Enabled when the worker sets globalThis.__ECAD_PERF_LOG__ = true.
 */
export function isEcadPerfLogEnabled(): boolean {
    try {
        return !!(globalThis as any).__ECAD_PERF_LOG__;
    } catch {
        return false;
    }
}

export function ecadPerfLog(...args: unknown[]): void {
    if (!isEcadPerfLogEnabled()) return;
    console.info("[ecad-perf]", ...args);
}
