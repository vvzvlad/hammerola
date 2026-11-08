/*
    How a schematic highlight comes and goes.

    Lighting eases in over a short time and out a little faster; a net that
    joins the highlight swells once as it arrives. The viewer samples this
    every frame while anything is still moving, and draws the scene and the
    sheet's dimming from the sample. With motion off, every change lands at
    once (headless scenes for insets and the schematic plane, which redraw
    only when told).
*/

const IN_MS = 220;
const OUT_MS = 180;
const SWELL_MS = 520;

const ease_out = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export interface MotionSample {
    /** 0 is unlit, 1 is fully lit. */
    intensity: number;
    /** Nets still swelling, by name, with how much swell remains (1 → 0). */
    swell: Map<string, number>;
    /** Nothing is moving any more. */
    settled: boolean;
}

export class HighlightMotion {
    #from = 0;
    #to = 0;
    #start = 0;
    #swells = new Map<string, number>();

    constructor(public animate = true) {}

    /** Light up (or go dark), swelling the nets named in `added`. */
    retarget(lit: boolean, added: readonly string[], now: number) {
        const current = this.sample(now).intensity;
        this.#from = this.animate ? current : lit ? 1 : 0;
        this.#to = lit ? 1 : 0;
        this.#start = now;
        if (!this.animate) return;
        for (const name of added) this.#swells.set(name, now);
    }

    sample(now: number): MotionSample {
        const duration = this.#to >= this.#from ? IN_MS : OUT_MS;
        const t = this.animate ? clamp01((now - this.#start) / duration) : 1;
        const intensity = this.#from + (this.#to - this.#from) * ease_out(t);
        const swell = new Map<string, number>();
        for (const [name, start] of this.#swells) {
            const left = 1 - clamp01((now - start) / SWELL_MS);
            if (left > 0) swell.set(name, ease_out(left));
            else this.#swells.delete(name);
        }
        return { intensity, swell, settled: t >= 1 && swell.size === 0 };
    }
}
