import { expose } from "comlink";
import { BoardParser, SchematicParser } from "kicad-parser";

export class ParserWorker {
    set_perf_log(enabled: boolean) {
        (globalThis as any).__ECAD_PERF_LOG__ = !!enabled;
    }

    parse_board(buf: ArrayBuffer) {
        const content = new TextDecoder().decode(buf);
        return new BoardParser().parse(content);
    }

    parse_schematic(buf: ArrayBuffer) {
        const content = new TextDecoder().decode(buf);
        return new SchematicParser().parse(content);
    }
}

expose(new ParserWorker());
