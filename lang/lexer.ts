/**
 * Tokens, with positions, for the text form of the shader language.
 *
 * Phase A of `Specs/SL_TEXT.md`. Nothing here knows what a shader is: it turns
 * characters into tokens and reports where each one started, so that every
 * later error can say file, line and column. That is the whole reason the
 * position travels on the token rather than being recovered later.
 *
 * HLSL's lexical surface, minus the preprocessor. `#` begins a colour literal
 * and nothing else, which is why a stray `#pragma` gets its own message rather
 * than "unexpected character".
 */

import { SLError } from "../ir"

export type TokenKind = "ident" | "number" | "hex" | "punct" | "eof"

export interface Pos {
    /** 1 based, the way every editor counts. */
    line: number
    /** 1 based. */
    col: number
    /** Offset into the source, for a marker's length. */
    offset: number
}

export interface Token extends Pos {
    kind: TokenKind
    /** The text as written. For a number this is still the source spelling. */
    text: string
    /** Numbers only: the parsed value. */
    value?: number
}

/**
 * An error with a place in a file.
 *
 * Carries the location separately from the message so a caller that is not a
 * terminal (Monaco in the Play editor, esbuild in a build) can put a marker on
 * the right character instead of parsing a string.
 */
export class SLParseError extends SLError {
    readonly file: string
    readonly line: number
    readonly column: number
    readonly length: number

    constructor(message: string, file: string, pos: Pos, length = 1) {
        super(`${file}:${pos.line}:${pos.col}: ${message}`)
        this.name = "SLParseError"
        this.file = file
        this.line = pos.line
        this.column = pos.col
        this.length = length
    }
}

/**
 * Multi character punctuation, longest first.
 *
 * Order is load bearing: `<=` has to be tried before `<`, and `+=` before `+`,
 * or the lexer splits an operator in half and the parser reports something
 * baffling about the second half.
 */
const PUNCT = [
    "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
    "(", ")", "{", "}", "[", "]", ",", ";", ".", "+", "-", "*", "/", "%",
    "<", ">", "!", "?", ":", "=",
]

/** Directives that exist in HLSL and deliberately do not exist here. */
const DIRECTIVES = new Set([
    "pragma", "include", "define", "undef", "ifdef", "ifndef", "endif", "elif", "line",
])

const isDigit = (c: string) => c >= "0" && c <= "9"
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
const isIdentStart = (c: string) => c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c)

export function tokenize(source: string, file: string): Token[] {
    const out: Token[] = []
    let i = 0
    let line = 1
    let lineStart = 0
    const here = (): Pos => ({ line, col: i - lineStart + 1, offset: i })
    const fail = (message: string, at: Pos = here(), length = 1): never => {
        throw new SLParseError(message, file, at, length)
    }

    while (i < source.length) {
        const c = source[i]!

        if (c === "\n") { i++; line++; lineStart = i; continue }
        if (c === " " || c === "\t" || c === "\r") { i++; continue }

        if (c === "/" && source[i + 1] === "/") {
            while (i < source.length && source[i] !== "\n") i++
            continue
        }
        if (c === "/" && source[i + 1] === "*") {
            const open = here()
            i += 2
            for (;;) {
                if (i >= source.length) fail("this block comment is never closed", open, 2)
                if (source[i] === "*" && source[i + 1] === "/") { i += 2; break }
                if (source[i] === "\n") { line++; lineStart = i + 1 }
                i++
            }
            continue
        }

        if (c === "#") {
            const start = here()
            let j = i + 1
            while (j < source.length && isIdentPart(source[j]!)) j++
            const body = source.slice(i + 1, j)
            if (DIRECTIVES.has(body)) {
                fail(
                    `"#${body}" is a preprocessor directive, and a .sl file has no preprocessor. ` +
                    `A file is one fragment function and its declarations; shared code goes in a ` +
                    `function, which inlines.`,
                    start, body.length + 1,
                )
            }
            if (body.length === 0 || ![...body].every(isHex)) {
                fail(`"#${body}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`, start, body.length + 1)
            }
            out.push({ kind: "hex", text: "#" + body, ...start })
            i = j
            continue
        }

        if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
            const start = here()
            let j = i
            while (j < source.length && isDigit(source[j]!)) j++
            if (source[j] === ".") { j++; while (j < source.length && isDigit(source[j]!)) j++ }
            if (source[j] === "e" || source[j] === "E") {
                let k = j + 1
                if (source[k] === "+" || source[k] === "-") k++
                if (isDigit(source[k] ?? "")) { k++; while (k < source.length && isDigit(source[k]!)) k++; j = k }
            }
            const text = source.slice(i, j)
            // HLSL's float suffix. Accepted and dropped: `1.0f` is the same
            // number, and refusing it would only teach the author that this is
            // not quite the language they think it is.
            if (source[j] === "f" || source[j] === "F") {
                if (!isIdentPart(source[j + 1] ?? "")) j++
            }
            const value = Number(text)
            if (!Number.isFinite(value)) fail(`"${text}" is not a number`, start, text.length)
            out.push({ kind: "number", text, value, ...start })
            i = j
            continue
        }

        if (isIdentStart(c)) {
            const start = here()
            let j = i
            while (j < source.length && isIdentPart(source[j]!)) j++
            out.push({ kind: "ident", text: source.slice(i, j), ...start })
            i = j
            continue
        }

        const start = here()
        const p = PUNCT.find((op) => source.startsWith(op, i))
        if (p === undefined) fail(`"${c}" means nothing here`, start)
        out.push({ kind: "punct", text: p!, ...start })
        i += p!.length
    }

    out.push({ kind: "eof", text: "", line, col: i - lineStart + 1, offset: i })
    return out
}
