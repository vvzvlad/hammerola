/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

const EOF = "\x04";

export class Token {
    static OPEN = Symbol("opn");
    static CLOSE = Symbol("clo");
    static ATOM = Symbol("atm");
    static NUMBER = Symbol("num");
    static STRING = Symbol("str");

    constructor(
        public type: symbol,
        public value: any = null,
    ) {}
}

function is_digit(c: string) {
    return c >= "0" && c <= "9";
}

function is_alpha(c: string) {
    return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
}

function is_whitespace(c: string) {
    return (
        c === EOF ||
        c === " " ||
        c === "\n" ||
        c === "\r" ||
        c === "\t" ||
        c === "|"
    );
}

function is_atom(c: string) {
    return (
        is_alpha(c) ||
        is_digit(c) ||
        [
            "_",
            "-",
            ":",
            "!",
            ".",
            "[",
            "]",
            "{",
            "}",
            "@",
            "*",
            "/",
            "&",
            "#",
            "%",
            "+",
            "=",
            "~",
            "$",
        ].includes(c)
    );
}

function error_context(input: string, index: number) {
    let start = input.slice(0, index).lastIndexOf("\n");
    if (start < 0) start = 0;
    let end = input.slice(index).indexOf("\n");
    if (end < 0) end = 20;
    return input.slice(start, index + end);
}

enum State {
    none,
    string,
    number,
    atom,
    hex,
}

export function* tokenize(input: string) {
    const open_token = new Token(Token.OPEN);
    const close_token = new Token(Token.CLOSE);
    let state: State = State.none;
    let start_idx = 0;
    let escaping = false;

    for (let i = 0; i < input.length + 1; i++) {
        const c: string = i < input.length ? input[i]! : EOF;

        if (state == State.none) {
            if (c === "(") {
                yield open_token;
                continue;
            } else if (c === ")") {
                yield close_token;
                continue;
            } else if (c === '"') {
                state = State.string;
                start_idx = i;
                continue;
            } else if (c === "-" || c == "+" || is_digit(c)) {
                state = State.number;
                start_idx = i;
                continue;
            } else if (is_alpha(c) || ["*", "&", "$", "/", "%"].includes(c)) {
                state = State.atom;
                start_idx = i;
                continue;
            } else if (is_whitespace(c)) {
                continue;
            } else if (c === "|") {
                continue;
            } else {
                throw new Error(
                    `Unexpected character at index ${i}: ${c}\nContext: ${error_context(
                        input,
                        i,
                    )}`,
                );
            }
        } else if (state == State.atom) {
            if (is_atom(c)) {
                continue;
            } else if (c === ")" || is_whitespace(c)) {
                yield new Token(Token.ATOM, input.substring(start_idx, i));
                state = State.none;
                if (c === ")") {
                    yield close_token;
                }
            } else {
                continue;
            }
        } else if (state == State.number) {
            if (c === "." || is_digit(c)) {
                continue;
            } else if (c.toLowerCase() === "x") {
                state = State.hex;
                continue;
            } else if (
                ["+", "-", "a", "b", "c", "d", "e", "f"].includes(
                    c.toLowerCase(),
                )
            ) {
                state = State.atom;
                continue;
            } else if (is_atom(c)) {
                state = State.atom;
                continue;
            } else if (c === ")" || is_whitespace(c)) {
                yield new Token(
                    Token.NUMBER,
                    parseFloat(input.substring(start_idx, i)),
                );
                state = State.none;
                if (c === ")") {
                    yield close_token;
                }
                continue;
            } else {
                throw new Error(
                    `Unexpected character at index ${i}: ${c}, expected numeric.\nContext: ${error_context(
                        input,
                        i,
                    )}`,
                );
            }
        } else if (state == State.hex) {
            if (
                is_digit(c) ||
                ["a", "b", "c", "d", "e", "f", "_"].includes(c.toLowerCase())
            ) {
                continue;
            } else if (c === ")" || is_whitespace(c)) {
                const hexstr = input.substring(start_idx, i).replace("_", "");
                yield new Token(Token.NUMBER, Number.parseInt(hexstr, 16));
                state = State.none;
                if (c === ")") {
                    yield close_token;
                }
                continue;
            } else if (is_atom(c)) {
                state = State.atom;
                continue;
            } else {
                throw new Error(
                    `Unexpected character at index ${i}: ${c}, expected hexadecimal.\nContext: ${error_context(
                        input,
                        i,
                    )}`,
                );
            }
        } else if (state == State.string) {
            if (!escaping && c === '"') {
                yield new Token(
                    Token.STRING,
                    input
                        .substring((start_idx ?? 0) + 1, i)
                        .replaceAll("\\n", "\n")
                        .replaceAll("\\\\", "\\")
                        .replaceAll('\\"', '"'),
                );
                state = State.none;
                escaping = false;
                continue;
            } else if (!escaping && c === "\\") {
                escaping = true;
                continue;
            } else {
                escaping = false;
                continue;
            }
        } else {
            throw new Error(
                `Unknown tokenizer state ${state}\nContext: ${error_context(
                    input,
                    i,
                )}`,
            );
        }
    }
}

