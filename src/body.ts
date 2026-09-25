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

import { SLError, TYPE, type InputName, type Program, type SLNode, type SLType } from "./ir"
import { libClosure, LIB_FUNCTIONS } from "./lib"
import { LIB_HLSL } from "./lib/hlsl"
import { SLOP } from "./ops"

export interface BodyTarget {
    /** An expression for each input, e.g. `{ uv: "SL_UV", time: "SL_TIME", ... }`. */
    inputs: Record<InputName, string>
    /** The float4 holding a uniform slot. The body swizzles it down to the uniform's width. */
    uniform: (slot: number, name: string) => string
    /** A float4 sample of the texture in `slot` at the float2 expression `uv`, straight alpha. */
    sample: (slot: number, uv: string) => string
    /**
     * `linear`: `toLinear` calls `sl_toLinear`, for a host whose target holds
     * linear light. `gamma`: `toLinear` is the identity, decided here, so hex
     * colours and ramps stay as written.
     */
    colour: "gamma" | "linear"
    /** Assign the result to this local instead of returning it. */
    result?: string
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
    const lines: string[] = []
    const name = (ref: number) => `n${ref}`
    const emitted = new Set<number>()
    const uniforms = new Set<number>()
    const textures = new Set<number>()
    const helpers = new Set<string>()
    const helper = (fn: string) => { helpers.add(fn); return fn }
    /** A node at width `w`: a scalar repeated into a constructor, since HLSL refuses float3(x) and Metal x.xxx. */
    const splat = (ref: number, w: SLType) => (p.nodes[ref]!.type === TYPE.FLOAT && w > 1 ? ctor(w, Array(w).fill(name(ref))) : name(ref))

    const expr = (n: SLNode): string => {
        switch (n.k) {
            case "const":
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
                if (p.nodes[n.src]!.type === TYPE.FLOAT) return ctor(n.type, n.chans.map(() => name(n.src)))
                return `${name(n.src)}.${n.chans.map((c) => SWZ[c]).join("")}`
            case "call":
                return call(n)
        }
    }

    const call = (n: Extract<SLNode, { k: "call" }>): string => {
        const a = n.args.map(name)
        const t = n.type
        // Every argument of an element wise intrinsic at the result's width,
        // and every literal at its exact type. HLSL broadcasts a scalar and
        // converts an int; Metal finds max(float2, float) has no overload and
        // max(float, 0) is ambiguous, so the shared subset spells both out.
        const s = n.args.map((r) => splat(r, t))
        const k = (v: number, w: SLType) => ctor(w, Array(w).fill(lit(v)))
        const w0 = n.args.length > 0 ? p.nodes[n.args[0]!]!.type : TYPE.FLOAT
        const imm = n.imm ?? []
        switch (n.op) {
            case SLOP.COMPOSE: return ctor(n.type, a)

            case SLOP.ADD: return `(${a[0]} + ${a[1]})`
            case SLOP.SUB: return `(${a[0]} - ${a[1]})`
            case SLOP.MUL: return `(${a[0]} * ${a[1]})`
            case SLOP.DIV: return `(${a[0]} / ${a[1]})`
            case SLOP.MOD: return `fmod(${s[0]}, ${s[1]})`
            // abs on the base, matching the VM. pow of a negative base is
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

            // Of a scalar, Metal's are ambiguous, so what the VM computes for one
            // (its lanes past the width hold 0) is written out.
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
            // Matches the VM exactly, branchlessly, rather than using an if.
            // Two backends that pick differently here disagree on every edge
            // value.
            case SLOP.SELECT: return `lerp(${s[2]}, ${s[1]}, step(${k(0.5, t)}, ${s[0]}))`

            case SLOP.HSV2RGB: return `${helper("sl_hsv2rgb")}(${a[0]})`
            case SLOP.NOISE: return `${helper("sl_valueNoise")}(${a[0]})`
            case SLOP.SIMPLEX: return `${helper("sl_simplex")}(${a[0]})`
            case SLOP.FBM: return `${helper("sl_fbm")}(${a[0]}, ${Math.round(imm[0] ?? 3)}, ${Math.round(imm[1] ?? 0)})`
            case SLOP.TURBULENCE: return `${helper("sl_fbm")}(${a[0]}, ${Math.round(imm[0] ?? 3)}, 2)`
            case SLOP.RIDGED: return `${helper("sl_fbm")}(${a[0]}, ${Math.round(imm[0] ?? 3)}, 3)`
            case SLOP.SDF: {
                const id = Math.round(imm[0] ?? 0)
                const q = [imm[1] ?? 0, imm[2] ?? 0, imm[3] ?? 0, imm[4] ?? 0].map(lit)
                const r = [imm[5] ?? 0, imm[6] ?? 0].map(lit)
                return `${helper("sl_sdfDistance")}(${id}, ${a[0]}, float4(${q.join(", ")}), float2(${r.join(", ")}))`
            }
            case SLOP.VORONOI: return `${helper("sl_voronoi")}(${a[0]})`
            case SLOP.SAMPLE: {
                const slot = Math.round(imm[0] ?? 0)
                textures.add(slot)
                return target.sample(slot, a[0]!)
            }

            default:
                throw new SLError(
                    `the HLSL emitter has no case for opcode ${n.op}. A program using it would silently ` +
                    `differ between the VM and a compiled build, which is the one failure this design ` +
                    `cannot tolerate.`,
                )
        }
    }

    const walk = (ref: number): void => {
        if (emitted.has(ref)) return
        const n = p.nodes[ref]
        const deps = n.k === "swizzle" ? [n.src] : n.k === "call" ? n.args : []
        for (const d of deps) walk(d)
        emitted.add(ref)
        lines.push(`${indent}${HLSL_TYPE[n.type]} ${name(ref)} = ${expr(n)};`)
    }
    walk(p.result)
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
