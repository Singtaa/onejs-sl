/**
 * Every token of a file with what it is, for an editor's highlighting.
 *
 * `Specs/SL_NEXT.md` 9. Built on the parser's own scanner and the parser's own
 * word lists, so what highlights as a keyword is exactly what parses as one,
 * and a builtin is exactly what `BUILTINS` holds. It never throws: it runs on
 * every keystroke over half typed text, and a character it cannot read comes
 * back as `invalid` rather than ending the pass.
 *
 * Classification is by spelling and position alone, not by scope. A local
 * that takes a builtin's name (`float circle = ...`) still reads `builtin`
 * where it is used; telling the two apart needs `analyze`, and an editor that
 * wants that should ask it.
 */

import { PREVIOUS, SOURCE_INPUTS } from "../ir"
import { BUILTINS } from "./builtins"
import { lex } from "./lexer"
import { PRELUDE_NAMES } from "./prelude-source"
import { KEYWORD_SET, TYPE_SET } from "./words"

export type SLTokenClass =
    | "keyword" | "type" | "builtin" | "input" | "prelude"
    | "number" | "hex" | "string" | "comment" | "punct"
    /** An attribute's name, as in `[Range(0, 1)]`. */
    | "attribute"
    /** A component after a dot, as in `c.rgb`. */
    | "member"
    /** Any other name: a uniform, a local, a function the file declares. */
    | "ident"
    /** A character or `#word` the language cannot read, and would refuse. */
    | "invalid"

export interface SLClassifiedToken {
    kind: SLTokenClass
    text: string
    /** 1 based. */
    line: number
    /** 1 based. */
    col: number
    offset: number
    length: number
}

const INPUT_NAMES: ReadonlySet<string> = new Set([...Object.keys(SOURCE_INPUTS), PREVIOUS])

/** The tokens of `source`, comments included, in order, each with its class. */
export function classify(source: string): SLClassifiedToken[] {
    return run(source, "", "").tokens
}

/**
 * Where a line starts, for `classifyLine`: what the lines before it leave
 * behind that changes how it reads.
 */
export interface SLLineState {
    /** The line before ended inside a block comment. */
    readonly comment: boolean
    /** The last two tokens before the line that were not comments, which decide what a name after a dot or a bracket is. */
    readonly before: string
    readonly beforeThat: string
}

const FIRST_LINE: SLLineState = { comment: false, before: "", beforeThat: "" }

/**
 * One line of a file, for an editor that colours a line at a time, as Monaco
 * does: its tokens, with offsets within the line, and the state the next line
 * starts from. Classifying every line of a file this way, each from the state
 * the one before ended in, gives exactly what `classify` gives the whole file,
 * a block comment over several lines coming back as one piece per line.
 */
export function classifyLine(line: string, state: SLLineState = FIRST_LINE): { tokens: SLClassifiedToken[]; state: SLLineState } {
    // A line that starts inside a block comment is read with the comment's
    // opening put back in front, so the lexer decides where it closes, and
    // those two characters are taken off the tokens again.
    const shift = state.comment ? 2 : 0
    const read = run(state.comment ? "/*" + line : line, state.before, state.beforeThat)
    const last = read.tokens[read.tokens.length - 1]
    const comment = last !== undefined && last.kind === "comment" && last.text.startsWith("/*")
        && !(last.text.length >= 4 && last.text.endsWith("*/"))
    const tokens: SLClassifiedToken[] = []
    for (const t of read.tokens) {
        if (shift === 0) { tokens.push(t); continue }
        if (t.offset === 0) {
            if (t.length > shift) tokens.push({ ...t, text: t.text.slice(shift), length: t.length - shift })
        } else {
            tokens.push({ ...t, col: t.col - shift, offset: t.offset - shift })
        }
    }
    return { tokens, state: { comment, before: read.before, beforeThat: read.beforeThat } }
}

function run(source: string, before: string, beforeThat: string): { tokens: SLClassifiedToken[]; before: string; beforeThat: string } {
    const tokens = lex(source, "", true)
    const out: SLClassifiedToken[] = []
    for (const t of tokens) {
        if (t.kind === "eof") break
        let kind: SLTokenClass
        if (t.kind === "ident") {
            if (before === ".") kind = beforeThat === "sdf" ? "builtin" : "member"
            // There are no arrays, so a name straight after "[" is an attribute's.
            else if (before === "[") kind = "attribute"
            else if (KEYWORD_SET.has(t.text)) kind = "keyword"
            else if (TYPE_SET.has(t.text)) kind = "type"
            else if (INPUT_NAMES.has(t.text)) kind = "input"
            else if (BUILTINS[t.text] !== undefined) kind = "builtin"
            else if (PRELUDE_NAMES.has(t.text)) kind = "prelude"
            else kind = "ident"
        } else {
            kind = t.kind
        }
        out.push({ kind, text: t.text, line: t.line, col: t.col, offset: t.offset, length: t.length })
        // The last token that was not a comment, which decides what a name after a dot is.
        if (t.kind !== "comment") { beforeThat = before; before = t.text }
    }
    return { tokens: out, before, beforeThat }
}
