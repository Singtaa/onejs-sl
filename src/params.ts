/**
 * Parameter names, for an editor's completions and signature help: so it can
 * offer `lerp(x, y, s)` rather than "lerp takes 3 arguments".
 *
 * Metadata only. Nothing that checks or emits a program reads this file, and
 * only `onejs-sl/tables` imports it, so it cannot change what any program
 * compiles to. Each table is built by a call marked pure, so a bundle that
 * imports `onejs-sl/tables` for BUILTINS alone (the Play editor's parser) drops
 * all of it.
 *
 * The intrinsics carry the names the HLSL documentation gives them. Everything
 * the library implements is named as `lib/*.hlsl` writes it, read by the
 * translator into `src/lib/names.ts` when `npm run lib` runs, so there is no
 * second list of those to drift: a builtin that lowers to a library helper takes
 * that helper's names, and a shape's parameters are named after its function's
 * parameters, in the slots `sl_sdfDistance` passes them in.
 */

import { BUILTINS } from "./lang/builtins"
import { LIB_FUNCTIONS, SDF_CALLS } from "./lib/table"
import { LIB_PARAM_NAMES } from "./lib/names"
import { SL_SDF_PARAMS, SL_SDF_SHAPES, type SlSdfKind } from "./shapes"
import type { InputName } from "./ir"

/** One function of the helper library, as its source declares it. */
export interface LibSignature {
    name: string
    params: ReadonlyArray<{ name: string; type: string }>
    ret: string
}

/** Every function in the helper library, by `LIB_FUNCTIONS` index, overloads included. */
export const LIB_SIGNATURES: readonly LibSignature[] = /* @__PURE__ */ LIB_FUNCTIONS.map((f, i) => ({
    name: f.name,
    params: f.params.map((type, j) => ({ name: LIB_PARAM_NAMES[i]![j]!, type })),
    ret: f.ret,
}))

/** A library function's parameter names, the same for every overload of it. */
function namesOf(fn: string): readonly string[] {
    const found = LIB_SIGNATURES.filter((s) => s.name === fn).map((s) => s.params.map((p) => p.name).join(", "))
    if (found.length === 0) throw new Error(`the library has no ${fn}`)
    if (new Set(found).size > 1) throw new Error(`${fn}'s overloads name their parameters differently: ${found.join(" / ")}`)
    return found[0]!.split(", ")
}

/** The HLSL documentation's names. */
const INTRINSIC: Record<string, readonly string[]> = {
    sin: ["x"], cos: ["x"], tan: ["x"], asin: ["x"], acos: ["x"], exp: ["x"], log: ["x"], sqrt: ["x"],
    sign: ["x"], ceil: ["x"], round: ["x"], abs: ["x"], floor: ["x"], frac: ["x"], saturate: ["x"],
    rcp: ["x"], normalize: ["x"], length: ["x"],
    pow: ["x", "y"], min: ["x", "y"], max: ["x", "y"], clamp: ["x", "min", "max"], atan2: ["y", "x"],
    distance: ["x", "y"], dot: ["x", "y"], cross: ["x", "y"], reflect: ["i", "n"],
    lerp: ["x", "y", "s"], step: ["y", "x"], smoothstep: ["min", "max", "x"],
    tex2D: ["s", "t"],
}

/**
 * The library helper each builtin lowers to (`emitBody` calls it, and a test
 * checks that it does), and how many of its parameters an author writes: fbm's
 * third, the kind, is the opcode's own.
 */
export const LIBRARY: Readonly<Record<string, [string, number]>> = {
    toLinear: ["sl_toLinear", 1], hsv2rgb: ["sl_hsv2rgb", 1], luminance: ["sl_luminance", 1],
    noise: ["sl_valueNoise", 1], simplex: ["sl_simplex", 1], voronoi: ["sl_voronoi", 1],
    fbm: ["sl_fbm", 2], turbulence: ["sl_fbm", 2], ridged: ["sl_fbm", 2],
    // The point; the shape's own parameters are SL_SDF_PARAM_NAMES.
    sdf: ["sl_sdfDistance", 0],
}

/** The two the language defines itself, named as the EDSL's `sl.remap` and `sl.ramp` name theirs. */
const MACRO: Record<string, readonly string[]> = {
    remap: ["v", "fromMin", "fromMax", "toMin", "toMax"],
    // At least two stops, and as many more as `max` allows.
    ramp: ["t", "stop", "stop..."],
}

/**
 * Each builtin's parameter names, one per argument up to its `max`; those past
 * its `min` are optional. A name ending in `...` repeats up to `max`. `sdf` is
 * written `sdf.circle(p, r)`: its entry names the point, and the shape's own
 * parameters are `SL_SDF_PARAM_NAMES[shape]`.
 */
