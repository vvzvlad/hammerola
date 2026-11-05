import { expose, transfer } from "comlink";
import { BoardParser, SchematicParser, split_board_bytes } from "kicad-parser";
import {
    triangulate_flat,
    triangulation_ready,
} from "../graphics/webgl/triangulate";

/** A parsed file, and whether its text needs the CJK glyph set. */
export type ParseResult = { pod: any; has_cjk: boolean };

const CJK =
    /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\uac00-\ud7af]/;

function has_cjk(content: string): boolean {
    return CJK.test(content);
}

export class ParserWorker {
    set_perf_log(enabled: boolean) {
        (globalThis as any).__ECAD_PERF_LOG__ = !!enabled;
    }

    parse_board(buf: ArrayBuffer): ParseResult {
        const content = new TextDecoder().decode(buf);
        return {
            pod: new BoardParser().parse(content),
            has_cjk: has_cjk(content),
        };
    }

    /**
     * Split a board into `k` self-contained board sources for parallel
     * parsing (see kicad-parser's board_split.ts). Runs here rather than on
     * the main thread because it is a full pass over the file. The chunks
     * are transferred back, not copied.
     */
    split_board(buf: ArrayBuffer, k: number) {
        const chunks = split_board_bytes(new Uint8Array(buf), k).map((c) =>
            c.byteOffset === 0 && c.byteLength === c.buffer.byteLength
                ? (c.buffer as ArrayBuffer)
                : (c.slice().buffer as ArrayBuffer),
        );
        return transfer(chunks, chunks);
    }

    /**
     * Triangulate rings (interleaved xy) exactly as the WebGL tesselator
     * would, so large zone fills are done here, in parallel, instead of one
     * after another on the main thread during paint. Results are transferred.
     */
    async triangulate_rings(rings: Float64Array[]) {
        await triangulation_ready();
        const out = rings.map((ring) => triangulate_flat(ring));
        return transfer(
            out,
            out.map((v) => v.buffer as ArrayBuffer),
        );
    }

    parse_schematic(buf: ArrayBuffer): ParseResult {
        const content = new TextDecoder().decode(buf);
        return {
            pod: new SchematicParser().parse(content),
            has_cjk: has_cjk(content),
        };
    }
}

expose(new ParserWorker());
