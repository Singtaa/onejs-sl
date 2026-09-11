/**
 * What each builtin name does, keyed by the name `ops.ts` gives it.
 *
 * Phase A of `Specs/SL_TEXT.md` 3.4. THE NAMES ARE NOT WRITTEN HERE. Every key
 * comes from `SL_HLSL`, the one column the EDSL and the parser share, so a new
 * op cannot arrive with a spelling in one surface and not the other. A contract
 * test (`lang/surface.test.ts`) walks the same table and refuses an op that has
 * neither a lowering nor a stated reason to lack one.
 *
 * Everything lowers through the EDSL rather than through the Builder. That is
 * the property the parity test rests on: `sin(x)` in a file and `sl.sin(x)` in
 * TypeScript are the same call, so they cannot produce different graphs.
 */

import { SLError } from "../ir"
import { SLOP, SL_HLSL, SL_UNIMPLEMENTED } from "../ops"
import * as sl from "../sl"
import type { Num, Val } from "../sl"

/**
 * How a builtin consumes its arguments.
 *
 * `value` is the ordinary case: every argument is a value and the lowering gets
 * them as `Num`, so a plain literal stays a literal and broadcasts the way the
 * EDSL broadcasts it. `special` names the three whose arguments are not values
 * at all: a texture slot, a shape's constant parameters, a list of colour
 * stops. Those are lowered in `lower.ts`, where the AST is still in reach.
 */
export interface Builtin {
    op: number
    kind: "value" | "special"
    min: number
    max: number
    /** Present for `kind: "value"`. */
    lower?: (args: Num[]) => Val
}

const name = (op: number): string => {
    const call = SL_HLSL[op]?.call
    if (call === undefined) throw new Error(`opcode ${op} has no call spelling in SL_HLSL`)
    return call
}

/** A plain number where a value is needed, for the ops whose first operand must be one. */
const val = (v: Num): Val => (typeof v === "number" ? (sl.float(v) as unknown as Val) : v)

/**
 * Asserts an operand's width where the two backends would otherwise part ways.
 *
 * The VM keeps every value in a float4 register and writes `a.xy` or `a.rgb`
 * whatever it was handed, so a noise call on a float3 quietly works there. The
 * generated HLSL passes the real type to `sl_valueNoise(float2)` and either
 * truncates with a warning or fails to compile. Neither outcome is one an
 * author should discover after ejecting, so the narrow ops say so here.
 */
function widthMustBe(fn: string, v: Num, want: 1 | 2 | 3 | 4, why: string): Val {
    const got = typeof v === "number" ? 1 : v.width
    if (got !== want) {
        throw new SLError(`${fn} takes ${why}, and this is a ${WIDTH_NAME[got]}`)
    }
    return val(v)
}

const WIDTH_NAME: Record<number, string> = { 1: "float", 2: "float2", 3: "float3", 4: "float4" }

/** A colour operand: three components, or four with alpha along for the ride. */
function colourOperand(fn: string, v: Num): Val {
    const got = typeof v === "number" ? 1 : v.width
    if (got < 3) throw new SLError(`${fn} takes a colour, so a float3 or a float4, and this is a ${WIDTH_NAME[got]}`)
    return val(v)
}

const table: Record<string, Builtin> = {}

function value(op: number, min: number, max: number, lower: (args: Num[]) => Val): void {
    table[name(op)] = { op, kind: "value", min, max, lower }
}

function special(op: number, min: number, max: number): void {
    table[name(op)] = { op, kind: "special", min, max }
}

/** Width preserving one argument ops, which the EDSL exposes as free functions. */
const UNARY: Array<[number, (v: Num) => Val]> = [
    [SLOP.SIN, (v) => sl.sin(val(v))],
    [SLOP.COS, (v) => sl.cos(val(v))],
    [SLOP.TAN, (v) => sl.tan(val(v))],
    [SLOP.ASIN, (v) => sl.asin(val(v))],
    [SLOP.ACOS, (v) => sl.acos(val(v))],
    [SLOP.EXP, (v) => sl.exp(val(v))],
    [SLOP.LOG, (v) => sl.log(val(v))],
    [SLOP.SQRT, (v) => sl.sqrt(val(v))],
    [SLOP.SIGN, (v) => sl.sign(val(v))],
    [SLOP.CEIL, (v) => sl.ceil(val(v))],
    [SLOP.ROUND, (v) => sl.round(val(v))],
    [SLOP.TO_LINEAR, (v) => sl.toLinear(val(v))],
    [SLOP.ABS, (v) => val(v).abs()],
    [SLOP.FLOOR, (v) => val(v).floor()],
    [SLOP.FRACT, (v) => val(v).fract()],
    [SLOP.SATURATE, (v) => val(v).saturate()],
    [SLOP.RECIP, (v) => val(v).recip()],
    [SLOP.NORMALIZE, (v) => val(v).normalize()],
]
for (const [op, fn] of UNARY) value(op, 1, 1, (a) => fn(a[0]!))

