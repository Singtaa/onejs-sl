/**
 * The standard library, written in the language itself.
 *
 * `Specs/SL_TEXT.md` 3.8: the things every shader pastes from somewhere, as
 * ordinary functions that inline, available in every file without an import. A
 * function declared in a file shadows a prelude function of the same name.
 *
 * ADDING TO IT COSTS A FUNCTION AND A TEST, NOT AN OPCODE IN THREE PLACES. That
 * is the whole argument for having a text language with inlining functions: a
 * library entry is source, so it lands in the VM, in generated HLSL and in the
 * hash by being ordinary code, and neither backend learns anything new.
 *
 * WHY THE SOURCE IS A STRING AND NOT A FILE. `onejs-sl` ships raw TypeScript
 * and runs inside a browser worker on play.onejs.com, where
 * there is no filesystem to read a `.sl` from, and the esbuild loader that
 * would inline one does not exist until Phase B. A template literal parses to
 * exactly the same unit, highlights the same in an editor, and needs nothing
 * from the bundler.
 */

import type { FuncDecl } from "./ast"
import { check } from "./check"
import { parseUnit } from "./parser"
import { PRELUDE_SOURCE } from "./prelude-source"

export { PRELUDE_SOURCE }

let cached: FuncDecl[] | null = null

/**
 * The prelude's functions, parsed and checked once.
 *
 * Checked against a unit with no uniforms and no textures of its own, which is
 * what it is: a parameter here called `p` must not collide with a uniform in
 * whichever file happens to use it.
 */
export function preludeFunctions(): FuncDecl[] {
    if (cached !== null) return cached
    const unit = parseUnit(PRELUDE_SOURCE, { file: "prelude.sl", requireMain: false })
    check(unit, [], { requireMain: false })
    cached = unit.funcs.map((fn) => ({ ...fn, prelude: true }))
    return cached
}
