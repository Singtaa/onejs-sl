/**
 * A program as the body of a function, in the HLSL and Metal shared subset,
 * for any host that supplies the frame around it.
 *
 * `Specs/SL_PACKAGE.md` section 4. OneJS's Unity shader (`hlsl.ts`) is one
 * frame over this and Magerie's compute kernel is another, so HLSL has one
 * emitter rather than one per host. A target says only what differs between
 * hosts: how an input, a uniform slot and a texture sample are spelled, and
 * whether `toLinear` is real.
 *
 * The subset is HLSL's spelling (`float2`, `lerp`, `frac`, `fmod`, `atan2`,
 * `saturate`), which Metal takes through a host's compatibility defines. `fmod`
 * is the same truncating remainder in both. Nothing here uses `mul`, `static`,
 * derivatives, or an overload the library does not resolve by width. The
 * library text `emitLibrary` prints is the same subset, translated from
 * `lib/*.hlsl` by `lib/translate.ts`.
 *
 * One local per reachable node, in order, named `n<index>` and unreadable on
 * purpose: generated code that looks hand written invites hand editing, and a
 * hand edit is lost the next time it is generated. One local per node also
 * gives common subexpression elimination for free.
 */

import { SLError, TYPE, valueAt, type InputName, type NodeRef, type Program, type SLKind, type SLType, type ValueNode } from "./ir"
import { libClosure, LIB_FUNCTIONS } from "./lib"
import { LIB_HLSL } from "./lib/hlsl"
import { SLOP } from "./ops"
import { inVaryingFlow, local, printBody, structure, type Syntax } from "./structure"

export interface BodyTarget {
    /** An expression for each input, e.g. `{ uv: "SL_UV", time: "SL_TIME", ... }`. */
    inputs: Record<InputName, string>
    /** The float4 holding a uniform slot. The body swizzles it down to the uniform's width. */
    uniform: (slot: number, name: string) => string
    /**
     * A float4 sample of the texture in `slot` at the float2 expression `uv`.
     *
     * The contract the body is written against, which is what OneJS's own hosts
     * do with the GPU's sampler:
     *
     * - **Straight alpha**, not premultiplied, in and out: the body never
     *   multiplies or divides by alpha, and its result is straight too.
     * - **In the space `colour` names.** With `linear`, rgb is linear light, so
     *   an sRGB texture is decoded before it is filtered, as an sRGB sampler
     *   does; with `gamma`, rgb is as stored.
     * - **Filtered and wrapped by the host.** The body does neither. OneJS's
     *   hosts, the generated shader and the web backends alike, use the
     *   bound texture's own filter and wrap modes, so a host that filters by
     *   hand draws the same picture by following the texture's settings.
     *
     * What becomes of the result is the host's: OneJS writes it to the target
     * as it is, and a host that composites premultiplied multiplies on write.
     */
    sample: (slot: number, uv: string) => string
    /**
     * A float4 sample of the texture in `slot` at `uv` from mip level `lod`, a
     * float expression: 0 is the full size texture, 1 half, and a fraction
     * blends two levels where the texture's filter does. Otherwise the same
     * contract as `sample`. `tex2Dlod` in a program; HLSL's
     * `tex2Dlod(s, float4(uv, 0, lod))` and Metal's `sample(s, uv, level(lod))`.
     */
    sampleLevel: (slot: number, uv: string, lod: string) => string
    /**
     * `linear`: `toLinear` calls `sl_toLinear`, for a host whose target holds
     * linear light. `gamma`: `toLinear` is the identity, decided here, so hex
     * colours and ramps stay as written. `sample` reads in the same space.
     */
    colour: "gamma" | "linear"
    /** Assign the result to this local instead of returning it. */
    result?: string
    /**
     * Put before every loop the body prints: `[loop]` for HLSL, so a compiler
     * does not try to unroll a loop whose turns are capped only by a counter.
     * Nothing for Metal, which has no such attribute.
     */
    loopAttribute?: string
    /** Put in front of every line. Default four spaces. */
    indent?: string
}