export const BUILTIN_PARAMS: Readonly<Record<string, readonly string[]>> = /* @__PURE__ */ Object.fromEntries(
    Object.keys(BUILTINS).map((name) => {
        const lib = LIBRARY[name]
        if (name === "sdf") return [name, [namesOf(lib![0])[1]!]]
        const names = INTRINSIC[name] ?? MACRO[name] ?? (lib && namesOf(lib[0]).slice(0, lib[1]))
        if (names === undefined) throw new Error(`builtin ${name} has no parameter names in params.ts`)
        return [name, names]
    }),
)

/**
 * Each shape's parameters, in the order `sdf.<shape>(p, ...)` takes them, named
 * after its function's: a vector parameter's components as `b.x`, `b.y`.
 */
export const SL_SDF_PARAM_NAMES: Readonly<Record<SlSdfKind, readonly string[]>> = /* @__PURE__ */ shapeNames()

function shapeNames(): Record<SlSdfKind, readonly string[]> {
    const out = {} as Record<SlSdfKind, readonly string[]>
    for (const shape of Object.keys(SL_SDF_SHAPES) as SlSdfKind[]) {
        const call = SDF_CALLS[SL_SDF_SHAPES[shape]]!
        // The function's first parameter is the point, which `sl_sdfDistance` passes itself.
        const fn = namesOf(call.fn).slice(1)
        const slots = new Array<string>(SL_SDF_PARAMS[shape])
        call.args.forEach((arg, i) => {
            const at = "int" in arg ? [arg.int] : arg
            at.forEach((slot, j) => { slots[slot] = at.length === 1 ? fn[i]! : `${fn[i]}.${"xyzw"[j]}` })
        })
        out[shape] = slots
    }
    return out
}

/**
 * One line on what each builtin does, for a completion's tooltip and the docs
 * page: the other half of `BUILTIN_PARAMS`, and named in its words, so a line
 * can say `s` and mean the third argument.
 */
export const BUILTIN_DOCS: Readonly<Record<string, string>> = {
    sin: "The sine of x, in radians.",
    cos: "The cosine of x, in radians.",
    tan: "The tangent of x, in radians.",
    asin: "The angle whose sine is x, with x clamped to -1 to 1.",
    acos: "The angle whose cosine is x, with x clamped to -1 to 1.",
    exp: "e raised to the power x.",
    log: "The natural logarithm of x.",
    sqrt: "The square root of x.",
    sign: "-1, 0 or 1, by the sign of x.",
    ceil: "x rounded up to a whole number.",
    round: "x rounded to the nearest whole number.",
    toLinear: "A colour as written, in sRGB, converted to the space the target holds; alpha is left alone.",
    abs: "x without its sign.",
    floor: "x rounded down to a whole number.",
    frac: "The part of x after the decimal point, 0 up to 1.",
    saturate: "x clamped to 0 to 1.",
    rcp: "1 / x.",
    normalize: "x scaled to length 1.",
    pow: "x raised to the power y.",
    min: "The smaller of x and y, per component.",
    max: "The larger of x and y, per component.",
    clamp: "x held between min and max.",
    atan2: "The angle of the point (x, y) from the positive x axis, in radians.",
    length: "The length of the vector x.",
    distance: "The distance between the points x and y.",
    dot: "The dot product of x and y.",
    cross: "The cross product of two float3s.",
    reflect: "The direction i reflected off a surface with normal n.",
    lerp: "Mixes x into y by s: x at 0, y at 1.",
    step: "0 where x is below y, else 1.",
    smoothstep: "0 below min, 1 above max, and a smooth curve between.",
    remap: "v moved from the range fromMin to fromMax into the range toMin to toMax.",
    hsv2rgb: "A colour from hue, saturation and value, each 0 to 1.",
    luminance: "How bright a colour looks, as one number.",
    noise: "Smooth value noise at p, about 0 to 1. Offset p for a different field.",
    simplex: "Simplex noise at p, about 0 to 1, with no grid pattern.",
    voronoi: "The distance from p to the nearest point of a jittered grid: cells.",
    fbm: "Value noise layered in octaves, 1 to 4 (3 when left out): clouds and terrain.",
    turbulence: "Simplex creases layered in octaves, 1 to 4: fire, smoke, marble.",
    ridged: "Turbulence made bright at its creases: ridges, lightning, cracks.",
    tex2D: "The colour of texture s at the uv t, with straight alpha.",
    sdf: "The signed distance from p to a shape, negative inside: `sdf.circle(p, r)`.",
    ramp: "t mapped through evenly spaced colour stops, from the first at 0 to the last at 1.",
}

/** One line on each input, for the same tooltips. */
export const INPUT_DOCS: Readonly<Record<InputName, string>> = {
    uv: "Where this pixel is in the element, 0 to 1 on each axis, with y up.",
    fragCoord: "Where this pixel is in the element, in pixels, with y up.",
    resolution: "The element's size in pixels.",
    time: "Seconds since the effect started.",
    aspect: "The element's width divided by its height.",
}