value(SLOP.POW, 2, 2, (a) => val(a[0]!).pow(a[1]!))
value(SLOP.MIN, 2, 2, (a) => val(a[0]!).min(a[1]!))
value(SLOP.MAX, 2, 2, (a) => val(a[0]!).max(a[1]!))
value(SLOP.CLAMP, 3, 3, (a) => val(a[0]!).clamp(a[1]!, a[2]!))
value(SLOP.ATAN2, 2, 2, (a) => sl.atan2(a[0]!, a[1]!))

value(SLOP.LENGTH, 1, 1, (a) => val(a[0]!).length())
value(SLOP.DISTANCE, 2, 2, (a) => val(a[0]!).distance(a[1]!))
value(SLOP.DOT, 2, 2, (a) => val(a[0]!).dot(a[1]!))
value(SLOP.CROSS, 2, 2, (a) => sl.cross(val(a[0]!) as never, val(a[1]!) as never))
value(SLOP.REFLECT, 2, 2, (a) => sl.reflect(val(a[0]!) as never, val(a[1]!) as never))

value(SLOP.MIX, 3, 3, (a) => sl.mix(a[0]!, a[1]!, a[2]!))
value(SLOP.STEP, 2, 2, (a) => sl.step(a[0]!, a[1]!))
value(SLOP.SMOOTHSTEP, 3, 3, (a) => sl.smoothstep(a[0]!, a[1]!, a[2]!))
value(SLOP.REMAP, 5, 5, (a) => sl.remap(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!))

value(SLOP.HSV2RGB, 1, 1, (a) => sl.hsv2rgb(widthMustBe("hsv2rgb", a[0]!, 3, "a float3 of hue, saturation and value") as never))
value(SLOP.LUMINANCE, 1, 1, (a) => sl.luminance(colourOperand("luminance", a[0]!)))

value(SLOP.NOISE, 1, 1, (a) => sl.noise(point("noise", a[0]!) as never))
value(SLOP.SIMPLEX, 1, 1, (a) => sl.simplex(point("simplex", a[0]!) as never))
value(SLOP.VORONOI, 1, 1, (a) => sl.voronoi(point("voronoi", a[0]!) as never))
// The octave count is an immediate, so it has to be a number at parse time.
// `lower.ts` folds constants before it gets here and rejects anything else with
// a message that says why, rather than letting this cast be the error.
value(SLOP.FBM, 1, 2, (a) => sl.fbm(point("fbm", a[0]!) as never, octaves("fbm", a[1])))
value(SLOP.TURBULENCE, 1, 2, (a) => sl.turbulence(point("turbulence", a[0]!) as never, octaves("turbulence", a[1])))
value(SLOP.RIDGED, 1, 2, (a) => sl.ridged(point("ridged", a[0]!) as never, octaves("ridged", a[1])))

/** Every field is sampled at a float2. */
function point(fn: string, v: Num): Val {
    return widthMustBe(fn, v, 2, "a float2 to sample at")
}

special(SLOP.SAMPLE, 2, 2)
special(SLOP.SDF, 1, 5)
special(SLOP.RAMP, 3, 64)

function octaves(fn: string, v: Num | undefined): number {
    if (v === undefined) return 3
    if (typeof v !== "number") {
        throw new SLError(
            `${fn}'s octave count is baked into the instruction, so it has to be a constant. ` +
            `A uniform or a computed value cannot change how many octaves the shader runs.`,
        )
    }
    return v
}

export const BUILTINS: Readonly<Record<string, Builtin>> = table

/**
 * Names that exist in the opcode table and cannot be written yet, with why.
 *
 * Separate from "unknown identifier" on purpose: an author who writes
 * `rgb2hsv` has read the right documentation and deserves the real answer.
 */
export const NOT_YET: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(SL_UNIMPLEMENTED)
        .filter(([op]) => SL_HLSL[Number(op)]?.call !== undefined && table[SL_HLSL[Number(op)]!.call!] === undefined)
        .map(([op, why]) => [SL_HLSL[Number(op)]!.call!, why]),
)
