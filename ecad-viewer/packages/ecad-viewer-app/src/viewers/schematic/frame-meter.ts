/*
    The frame counter the schematic plane shows with the `ecadPerfLog` flag,
    as numbers. Frames are drawn on demand, so frames per second only mean
    something while the camera keeps moving: a run is frames none of them
    further than `RUN_GAP` from the one before, and the threshold is read as
    the fewest frames in a whole wall-clock second inside the latest run,
    its first and last seconds, which the run covers only in part, left out.
    Below 5 frames a second each frame is a run of its own and the pan
    reading stays the previous one's; the frames of the last second still
    show it.
*/

/** Frames this far apart (ms) or nearer are one run. */
export const RUN_GAP = 200;

export interface FrameMeter {
    /** When the frames of the last second up to the latest one started (ms). */
    recent: number[];
    /** The run the latest frame belongs to. */
    run: {
        /** When its first and its latest frame started (ms). */
        start: number;
        last: number;
        /** Frames per wall-clock second, from the second of its first frame. */
        counts: number[];
        /** Its longest frame (ms). */
        longest: number;
    };
    /**
     * The latest run that covered a whole second: its fewest frames in one,
     * and its longest frame (ms). A shorter run, a redraw on hover, leaves it.
     */
    pan: { min: number; longest: number } | null;
    /** How long the latest frame took (ms). */
    took: number;
}

/** The meter after a frame that started `at` (ms) and took `took` ms. */
export function count_frame(
    meter: FrameMeter | null,
    at: number,
    took: number,
): FrameMeter {
    const recent = (meter?.recent ?? []).filter((t) => t > at - 1000);
    recent.push(at);
    const going =
        meter !== null && at - meter.run.last <= RUN_GAP ? meter.run : null;
    const start = going?.start ?? at;
    const counts = going ? [...going.counts] : [];
    const second = Math.floor(at / 1000) - Math.floor(start / 1000);
    while (counts.length <= second) counts.push(0);
    counts[second]! += 1;
    const longest = Math.max(going?.longest ?? 0, took);
    // The first second and the one under way are covered in part.
    const whole = counts.slice(1, -1);
    const pan = whole.length
        ? { min: Math.min(...whole), longest }
        : (meter?.pan ?? null);
    return {
        recent,
        run: { start, last: at, counts, longest },
        pan,
        took,
    };
}
