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
 * WHY THE SOURCE IS A STRING AND NOT A FILE. `onejs-unity` ships raw TypeScript
 * and its `sl` module runs inside a browser worker on play.onejs.com, where
 * there is no filesystem to read a `.sl` from, and the esbuild loader that
 * would inline one does not exist until Phase B. A template literal parses to
 * exactly the same unit, highlights the same in an editor, and needs nothing
 * from the bundler.
 */

import type { FuncDecl } from "./ast"
import { check } from "./check"
import { parseUnit } from "./parser"

export const PRELUDE_SOURCE = `
// Rotate a point about the origin. Translate first if you want another centre.
float2 rotate(float2 p, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return float2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Cartesian to polar: x is the angle in radians, y is the radius.
float2 polar(float2 p) {
    return float2(atan2(p.y, p.x), length(p));
}

// Signed distance to a circle at the origin. Negative inside.
float circle(float2 p, float r) {
    return length(p) - r;
}

// Signed distance to an axis aligned box of the given half extents.
float box(float2 p, float2 size) {
    float2 d = abs(p) - size;
    return length(max(d, 0)) + min(max(d.x, d.y), 0);
}

// Repeat a unit cell n times across the input, centred on zero in each cell.
float2 tile(float2 p, float n) {
    return frac(p * n) - 0.5;
}

// Inigo Quilez's cosine palette. Four float3s in, a colour out, no texture.
float3 palette(float t, float3 a, float3 b, float3 c, float3 d) {
    return a + b * cos(6.28318530718 * (c * t + d));
}
`

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