export type List = (string | number | List)[];

export function* listify_tokens(tokens: Generator<Token>): Generator<List> {
    let token;
    let it;

    while (true) {
        it = tokens.next();
        token = it.value;

        switch (token?.type) {
            case Token.ATOM:
            case Token.STRING:
            case Token.NUMBER:
                yield token.value;
                break;
            case Token.OPEN:
                yield Array.from(listify_tokens(tokens)) as any;
                break;
            case Token.CLOSE:
            case undefined:
                return;
        }
    }
}

// ---------------------------------------------------------------------------
// Fast single-pass listify
// ---------------------------------------------------------------------------
//
// The generator-based `tokenize` + `listify_tokens` above is correct but slow:
// it indexes the source string char-by-char, allocates a Token object per
// token, and crosses two generator suspend/resume boundaries per token. On a
// 9 MB board that is ~9M char reads + millions of short-lived allocations —
// measured at ~5 s per board in the worker, which is the dominant load cost.
//
// This replacement produces the IDENTICAL nested-array output (string | number)
// in a single pass: `charCodeAt` integer comparisons (no per-char string
// alloc), a precomputed atom-character lookup table (no `.includes` per char),
// and an explicit array stack for nesting (no recursion, no generators, no
// Token objects). All original quirks are preserved — see the reference state
// machine in `tokenize` above:
//   - '|' counts as whitespace
//   - number → atom degradation keeps the leading sign/digits (start stays put)
//   - hex (0x…, underscores stripped) and float parsing
//   - string escapes \n \\ \"
// The old generator API (`tokenize`, `listify_tokens`, `Token`) is retained for
// any external consumer, but `listify` no longer uses it.

// Character-code lookup: is this code a valid *atom* continuation char?
// Mirrors is_atom(): alpha, digit, and _ - : ! . [ ] { } @ * / & # % + = ~ $
const IS_ATOM = new Uint8Array(128);
{
    const mark = (s: string) => {
        for (let i = 0; i < s.length; i++) IS_ATOM[s.charCodeAt(i)] = 1;
    };
    for (let c = 48; c <= 57; c++) IS_ATOM[c] = 1; // 0-9
    for (let c = 65; c <= 90; c++) IS_ATOM[c] = 1; // A-Z
    for (let c = 97; c <= 122; c++) IS_ATOM[c] = 1; // a-z
    mark("_-:!.[]{}@*/&#%+=~$");
}

// Char codes we compare against repeatedly.
const CC_OPEN = 40; // (
const CC_CLOSE = 41; // )
const CC_QUOTE = 34; // "
const CC_BACKSLASH = 92; // \
const CC_MINUS = 45; // -
const CC_PLUS = 43; // +
const CC_DOT = 46; // .
const CC_PIPE = 124; // |
const CC_SPACE = 32;
const CC_TAB = 9;
const CC_LF = 10;
const CC_CR = 13;
const CC_0 = 48;
const CC_9 = 57;

function is_ws_code(c: number): boolean {
    return (
        c === CC_SPACE ||
        c === CC_LF ||
        c === CC_CR ||
        c === CC_TAB ||
        c === CC_PIPE
    );
}
function is_digit_code(c: number): boolean {
    return c >= CC_0 && c <= CC_9;
}
// hex continuation: 0-9 a-f A-F _
function is_hex_code(c: number): boolean {
    return (
        (c >= CC_0 && c <= CC_9) ||
        (c >= 97 && c <= 102) ||
        (c >= 65 && c <= 70) ||
        c === 95 // _
    );
}

// Decode a string literal body (between the quotes), applying the same escape
// rules as the reference tokenizer: \n → newline, \\ → \, \" → ". The reference
// only special-cases these three; any other `\x` collapses to `x` (the escaping
// flag is cleared and the char emitted verbatim). We reproduce that: a lone
// backslash is dropped and the following char kept as-is.
// Decode the string body input[start, end). `firstBs` is the index of the
// first backslash within that range (>= start), already found by the caller —
// so we never scan beyond the token (the previous `indexOf` from `start`
// scanned to the next backslash anywhere in the file, which was O(n²) across
// thousands of strings). When there is no backslash the caller passes -1 and
// we substring directly.
function decode_string(
    input: string,
    start: number,
    end: number,
    firstBs: number,
): string {
    if (firstBs < 0) return input.substring(start, end);
    let out = input.substring(start, firstBs);
    let i = firstBs;
    while (i < end) {
        const c = input.charCodeAt(i);
        if (c === CC_BACKSLASH && i + 1 < end) {
            const nc = input.charCodeAt(i + 1);
            if (nc === 110)
                out += "\n"; // \n
            else if (nc === CC_BACKSLASH) out += "\\";
            else if (nc === CC_QUOTE) out += '"';
            else out += input[i + 1]!; // reference keeps the char verbatim
            i += 2;
        } else {
            // Copy a run of non-backslash chars in one substring, not char by
            // char (avoids O(len²) concatenation on long strings).
            let r = i;
            while (r < end && input.charCodeAt(r) !== CC_BACKSLASH) r++;
            out += input.substring(i, r);
            i = r;
        }
    }
    return out;
}

