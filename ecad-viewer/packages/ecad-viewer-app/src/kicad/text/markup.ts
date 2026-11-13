/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/**
 * KiCAD text markup parser
 *
 * KiCAD uses basic text markup to express subscript, superscript, and overbar
 * text. For example "normal ^{superscript} _{subscript} ~{overbar}".
 */
export class Markup {
    root: MarkupNode;

    constructor(public text: string) {
        this.root = new MarkupNode();
        parse_run(text, 0, this.root, false);
        this.root.is_root = true;
    }
}

export class MarkupNode {
    is_root = false;
    subscript = false;
    superscript = false;
    overbar = false;
    text = "";
    children: MarkupNode[] = [];
}

/**
 * Parses as KiCad's MARKUP_PARSER (include/markup_parser.h): only `^{`, `_{`
 * and `~{` open markup, and only when a `}` closes it on the same text, which
 * nested markup and an escape sequence (`{slash}`) do not end; any other
 * character, an unclosed opener and a stray `}` included, is plain text.
 *
 * Adds the children of `node` from `start` on. Inside braces it returns the
 * index just past the closing `}`, or -1 when the text ends first; outside
 * them, the text's length.
 */
function parse_run(
    text: string,
    start: number,
    node: MarkupNode,
    in_braces: boolean,
): number {
    let run = "";
    const flush = () => {
        if (run) {
            const child = new MarkupNode();
            child.text = run;
            node.children.push(child);
            run = "";
        }
    };

    let i = start;
    while (i < text.length) {
        const c = text[i]!;
        if ((c == "^" || c == "_" || c == "~") && text[i + 1] == "{") {
            const child = new MarkupNode();
            const end = parse_run(text, i + 2, child, true);
            if (end >= 0) {
                child.superscript = c == "^";
                child.subscript = c == "_";
                child.overbar = c == "~";
                flush();
                node.children.push(child);
                i = end;
                continue;
            }
        }
        if (in_braces) {
            if (c == "}") {
                flush();
                return i + 1;
            }
            const escape = escape_sequence_end(text, i);
            if (escape > 0) {
                run += text.slice(i, escape);
                i = escape;
                continue;
            }
        }
        run += c;
        i++;
    }

    if (in_braces) {
        return -1;
    }
    flush();
    return i;
}

/** The index past an escape sequence `{identifier}` at `start`, or -1. */
function escape_sequence_end(text: string, start: number): number {
    if (text[start] != "{" || !/[A-Za-z_]/.test(text[start + 1] ?? "")) {
        return -1;
    }
    let i = start + 2;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) {
        i++;
    }
    return text[i] == "}" ? i + 1 : -1;
}
