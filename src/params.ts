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
