/**
 * Temporary parse/render perf logging for JTYU-OBC benchmarks.
 * Enable with localStorage.setItem('ecadPerfLog','1') or ?ecadPerfLog=1
 */
export function isEcadPerfLogEnabled(): boolean {
    if (
        typeof globalThis !== "undefined" &&
        (globalThis as any).__ECAD_PERF_LOG__
    ) {
        return true;
    }
    try {
        if (
            typeof localStorage !== "undefined" &&
            localStorage.getItem("ecadPerfLog") === "1"
        ) {
            return true;
        }
        if (
            typeof location !== "undefined" &&
            new URLSearchParams(location.search).get("ecadPerfLog") === "1"
        ) {
            return true;
        }
    } catch {
        /* ignore */
    }
    return false;
}

export function ecadPerfLog(...args: unknown[]): void {
    if (!isEcadPerfLogEnabled()) return;
    console.info("[ecad-perf]", ...args);
}

export function formatBytes(n: number): string {
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${n}B`;
}
