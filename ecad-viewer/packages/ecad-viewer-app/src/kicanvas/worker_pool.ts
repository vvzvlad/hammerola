import * as Comlink from "comlink";
import type { ParseResult } from "./parser.worker";

type ParserAPI = {
    set_perf_log(enabled: boolean): Promise<void> | void;
    parse_board(buffer: ArrayBuffer): Promise<ParseResult>;
    split_board(buffer: ArrayBuffer, k: number): Promise<ArrayBuffer[]>;
    triangulate_rings(rings: Float64Array[]): Promise<Float32Array[]>;
    parse_schematic(buffer: ArrayBuffer): Promise<ParseResult>;
};

export class WorkerPool {
    private workerHandles: Worker[] = [];
    private workers: Comlink.Remote<ParserAPI>[] = [];
    private idle: Comlink.Remote<ParserAPI>[] = [];
    private queue: (() => void)[] = [];
    private disposed = false;

    /** Number of workers in the pool. */
    get size(): number {
        return this.workers.length;
    }

    constructor(workerCount: number) {
        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(
                new URL("./parser.worker.js", import.meta.url),
                { type: "module" },
            );

            const wrapped = Comlink.wrap<ParserAPI>(worker);
            this.workerHandles.push(worker);
            this.workers.push(wrapped);
            this.idle.push(wrapped);
        }
    }

    async run<T>(
        job: (worker: Comlink.Remote<ParserAPI>) => Promise<T>,
    ): Promise<T> {
        if (this.disposed) throw new Error("Parser worker pool is disposed");
        if (this.idle.length === 0) {
            await new Promise<void>((resolve) => {
                this.queue.push(resolve);
            });
        }
        if (this.disposed) throw new Error("Parser worker pool is disposed");

        const worker = this.idle.pop()!;
        try {
            return await job(worker);
        } finally {
            this.idle.push(worker);
            if (this.queue.length) {
                this.queue.shift()!();
            }
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const worker of this.workers) {
            worker[Comlink.releaseProxy]();
        }
        for (const worker of this.workerHandles) worker.terminate();
        this.workerHandles.length = 0;
        this.workers.length = 0;
        this.idle.length = 0;
        this.queue.splice(0).forEach((resolve) => resolve());
    }
}
