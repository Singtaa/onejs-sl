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
 * A replacement for the characters an error marks, offered as one click.
 *
 * Only where the fix is certain: `mix` to `lerp` is, but `mod` to `%` is not
 * (GLSL's `mod` floors and `%` truncates), so `mod` gets the hint and no fix.
 */
export interface SLFix {
    /** What the editor's action says, as in "Replace mix with lerp". */
    title: string
    /** Text for the marked range, `offset` to `offset + length`. */
    replacement: string
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
    /** Into the source, where the marked range starts. */
    readonly offset: number
    readonly length: number
    /** The message alone, without `message`'s tag and its `file:line:col: `. */
    readonly text: string
    readonly fix?: SLFix

    constructor(message: string, file: string, pos: Pos, length = 1, fix?: SLFix) {
        super(`${file}:${pos.line}:${pos.col}: ${message}`)
        this.name = "SLParseError"
        this.file = file
        this.line = pos.line
        this.column = pos.col
        this.offset = pos.offset
        this.length = length
        this.text = message
        if (fix !== undefined) this.fix = fix
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
    return lex(source, file, false)
}

/** A token as `classify` sees it: comments kept, and whatever cannot be read marked rather than thrown. */
export interface LexedToken extends Omit<Token, "kind"> {
    kind: TokenKind | "comment" | "invalid"
    /** Characters it covers, which for `1.0f` is one more than its text. */
    length: number
}

/**
 * The scanner behind `tokenize` and `classify`.
 *
 * With `keep` off it is `tokenize`: comments dropped, the first unreadable
 * character thrown. With it on, nothing throws and nothing is dropped, because
 * a highlighter runs on every keystroke over text that is half typed.
 */
export function lex(source: string, file: string, keep: true): LexedToken[]
export function lex(source: string, file: string, keep: false): Token[]
export function lex(source: string, file: string, keep: boolean): Token[] | LexedToken[] {
    const out: LexedToken[] = []
    let i = 0
    let line = 1
    let lineStart = 0
    const here = (): Pos => ({ line, col: i - lineStart + 1, offset: i })
    /** Throws, or with `keep` records the span as invalid and lets the caller skip it. */
    const fail = (message: string, at: Pos = here(), length = 1): void => {
        if (!keep) throw new SLParseError(message, file, at, length)
        out.push({ kind: "invalid", text: source.slice(at.offset, at.offset + length), length, ...at })
    }
    const push = (t: Omit<LexedToken, "length">, end: number) => { out.push({ ...t, length: end - t.offset }) }

    while (i < source.length) {
        const c = source[i]!

        if (c === "\n") { i++; line++; lineStart = i; continue }
        if (c === " " || c === "\t" || c === "\r") { i++; continue }

        if (c === "/" && source[i + 1] === "/") {
            const start = here()
            while (i < source.length && source[i] !== "\n") i++
            if (keep) push({ kind: "comment", text: source.slice(start.offset, i), ...start }, i)
            continue
        }
        if (c === "/" && source[i + 1] === "*") {
            const open = here()
            i += 2
            for (;;) {
                if (i >= source.length) {
                    // Highlighted to the end as the comment it will become once closed.
                    if (!keep) fail("this block comment is never closed", open, 2)
                    break
                }
                if (source[i] === "*" && source[i + 1] === "/") { i += 2; break }
                if (source[i] === "\n") { line++; lineStart = i + 1 }
                i++
            }
            if (keep) push({ kind: "comment", text: source.slice(open.offset, i), ...open }, i)
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
            } else if (body.length === 0 || ![...body].every(isHex)) {
                fail(`"#${body}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`, start, body.length + 1)
            } else {
                push({ kind: "hex", text: "#" + body, ...start }, j)
            }
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
            else push({ kind: "number", text, value, ...start }, j)
            i = j
            continue
        }

        if (isIdentStart(c)) {
            const start = here()
            let j = i
            while (j < source.length && isIdentPart(source[j]!)) j++
            push({ kind: "ident", text: source.slice(i, j), ...start }, j)
            i = j
            continue
        }

        const start = here()
        const p = PUNCT.find((op) => source.startsWith(op, i))
        if (p === undefined) {
            fail(`"${c}" means nothing here`, start)
            i++
            continue
        }
        push({ kind: "punct", text: p, ...start }, i + p.length)
        i += p.length
    }

    out.push({ kind: "eof", text: "", line, col: i - lineStart + 1, offset: i, length: 0 })
    if (keep) return out
    // `tokenize`'s tokens are the ones it always returned, with no length.
    return out.map(({ length: _, ...t }) => t as Token)
}
