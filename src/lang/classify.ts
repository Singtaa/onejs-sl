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

import { INPUTS } from "../ir"
import { BUILTINS } from "./builtins"
import { lex } from "./lexer"
import { PRELUDE_NAMES } from "./prelude-source"
import { KEYWORD_SET, TYPE_SET } from "./words"

export type SLTokenClass =
    | "keyword" | "type" | "builtin" | "input" | "prelude"
    | "number" | "hex" | "comment" | "punct"
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

const INPUT_NAMES: ReadonlySet<string> = new Set(Object.keys(INPUTS))

/** The tokens of `source`, comments included, in order, each with its class. */
export function classify(source: string): SLClassifiedToken[] {
    const tokens = lex(source, "", true)
    const out: SLClassifiedToken[] = []
    // The last token that was not a comment, which decides what a name after a dot is.
    let before = ""
    let beforeThat = ""
    for (const t of tokens) {
        if (t.kind === "eof") break
        let kind: SLTokenClass
        if (t.kind === "ident") {
            if (before === ".") kind = beforeThat === "sdf" ? "builtin" : "member"
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
        if (t.kind !== "comment") { beforeThat = before; before = t.text }
    }
    return out
}