export interface Body {
    body: string
    uses: {
        /** Uniform slots the body reads, ascending. */
        uniforms: number[]
        /** Texture slots the body samples, ascending. */
        textures: number[]
        /** Library functions the body calls, sorted: `sl_fbm`, `sl_sdfDistance`, ... `emitLibrary` prints them. */
        helpers: string[]
    }
}

const HLSL_TYPE: Record<SLType, string> = { 1: "float", 2: "float2", 3: "float3", 4: "float4" }

/** A value's HLSL type, which Metal spells the same through a host's defines. */
function typeName(n: { type: SLType; kind?: SLKind }): string {
    if (n.kind === undefined) return HLSL_TYPE[n.type]
    return n.type === 1 ? n.kind : `${n.kind}${n.type}`
}

/** An int, uint or bool constant as a literal. */
function kindLit(kind: SLKind, v: number): string {
    if (kind === "bool") return v !== 0 ? "true" : "false"
    if (kind === "uint") return `${v >>> 0}u`
    return v < 0 ? `(${v})` : String(v)
}

/** The int range a float is held to on its way to an int, so every backend truncates the same. */
export const INT_LIMITS = { int: ["-2147483648.0", "2147483520.0"], uint: ["0.0", "4294967040.0"] } as const

/** A literal that survives a float32 round trip and never reads as an int. */
export function lit(n: number): string {
    if (!Number.isFinite(n)) throw new SLError(`cannot emit ${n} as a shader literal`)
    const s = Number.isInteger(n) ? n.toFixed(1) : String(n)
    return s
}

function ctor(type: SLType, parts: string[]): string {
    return type === TYPE.FLOAT ? parts[0] : `${HLSL_TYPE[type]}(${parts.join(", ")})`
}

const SWZ = "xyzw"

