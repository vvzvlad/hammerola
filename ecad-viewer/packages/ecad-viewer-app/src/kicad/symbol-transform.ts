/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Matrix3, Vec2 } from "../base/math";

/**
 * How a placed symbol instance maps its library geometry into the document.
 *
 * A library symbol is authored Y-up and a schematic is drawn Y-down, so this
 * transform is never the identity: even an unrotated, unmirrored symbol
 * carries the flip. Keeping it in the model layer is what lets a bbox agree
 * with what is painted -- the two used to be computed separately, and drifted.
 */
export type SymbolTransform = {
    matrix: Matrix3;
    position: Vec2;
    rotations: number;
    mirror_x: boolean;
    mirror_y: boolean;
};

/**
 * The placement fields this transform reads.
 *
 * Structural rather than `SchematicSymbol` so the model's own
 * `kicad/schematic.ts` can call it without the two modules importing each
 * other.
 */
export interface SymbolPlacement {
    at: { position: Vec2; rotation: number };
    mirror?: "x" | "y";
}

/** Rotations KiCad can store for a symbol instance. */
function quadrant(rotation: number): number | null {
    switch (rotation) {
        case 0:
            return 0;
        case 90:
            return 1;
        case 180:
            return 2;
        case 270:
            return 3;
        default:
            return null;
    }
}

/**
 * Determines the symbol position, orientation, and mirroring
 *
 * This is based on SCH_PAINTER::orientSymbol, where KiCAD does some fun logic
 * to place a symbol instance. This tries to replicate that.
 *
 * Throws on a rotation KiCad cannot produce. Callers that must survive a
 * malformed file should use {@link try_get_symbol_transform}.
 */
export function get_symbol_transform(symbol: SymbolPlacement): SymbolTransform {
    // Note: KiCAD uses a 2x2 transformation matrix for symbol orientation. It's
    // literally the only place that uses this wacky matrix. We approximate it
    // with carefully crafted Matrix3s. KiCAD's symbol matrix is defined as
    //      [x1, x2]
    //      [y1, y2]
    // which cooresponds to a Matrix3 of
    //      [x1, x2, 0]
    //      [x1, y2, 0]
    //      [0,   0, 1]
    const zero_deg_matrix = new Matrix3([1, 0, 0, 0, -1, 0, 0, 0, 1]); // [1, 0, 0, -1]
    const ninety_deg_matrix = new Matrix3([0, -1, 0, -1, 0, 0, 0, 0, 1]); // [0, -1, -1, 0]
    const one_eighty_deg_matrix = new Matrix3([-1, 0, 0, 0, 1, 0, 0, 0, 1]); // [-1, 0, 0, 1]
    const two_seventy_deg_matrix = new Matrix3([0, 1, 0, 1, 0, 0, 0, 0, 1]); // [0, 1, 1, 0]

    const rotations = quadrant(symbol.at.rotation);
    if (rotations === null) {
        throw new Error(`unexpected rotation ${symbol.at.rotation}`);
    }

    const matrix = [
        zero_deg_matrix,
        ninety_deg_matrix,
        one_eighty_deg_matrix,
        two_seventy_deg_matrix,
    ][rotations]!;

    if (symbol.mirror == "y") {
        // * [-1, 0, 0, 1]
        const x1 = matrix.elements[0]! * -1;
        const y1 = matrix.elements[3]! * -1;
        const x2 = matrix.elements[1]!;
        const y2 = matrix.elements[4]!;
        matrix.elements[0] = x1;
        matrix.elements[1] = x2;
        matrix.elements[3] = y1;
        matrix.elements[4] = y2;
    } else if (symbol.mirror == "x") {
        // * [1, 0, 0, -1]
        const x1 = matrix.elements[0]!;
        const y1 = matrix.elements[3]!;
        const x2 = matrix.elements[1]! * -1;
        const y2 = matrix.elements[4]! * -1;
        matrix.elements[0] = x1;
        matrix.elements[1] = x2;
        matrix.elements[3] = y1;
        matrix.elements[4] = y2;
    }

    return {
        matrix: matrix,
        position: symbol.at.position,
        rotations: rotations,
        mirror_x: symbol.mirror == "x",
        mirror_y: symbol.mirror == "y",
    };
}

/**
 * The full library-to-document matrix for a symbol instance.
 *
 * This is exactly what the painter applies to symbol body geometry
 * (`translation(position)` then the orientation matrix), and the composite
 * `PinPainter.apply_symbol_transformations` builds step by step for a pin's
 * position. Transforming library geometry with it therefore lands where that
 * geometry is drawn.
 */
export function symbol_transform_matrix(symbol: SymbolPlacement): Matrix3 {
    const transform = get_symbol_transform(symbol);
    return Matrix3.translation(
        symbol.at.position.x,
        symbol.at.position.y,
    ).multiply(transform.matrix);
}

/**
 * {@link symbol_transform_matrix} for callers that must not throw.
 *
 * A bounding box is asked for while drawing or hit-testing, where a file with
 * an out-of-spec rotation should degrade to a wrong box rather than take down
 * the whole document. Falls back to placement without orientation.
 */
export function try_symbol_transform_matrix(symbol: SymbolPlacement): Matrix3 {
    try {
        return symbol_transform_matrix(symbol);
    } catch {
        return Matrix3.translation(
            symbol.at.position.x,
            symbol.at.position.y,
        ).multiply(new Matrix3([1, 0, 0, 0, -1, 0, 0, 0, 1]));
    }
}