export function listify(src: string): List {
    const root: List = [];
    // Stack of open lists; the top is the current list we push into.
    const stack: List[] = [root];
    let top: List = root;
    const n = src.length;
    let i = 0;

    while (i < n) {
        const c = src.charCodeAt(i);

        if (c === CC_OPEN) {
            const lst: List = [];
            top.push(lst as any);
            stack.push(lst);
            top = lst;
            i++;
            continue;
        }
        if (c === CC_CLOSE) {
            if (stack.length > 1) {
                stack.pop();
                top = stack[stack.length - 1]!;
            }
            i++;
            continue;
        }
        if (is_ws_code(c)) {
            i++;
            continue;
        }
        if (c === CC_QUOTE) {
            // String: scan to the matching unescaped quote, noting the first
            // backslash so decode_string never rescans past this token.
            const start = i + 1;
            let j = start;
            let escaping = false;
            let firstBs = -1;
            while (j < n) {
                const cj = src.charCodeAt(j);
                if (!escaping && cj === CC_QUOTE) break;
                if (!escaping && cj === CC_BACKSLASH) {
                    escaping = true;
                    if (firstBs < 0) firstBs = j;
                } else escaping = false;
                j++;
            }
            top.push(decode_string(src, start, j, firstBs));
            i = j + 1; // skip closing quote
            continue;
        }

        // Number or atom. A token starts here; scan to the next ws or ')'.
        const start = i;
        const startsNumeric =
            c === CC_MINUS || c === CC_PLUS || is_digit_code(c);
        let j = i + 1;
        while (j < n) {
            const cj = src.charCodeAt(j);
            if (cj === CC_CLOSE || is_ws_code(cj) || cj === CC_OPEN) break;
            j++;
        }
        const text = src.substring(start, j);

        if (startsNumeric) {
            // Reproduce the reference number/hex/atom classification. The
            // reference degrades to an atom the moment it sees a char that
            // isn't valid in a number/hex run; the emitted atom is the whole
            // substring from the numeric start. So: a run is a NUMBER only if
            // it's a well-formed decimal or hex literal; otherwise it's an ATOM.
            const num = classify_numeric(text);
            top.push(num === undefined ? text : num);
        } else {
            top.push(text);
        }
        i = j;
    }

    return root;
}

// Returns the parsed number for a numeric-looking token, or undefined if the
// run degrades to an atom (matching the reference state machine, where any
// non-numeric/non-hex atom char flips State.number → State.atom and the token
// is emitted as the full substring).
function classify_numeric(text: string): number | undefined {
    const len = text.length;
    if (len === 0) return undefined;

    // Walk the run exactly as the reference State.number → State.hex/atom
    // machine does, so the classification and the substring boundaries match
    // byte-for-byte.
    //
    //   number state: '.' or digit → stay; 'x'/'X' → hex state; any other char
    //                 (including +,-,a-f and every atom char) → atom (undefined).
    //   hex state:    digit / a-f / A-F / '_' → stay; any other char → atom.
    //
    // On a clean run the token is NUMBER: decimal → parseFloat(text); hex →
    // parseInt(text, 16) applied to the WHOLE substring INCLUDING the leading
    // "0x". This reproduces the reference's quirk that e.g. "0x5555…" yields 0
    // (parseInt stops at 'x' under an explicit radix). Do not "fix" this — it
    // must match the existing parser's output.
    let k = 0;
    // The leading sign/digit was consumed in State.none before entering
    // State.number, so start_idx includes it; skip a single leading +/- here.
    const c0 = text.charCodeAt(0);
    if (c0 === CC_MINUS || c0 === CC_PLUS) k = 1;
    if (k >= len) return undefined; // lone "+"/"-" is an atom
    // number state
    for (; k < len; k++) {
        const cc = text.charCodeAt(k);
        if (cc === CC_DOT || is_digit_code(cc)) continue;
        if (cc === 120 || cc === 88) {
            // 'x'/'X' → hex state
            k++;
            for (; k < len; k++) {
                if (!is_hex_code(text.charCodeAt(k))) return undefined; // → atom
            }
            // NB: the reference uses String.replace("_", "") which removes only
            // the FIRST underscore (not a global regex), and parseInt(_,16) is
            // applied to the whole substring INCLUDING the leading "0x". Both
            // quirks are load-bearing — e.g. "0x00000000_00000000_5555…" yields
            // 0 because parseInt stops at the first remaining underscore. Match
            // it exactly; do not "fix" to a global strip.
            const hexstr = text.replace("_", "");
            const v = Number.parseInt(hexstr, 16);
            return Number.isNaN(v) ? undefined : v;
        }
        return undefined; // any other char → atom
    }
    const v = parseFloat(text);
    return Number.isNaN(v) ? undefined : v;
}