export function emitBody(p: Program, target: BodyTarget): Body {
    const indent = target.indent ?? "    "
    const name = local
    const shape = structure(p)
    const uniforms = new Set<number>()
    const textures = new Set<number>()
    const helpers = new Set<string>()
    const helper = (fn: string) => { helpers.add(fn); return fn }
    /** A node at width `w`: a scalar repeated into a constructor, since HLSL refuses float3(x) and Metal x.xxx. */
    /** A constant node's value, or null for anything computed. */
    const constantOf = (ref: number): number[] | null => {
        const c = p.nodes[ref]!
        return c.k === "const" ? c.v : null
    }
    const splat = (ref: number, w: SLType) => (valueAt(p.nodes, ref).type === TYPE.FLOAT && w > 1 ? ctor(w, Array(w).fill(name(ref))) : name(ref))

    const expr = (ref: NodeRef): string => {
        const n = valueAt(p.nodes, ref)
        switch (n.k) {
            case "const":
                if (n.kind !== undefined) return n.type === 1 ? kindLit(n.kind, n.v[0]!) : `${typeName(n)}(${n.v.map((v) => kindLit(n.kind!, v)).join(", ")})`
                return ctor(n.type, n.v.map(lit))
            case "input":
                return target.inputs[n.name]
            case "uniform": {
                const u = p.uniforms[n.slot]
                if (u === undefined) throw new SLError(`a node reads uniform slot ${n.slot}, which is not declared`)
                uniforms.add(n.slot)
                const v = target.uniform(n.slot, u.name)
                return n.type === TYPE.VEC4 ? v : `${v}.${SWZ.slice(0, n.type)}`
            }
            case "swizzle":
                // Metal has no swizzle of a scalar, so a scalar widens by constructor.
                if (valueAt(p.nodes, n.src).type === TYPE.FLOAT) {
                    return n.type === 1 ? name(n.src) : `${typeName(n)}(${n.chans.map(() => name(n.src)).join(", ")})`
                }
                return `${name(n.src)}.${n.chans.map((c) => SWZ[c]).join("")}`
            case "call":
                return call(n, ref)
            default:
                throw new SLError(`the HLSL emitter reached a ${n.k} as an expression`)
        }
    }

    const call = (n: Extract<ValueNode, { k: "call" }>, ref: NodeRef): string => {
        const a = n.args.map(name)
        const t = n.type
        // Every argument of an element wise intrinsic at the result's width,
        // and every literal at its exact type. HLSL broadcasts a scalar and
        // converts an int; Metal finds max(float2, float) has no overload and
        // max(float, 0) is ambiguous, so the shared subset spells both out.
        const s = n.args.map((r) => splat(r, t))
        const k = (v: number, w: SLType) => ctor(w, Array(w).fill(lit(v)))
        const w0 = n.args.length > 0 ? valueAt(p.nodes, n.args[0]!).type : TYPE.FLOAT
        const imm = n.imm ?? []
        const argKind = n.args.length > 0 ? valueAt(p.nodes, n.args[0]!).kind : undefined
        // IR 4: the ops that take ints, uints and bools, by the kinds involved.
        if (n.kind !== undefined || argKind !== undefined) {
            const zero = kindLit(n.kind ?? "int", 0)
            switch (n.op) {
                case SLOP.ADD: return `(${a[0]} + ${a[1]})`
                case SLOP.SUB: return `(${a[0]} - ${a[1]})`
                case SLOP.MUL: return `(${a[0]} * ${a[1]})`
                // Truncating, and 0 for a zero divisor, which HLSL leaves undefined.
                case SLOP.DIV: return `(${a[1]} == ${zero} ? ${zero} : ${a[0]} / ${a[1]})`
                case SLOP.MOD: return `(${a[1]} == ${zero} ? ${zero} : ${a[0]} % ${a[1]})`
                case SLOP.NEG: return `(-${a[0]})`
                case SLOP.MIN: return `min(${a[0]}, ${a[1]})`
                case SLOP.MAX: return `max(${a[0]}, ${a[1]})`
                case SLOP.ABS: return `abs(${a[0]})`
                case SLOP.CLAMP: return `clamp(${a[0]}, ${a[1]}, ${a[2]})`
            }
        }
        switch (n.op) {
            case SLOP.COMPOSE: return n.kind === undefined ? ctor(n.type, a) : `${typeName(n)}(${a.join(", ")})`
            case SLOP.CAST: {
                const from = valueAt(p.nodes, n.args[0]!).kind
                if (n.kind === undefined) return `${typeName(n)}(${a[0]})`
                if (n.kind === "bool") return `(${a[0]} != ${from === undefined ? "0.0" : kindLit(from, 0)})`
                if (from === undefined) {
                    const [lo, hi] = INT_LIMITS[n.kind]
                    return `${n.kind}(clamp(${a[0]}, ${lo}, ${hi}))`
                }
                return `${n.kind}(${a[0]})`
            }
            case SLOP.LT: return `(${a[0]} < ${a[1]})`
            case SLOP.LE: return `(${a[0]} <= ${a[1]})`
            case SLOP.GT: return `(${a[0]} > ${a[1]})`
            case SLOP.GE: return `(${a[0]} >= ${a[1]})`
            case SLOP.EQ: return `(${a[0]} == ${a[1]})`
            case SLOP.NE: return `(${a[0]} != ${a[1]})`
            case SLOP.AND: return `(${a[0]} && ${a[1]})`
            case SLOP.OR: return `(${a[0]} || ${a[1]})`
            case SLOP.NOT: return `(!${a[0]})`
            case SLOP.BIT_AND: return `(${a[0]} & ${a[1]})`
            case SLOP.BIT_OR: return `(${a[0]} | ${a[1]})`
            case SLOP.BIT_XOR: return `(${a[0]} ^ ${a[1]})`
            case SLOP.BIT_NOT: return `(~${a[0]})`
            case SLOP.SHL: return `(${a[0]} << ${a[1]})`
            case SLOP.SHR: return `(${a[0]} >> ${a[1]})`
            case SLOP.CHOOSE: return `(${a[0]} ? ${a[1]} : ${a[2]})`

            case SLOP.ADD: return `(${a[0]} + ${a[1]})`
            case SLOP.SUB: return `(${a[0]} - ${a[1]})`
            case SLOP.MUL: return `(${a[0]} * ${a[1]})`
            case SLOP.DIV: return `(${a[0]} / ${a[1]})`
            case SLOP.MOD: return `fmod(${s[0]}, ${s[1]})`
            // abs on the base, matching the web emitters. pow of a negative base is
            // undefined in HLSL and the backends must be undefined in the same
            // direction.
            case SLOP.POW: return `pow(abs(${s[0]}), ${s[1]})`
            case SLOP.NEG: return `(-${a[0]})`
            case SLOP.RECIP: return `(1.0 / ${a[0]})`

            case SLOP.SIN: return `sin(${a[0]})`
            case SLOP.COS: return `cos(${a[0]})`
            case SLOP.TAN: return `tan(${a[0]})`
            case SLOP.ASIN: return `asin(clamp(${a[0]}, ${k(-1, t)}, ${k(1, t)}))`
            case SLOP.ACOS: return `acos(clamp(${a[0]}, ${k(-1, t)}, ${k(1, t)}))`
            case SLOP.ATAN2: return `atan2(${s[0]}, ${s[1]})`
            case SLOP.EXP: return `exp(${a[0]})`
            case SLOP.LOG: return `log(max(${a[0]}, ${k(1e-8, t)}))`
            case SLOP.SQRT: return `sqrt(max(${a[0]}, ${k(0, t)}))`
            case SLOP.ABS: return `abs(${a[0]})`
            case SLOP.SIGN: return `sign(${a[0]})`
            case SLOP.FLOOR: return `floor(${a[0]})`
            case SLOP.CEIL: return `ceil(${a[0]})`
            case SLOP.ROUND: return `round(${a[0]})`
            case SLOP.FRACT: return `frac(${a[0]})`
            case SLOP.MIN: return `min(${s[0]}, ${s[1]})`
            case SLOP.MAX: return `max(${s[0]}, ${s[1]})`
            case SLOP.CLAMP: return `clamp(${s[0]}, ${s[1]}, ${s[2]})`
            case SLOP.SATURATE: return `saturate(${a[0]})`

            // Of a scalar, Metal's are ambiguous, so the scalar case is written
            // out.
            case SLOP.LENGTH: return w0 === 1 ? `abs(${a[0]})` : `length(${a[0]})`
            case SLOP.DISTANCE: return w0 === 1 ? `abs(${a[0]} - ${a[1]})` : `distance(${a[0]}, ${a[1]})`
            case SLOP.DOT: return w0 === 1 ? `(${a[0]} * ${a[1]})` : `dot(${a[0]}, ${a[1]})`
            case SLOP.CROSS: return `cross(${a[0]}, ${a[1]})`
            case SLOP.NORMALIZE: return w0 === 1 ? `(${a[0]} / abs(${a[0]}))` : `normalize(${a[0]})`
            case SLOP.REFLECT: return w0 === 1 ? `(${a[0]} - 2.0 * ${a[1]} * ${a[0]} * ${a[1]})` : `reflect(${a[0]}, ${a[1]})`
            case SLOP.LUMINANCE: return `${helper("sl_luminance")}(${a[0]}.rgb)`
            case SLOP.TO_LINEAR: return target.colour === "linear" ? `${helper("sl_toLinear")}(${a[0]})` : a[0]!

            case SLOP.MIX: return `lerp(${s[0]}, ${s[1]}, ${s[2]})`
            case SLOP.STEP: return `step(${s[0]}, ${s[1]})`
            case SLOP.SMOOTHSTEP: return `smoothstep(${s[0]}, ${s[1]}, ${s[2]})`
            // Branchless, as the web emitters do it, rather than using an if.
            // Two backends that pick differently here disagree on every edge
            // value.
            case SLOP.SELECT: return `lerp(${s[2]}, ${s[1]}, step(${k(0.5, t)}, ${s[0]}))`

            case SLOP.HSV2RGB: return `${helper("sl_hsv2rgb")}(${a[0]})`
            case SLOP.NOISE: return `${helper("sl_valueNoise")}(${a[0]})`
            case SLOP.SIMPLEX: return `${helper("sl_simplex")}(${a[0]})`
            case SLOP.FBM:
            case SLOP.TURBULENCE:
            case SLOP.RIDGED: {
                // The count rounded here and held to 1 to 4 by sl_fbm; a constant
                // one is the whole number it is. fbm's kind is the one immediate.
                const c = constantOf(n.args[1]!)
                const count = c !== null ? String(Math.round(c[0]!)) : `int(floor(${a[1]} + 0.5))`
                const kind = n.op === SLOP.TURBULENCE ? 2 : n.op === SLOP.RIDGED ? 3 : Math.round(imm[0] ?? 0)
                return `${helper("sl_fbm")}(${a[0]}, ${count}, ${kind})`
            }
            case SLOP.SDF: {
                const id = Math.round(imm[0] ?? 0)
                return `${helper("sl_sdfDistance")}(${id}, ${a[0]}, ${a[1]}, ${a[2]})`
            }
            case SLOP.VORONOI: return `${helper("sl_voronoi")}(${a[0]})`
            case SLOP.SAMPLE: {
                const slot = Math.round(imm[0] ?? 0)
                textures.add(slot)
                // Where pixels part ways there are no neighbours to take a mip
                // level from, so every backend samples level 0 there (`structure.ts`).
                return inVaryingFlow(shape, ref) ? target.sampleLevel(slot, a[0]!, "0.0") : target.sample(slot, a[0]!)
            }
            case SLOP.SAMPLE_LOD: {
                const slot = Math.round(imm[0] ?? 0)
                textures.add(slot)
                return target.sampleLevel(slot, a[0]!, a[1]!)
            }

            default:
                throw new SLError(
                    `the HLSL emitter has no case for opcode ${n.op}. A program using it would silently ` +
                    `differ between a Unity build and a browser, which is the one failure this design ` +
                    `cannot tolerate.`,
                )
        }
    }

    const typeOf = (ref: NodeRef) => typeName(valueAt(p.nodes, ref))
    const syntax: Syntax = {
        value: (ref, e) => `${typeOf(ref)} ${name(ref)} = ${e};`,
        mutable: (n, like, init) => `${typeOf(like)} ${n}${init === undefined ? "" : ` = ${init}`};`,
        counter: (n) => `int ${n} = 0;`,
        assign: (n, v) => `${n} = ${v};`,
        increment: (n) => `${n}++;`,
        ifOpen: (c) => `if (${c}) {`,
        elseOpen: "} else {",
        close: "}",
        loopOpen: `${target.loopAttribute === undefined ? "" : target.loopAttribute + " "}for (;;) {`,
        breakUnless: (c, turns, max) => `if (!(${c}) || ${turns} >= ${max}) break;`,
    }
    const lines = printBody(p, shape, syntax, expr, indent)
    lines.push(target.result === undefined
        ? `${indent}return ${name(p.result)};`
        : `${indent}${target.result} = ${name(p.result)};`)

    const sorted = (s: Set<number>) => [...s].sort((x, y) => x - y)
    return {
        body: lines.join("\n"),
        uses: { uniforms: sorted(uniforms), textures: sorted(textures), helpers: [...helpers].sort() },
    }
}

/**
 * The library functions a body calls (`Body.uses.helpers`) and everything they
 * call, in the same subset and in dependency order, with the colour branch the
 * target asked for: the text a host puts ahead of the function it wraps the
 * body in.
 *
 * Separate from `emitBody` because OneJS's own frame never needs it: the Unity
 * shader includes `SLCommon.cginc`, the library's source, and a bundle that
 * prints only Unity shaders should not carry the library's text as well.
 */
export function emitLibrary(helpers: readonly string[], colour: "gamma" | "linear"): string {
    const wanted = new Set(helpers)
    const named = LIB_FUNCTIONS.flatMap((f, i) => (wanted.has(f.name) ? [i] : []))
    if (named.length < wanted.size) {
        const known = new Set(LIB_FUNCTIONS.map((f) => f.name))
        throw new SLError(`the library has no ${[...wanted].filter((h) => !known.has(h)).join(", ")}`)
    }
    return libClosure(named).map((i) => {
        const text = LIB_HLSL[i]!
        return (typeof text === "string" ? text : text[colour]).trim()
    }).join("\n")
}
