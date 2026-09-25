/**
 * The helper library every backend draws from: value and simplex noise, the
 * octave kinds, voronoi, hsv2rgb, toLinear and the 42 distance shapes.
 *
 * Its one source is `lib/*.hlsl` in this package. OneJS's `.cginc` files are
 * generated copies of it, and the tables here (`table.ts`, `glsl.ts`,
 * `wgsl.ts`, `hlsl.ts`) are its translations, printed at build time by
 * `lib/translate.ts`. Nothing here parses shader text; it only picks entries.
 */

import { LIB_FUNCTIONS } from "./table"

export { LIB_FUNCTIONS, SDF_CALLS } from "./table"
export type { LibFunction, SdfCall } from "./types"

/**
 * A function's index by name, and by parameter types when the name is
 * overloaded (`sl_toLinear`, `onejsFbm`). Throws for a name the library does
 * not have, since an emitter asking for one is a bug in the emitter.
 */
export function libIndex(name: string, params?: readonly string[]): number {
    const hits: number[] = []
    LIB_FUNCTIONS.forEach((f, i) => {
        if (f.name === name && (params === undefined || sameList(f.params, params))) hits.push(i)
    })
    if (hits.length !== 1) {
        const sig = params === undefined ? name : `${name}(${params.join(", ")})`
        throw new Error(`internal: the shader library has ${hits.length === 0 ? "no" : "more than one"} ${sig}`)
    }
    return hits[0]!
}

/** Every index named, with everything each one calls, in library order (which is dependency order). */
export function libClosure(indices: Iterable<number>): number[] {
    const want = new Set<number>()
    const add = (i: number) => {
        if (want.has(i)) return
        want.add(i)
        for (const d of LIB_FUNCTIONS[i]!.deps) add(d)
    }
    for (const i of indices) add(i)
    return [...want].sort((a, b) => a - b)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}
