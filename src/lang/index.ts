/**
 * `.sl`: the shader language as a file.
 *
 * Phase A of `Specs/SL_TEXT.md`. Source text in, the same `Program` the EDSL
 * records out. Pure TypeScript, no GPU and no filesystem, like everything else
 * in `sl/`, so it runs in the Play editor's worker as happily as in a build.
 *
 *     import { parse } from "onejs-sl"
 *
 *     const plasma = parse(source, { file: "plasma.sl" })
 *     //    ^ a Program: encode() it, emit HLSL from it, hash it
 *
 * The parser is not a second authoring surface with its own semantics. It
 * lowers through the EDSL, so a `.sl` file and the `sl.program(...)` an author
 * would otherwise have written produce the same graph and therefore the same
 * hash, the same shader and the same pixels. `lang/parity.test.ts` is that
 * claim, written down.
 */

import type { Program } from "../ir"
import { check, type Checked } from "./check"
import { SLParseError } from "./lexer"
import { lower } from "./lower"
import { parseUnit, type ParseOptions } from "./parser"
import { preludeFunctions } from "./prelude"

export type { Checked } from "./check"
export type { ParseOptions } from "./parser"
export type {
    Expr, FuncDecl, Param, Stmt, TextureDecl, TypeName, UniformDecl, Unit,
} from "./ast"
export { TYPE_WIDTH } from "./ast"
export { SLParseError }
export type { Pos, SLFix, Token } from "./lexer"
export { tokenize } from "./lexer"
export { classify } from "./classify"
export type { SLClassifiedToken, SLTokenClass } from "./classify"
export { SL_KEYWORDS, SL_TYPES } from "./words"
export { parseUnit } from "./parser"
export { PRELUDE_SOURCE, preludeFunctions } from "./prelude"
export { BUILTINS, NOT_YET } from "./builtins"

/** Source text to a recorded program. Throws `SLParseError` with a line and a column. */
export function parse(source: string, options: ParseOptions = {}): Program {
    return lower(analyze(source, options))
}

/**
 * Everything `parse` learns about a file, without building the graph.
 *
 * What the Play editor's completion and diagnostics want (Phase C): the
 * declarations, the functions and their signatures, and the same errors, for a
 * file that may be half typed. Kept here rather than reached for through
 * `parseUnit` + `check` so a caller has one entry point to hold on to.
 */
export function analyze(source: string, options: ParseOptions = {}): Checked {
    const unit = parseUnit(source, options)
    return check(unit, preludeFunctions(), { requireMain: options.requireMain })
}

/**
 * Every error in a file, in source order, for an editor checking as it is
 * typed. Empty when the file compiles. Never throws a `SLParseError`.
 *
 * Errors of one kind at a time, the first kind the file has: what cannot be
 * read, then names and shapes (`check`), then types and widths (lowering).
 * Each stage carries on past an error, a statement or a declaration at a time;
 * a later stage runs only on a file the earlier ones passed, since its errors
 * about a file with a hole in it would be about the hole.
 */
export function diagnose(source: string, options: ParseOptions = {}): SLParseError[] {
    const errors: SLParseError[] = []
    try {
        const unit = parseUnit(source, { ...options, errors })
        if (errors.length === 0) {
            const checked = check(unit, preludeFunctions(), { requireMain: options.requireMain, errors })
            if (errors.length === 0) lower(checked, errors)
        }
    } catch (e) {
        // The lexer's, which stops at the first character it cannot read.
        if (!(e instanceof SLParseError)) throw e
        errors.push(e)
    }
    // An error in a loop body or an inlined function is found once per copy.
    const seen = new Set<string>()
    return errors
        .filter((e) => {
            const key = `${e.offset}:${e.text}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
        .sort((a, b) => a.offset - b.offset)
}
