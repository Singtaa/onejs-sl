/**
 * `.sl`: the shader language as a file.
 *
 * Phase A of `Specs/SL_TEXT.md`. Source text in, the same `Program` the EDSL
 * records out. Pure TypeScript, no GPU and no filesystem, like everything else
 * in `sl/`, so it runs in the Play editor's worker as happily as in a build.
 *
 *     import { parse } from "onejs-unity/sl"
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
import { lower } from "./lower"
import { parseUnit, type ParseOptions } from "./parser"
import { preludeFunctions } from "./prelude"

export type { Checked } from "./check"
export type { ParseOptions } from "./parser"
export type {
    Expr, FuncDecl, Param, Stmt, TextureDecl, TypeName, UniformDecl, Unit,
} from "./ast"
export { TYPE_WIDTH } from "./ast"
export { SLParseError } from "./lexer"
export type { Pos, Token } from "./lexer"
export { tokenize } from "./lexer"
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
