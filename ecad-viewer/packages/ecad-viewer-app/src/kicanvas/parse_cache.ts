/**
 * Parse de-duplication and result cache, budgeted by source bytes.
 *
 * A cached result is a parsed pod, kept after the document model has been
 * built from it, so it costs memory roughly in proportion to its file: on
 * EDA-04903 (56.8 MB) one entry held 83 MB of heap after load. Entries are
 * therefore evicted oldest-first (least recently used) once the cache holds
 * more than `max_entries` or more than `max_bytes` of source, and an entry
 * larger than the whole byte budget is kept only while it is in flight:
 * concurrent loads of that file still share one parse, but once it settles
 * it is dropped instead of being held for the rest of the page's life. Such
 * an entry does not count against the budget, so it never pushes smaller,
 * kept entries out. A failed parse is forgotten.
 */
export class ParseCache {
    #entries = new Map<string, { promise: Promise<unknown>; bytes: number }>();
    #bytes = 0;
    hits = 0;
    misses = 0;

    constructor(
        readonly max_entries: number,
        readonly max_bytes: number,
    ) {}

    /** Number of entries held, in flight or settled. */
    get size(): number {
        return this.#entries.size;
    }

    /** Source bytes counted against the budget. */
    get bytes(): number {
        return this.#bytes;
    }

    has(key: string): boolean {
        return this.#entries.has(key);
    }

    /**
     * The cached promise for `key`, or the result of `run()`, cached under
     * `key` with `bytes` of source. The entry is in place before this
     * returns, so a second call with the same key in the same task shares it.
     */
    get_or_run<T>(
        key: string,
        bytes: number,
        run: () => Promise<T>,
    ): Promise<T> {
        const cached = this.#entries.get(key);
        if (cached) {
            this.hits += 1;
            // Most recently used goes last, so eviction takes the oldest.
            this.#entries.delete(key);
            this.#entries.set(key, cached);
            return cached.promise as Promise<T>;
        }
        this.misses += 1;

        const promise = run();
        const transient = bytes > this.max_bytes;
        const entry = { promise, bytes: transient ? 0 : bytes };
        this.#entries.set(key, entry);
        this.#bytes += entry.bytes;

        const forget = () => {
            if (this.#entries.get(key) !== entry) return;
            this.#entries.delete(key);
            this.#bytes -= entry.bytes;
        };
        promise.catch(forget);
        if (transient) promise.then(forget, () => {});

        for (const [old_key, old] of this.#entries) {
            if (
                this.#entries.size <= this.max_entries &&
                this.#bytes <= this.max_bytes
            ) {
                break;
            }
            if (old === entry) continue;
            this.#entries.delete(old_key);
            this.#bytes -= old.bytes;
        }
        return promise;
    }
}
