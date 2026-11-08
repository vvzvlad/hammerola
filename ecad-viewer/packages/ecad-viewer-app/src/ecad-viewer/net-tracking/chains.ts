/*
    Chains on the schematic plane: the nets a double-click on a label, a
    sheet entry or a power symbol draws, any number of them, one per net.

    A chain is the reach of the place clicked (`net_closure`): the places it
    links, on other sheets and on its own (a local label's namesakes are all
    on its own sheet), joined by the shortest tree of straight lines
    (`spanning_pairs`) in the chain's colour, a ring on every place it joins
    and a larger one on the place it started from. A double-click on a place
    a chain reaches takes that chain away; on any other traceable place it
    adds that place's chain in the next colour (`toggle`). A net with one
    place on the whole schematic has nothing to join and draws none.

    Where a place is comes from the caller (`layout`), each frame, so a
    place on a sheet still being built joins its chain once that sheet is
    there, and one on a sheet that failed to build is left out.
*/

import type { Vec2 } from "../../base/math";
import { spanning_pairs } from "./geometry";
import {
    instance_key,
    net_closure,
    type NetInstance,
    type NetInstancePage,
} from "./net-graph";
import { CHAIN_COLORS } from "./paint";

export interface Chain {
    from: NetInstance;
    /** The places the chain joins, `from` first, each once. */
    places: NetInstance[];
    /** Every instance the net reaches, by `instance_key`. */
    reached: ReadonlySet<string>;
    color: string;
}

/** A chain as drawn: its colour, its rings and its lines, on the plane. */
export interface ChainLayout {
    color: string;
    marks: Array<{ at: Vec2; start: boolean }>;
    segments: Array<[Vec2, Vec2]>;
}

export class Chains {
    #chains: Chain[] = [];
    /** Chains added since there were none: the next one's colour. */
    #added = 0;

    get list(): readonly Chain[] {
        return this.#chains;
    }

    /**
     * A double-click on `from`: take away every chain it is in, or add its
     * net's chain when it is in none. False when nothing changed: a net with
     * no place to join.
     */
    toggle(pages: readonly NetInstancePage[], from: NetInstance): boolean {
        const key = instance_key(from);
        const holding = this.#chains.filter((chain) => chain.reached.has(key));
        if (holding.length) {
            this.#chains = this.#chains.filter(
                (chain) => !holding.includes(chain),
            );
            if (!this.#chains.length) this.#added = 0;
            return true;
        }
        const { instances, links } = net_closure(pages, from);
        if (!links.length) return false;
        const places = new Map(
            [from, ...links.flat()].map((it) => [instance_key(it), it]),
        );
        this.#chains.push({
            from,
            places: [...places.values()],
            reached: new Set(instances.map(instance_key)),
            color: CHAIN_COLORS[this.#added++ % CHAIN_COLORS.length]!,
        });
        return true;
    }

    /** Take every chain away; false when there was none. */
    clear(): boolean {
        if (!this.#chains.length) return false;
        this.#chains = [];
        this.#added = 0;
        return true;
    }

    /**
     * Each chain's rings and lines at the places `locate` finds (plane
     * coordinates, null where a place is not drawn). The tree is found in
     * plane coordinates, which the camera does not move, so it keeps its
     * shape while the plane pans and zooms.
     */
    layout(locate: (at: NetInstance) => Vec2 | null): ChainLayout[] {
        return this.#chains.map((chain) => {
            const found = chain.places.flatMap((it) => {
                const at = locate(it);
                return at ? [{ it, at }] : [];
            });
            return {
                color: chain.color,
                marks: found.map(({ it, at }) => ({
                    at,
                    start: it === chain.from,
                })),
                segments: spanning_pairs(found.map(({ at }) => at)).map(
                    ([i, j]) => [found[i]!.at, found[j]!.at] as [Vec2, Vec2],
                ),
            };
        });
    }
}
