/**
 * The web backends: prints a program as GLSL ES 3.00 or WGSL, for a browser to
 * compile at runtime on Unity's own graphics device.
 *
 * Unity cannot compile a shader in a built game, so a native build ships the
 * shaders the editor generated. A browser can compile, and the Play container
 * runs on WebGPU with WebGL2 behind it, so a program becomes WGSL on one and
 * GLSL ES on the other. The host that compiles and draws these lives in
 * OneJS (`Plugins/WebGL/OneJSSLWeb.jslib`); this file only prints them.
 *
 * Structurally the HLSL emitter again: one local per reachable node, in order,
 * named `n<index>`. What differs is the contract with the host, which is fixed
 * and the same for both languages:
 *
 *   sl_Res   (target width, target height, seconds, 0)
 *   sl_Opt   (1 in a Linear colour space project else 0, 1 to flip uv.y, 0, 0)
 *   sl_U[16] uniform slots, each a vec4, in the program's slot order
 *   textures by slot: GLSL `sl_Tex<slot>`; WGSL `sl_tex<slot>` at binding
 *            2 + 2 * slot with its own sampler `sl_samp<slot>` at 1 + 2 * slot,
 *            all in group 0 beside the frame block at binding 0. Only the
 *            slots the program samples are declared.
 *
 * WGSL also carries its vertex stage (`sl_vs`, a full-target triangle from the
 * vertex index) so one module is one pipeline; the GLSL host supplies its own.
 */

import { INT_LIMITS } from "./body"
import { SLError, TYPE, valueAt, type NodeRef, type Program, type SLKind, type SLType, type ValueNode } from "./ir"
import { inVaryingFlow, local, printBody, structure, type Syntax } from "./structure"
import { libClosure, libIndex, LIB_FUNCTIONS, SDF_CALLS } from "./lib"
import { LIB_GLSL } from "./lib/glsl"
import { LIB_WGSL } from "./lib/wgsl"
import { INPUT_ID, SLOP, UNIFORM_SLOTS } from "./ops"

export type WebLanguage = "glsl" | "wgsl"

/** Uniform slots the host always provides, so every program shares one layout. */
export const WEB_UNIFORM_SLOTS = UNIFORM_SLOTS

export function emitGLSL(p: Program): string {
    return emitWeb(p, "glsl")
}

export function emitWGSL(p: Program): string {
    return emitWeb(p, "wgsl")
}

function emitWeb(p: Program, lang: WebLanguage): string {
    const W = lang === "wgsl"
    const need = new Set<number>()
    const smoothsteps = new Set<SLType>()
    const sampled = new Set<number>()
    const shape = structure(p)
    const T = (t: SLType) => (W ? (t === 1 ? "f32" : `vec${t}f`) : t === 1 ? "float" : `vec${t}`)
    /** A value's type in this language, its kind included. */
    const typeName = (n: { type: SLType; kind?: SLKind }): string => {
        if (n.kind === undefined) return T(n.type)
        const scalar = W ? { int: "i32", uint: "u32", bool: "bool" }[n.kind] : n.kind
        if (n.type === 1) return scalar
        return W ? `vec${n.type}<${scalar}>` : `${{ int: "i", uint: "u", bool: "b" }[n.kind]}vec${n.type}`
    }
    const kindLit = (kind: SLKind, v: number): string => {
        if (kind === "bool") return v !== 0 ? "true" : "false"
        if (kind === "uint") return `${v >>> 0}u`
        const i = W ? `${v}i` : String(v)
        return v < 0 ? `(${i})` : i
    }
    const typeOf = (ref: number) => valueAt(p.nodes, ref).type

    /** A node's value widened to `t` when it is a scalar and `t` is not. */
    const splat = (ref: number, t: SLType) => (typeOf(ref) === 1 && t > 1 ? `${T(t)}(n${ref})` : `n${ref}`)
    /** A literal at width `t`. */
    const k = (v: number, t: SLType) => (t > 1 ? `${T(t)}(${lit(v)})` : lit(v))

    const expr = (ref: NodeRef): string => {
        const n = valueAt(p.nodes, ref)
        switch (n.k) {
            case "const":
                if (n.kind !== undefined) return n.type === 1 ? kindLit(n.kind, n.v[0]!) : `${typeName(n)}(${n.v.map((v) => kindLit(n.kind!, v)).join(", ")})`
                return n.type === 1 ? lit(n.v[0]) : `${T(n.type)}(${n.v.map(lit).join(", ")})`
            case "input": {
                const res = W ? "sl.res" : "sl_Res"
                switch (INPUT_ID[n.name]) {
                    case 0: return "sl_uv"
                    case 1: return `(sl_uv * ${res}.xy)`
                    case 2: return `${res}.xy`
                    case 3: return `${res}.z`
                    default: return `(${res}.x / max(${res}.y, 1.0))`
                }
            }
            case "uniform": {
                const u = W ? `sl.u[${n.slot}]` : `sl_U[${n.slot}]`
                return n.type === TYPE.VEC4 ? u : `${u}.${"xyzw".slice(0, n.type)}`
            }
            case "swizzle": {
                // A scalar has one component and no swizzle in either language.
                if (typeOf(n.src) === 1) return n.type === 1 ? `n${n.src}` : `${typeName(n)}(n${n.src})`
                return `n${n.src}.${n.chans.map((c) => "xyzw"[c]).join("")}`
            }
            case "call": return call(n, ref)
            default: throw new SLError(`the ${lang.toUpperCase()} emitter reached a ${n.k} as an expression`)
        }
    }

    const call = (n: Extract<ValueNode, { k: "call" }>, ref: NodeRef): string => {
        const t = n.type
        const a = n.args.map((r) => `n${r}`)
        // Every argument at the result's width, for the element wise ops. WGSL
        // refuses min(vec2f, f32) where HLSL and GLSL broadcast.
        const s = n.args.map((r) => splat(r, t))
        const w0 = n.args.length > 0 ? typeOf(n.args[0]) : 1
        const imm = n.imm ?? []
        /** A library function by name, and by HLSL parameter types where it is overloaded. */
        const lib = (name: string, params?: string[]) => {
            const i = libIndex(name, params)
            need.add(i)
            return W ? LIB_FUNCTIONS[i]!.wgsl : name
        }
        const hlslType = (w: SLType) => (w === 1 ? "float" : `float${w}`)
        const argKind = n.args.length > 0 ? valueAt(p.nodes, n.args[0]!).kind : undefined
        // IR 4: the ops that take ints, uints and bools, by the kinds involved.
        if (n.kind !== undefined || argKind !== undefined) {
            const zero = kindLit(n.kind ?? "int", 0)
            /** `c ? x : y`, which WGSL spells select(y, x, c). */
            const pick = (c: string, x: string, y: string) => (W ? `select(${y}, ${x}, ${c})` : `(${c} ? ${x} : ${y})`)
            switch (n.op) {
                case SLOP.ADD: return `(${a[0]} + ${a[1]})`
                case SLOP.SUB: return `(${a[0]} - ${a[1]})`
                case SLOP.MUL: return `(${a[0]} * ${a[1]})`
                // Truncating, and 0 for a zero divisor. GLSL ES leaves % of a
                // negative undefined, so it is written out from the division.
                case SLOP.DIV: return pick(`${a[1]} == ${zero}`, zero, `${a[0]} / ${a[1]}`)
                case SLOP.MOD: return pick(`${a[1]} == ${zero}`, zero, W ? `${a[0]} % ${a[1]}` : `${a[0]} - ${a[1]} * (${a[0]} / ${a[1]})`)
                case SLOP.NEG: return `(-${a[0]})`
                case SLOP.MIN: return `min(${a[0]}, ${a[1]})`
                case SLOP.MAX: return `max(${a[0]}, ${a[1]})`
                case SLOP.ABS: return `abs(${a[0]})`
                case SLOP.CLAMP: return `clamp(${a[0]}, ${a[1]}, ${a[2]})`
            }
        }
        switch (n.op) {
            case SLOP.COMPOSE: return t === 1 ? a[0] : `${typeName(n)}(${a.join(", ")})`
            case SLOP.CAST: {
                const from = valueAt(p.nodes, n.args[0]!).kind
                if (n.kind === "bool") return `(${a[0]} != ${from === undefined ? "0.0" : kindLit(from, 0)})`
                if (n.kind !== undefined && from === undefined) {
                    const [lo, hi] = INT_LIMITS[n.kind]
                    return `${typeName(n)}(clamp(${a[0]}, ${lo}, ${hi}))`
                }
                return `${typeName(n)}(${a[0]})`
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
            // WGSL shifts by a u32.
            case SLOP.SHL: return W ? `(${a[0]} << u32(${a[1]}))` : `(${a[0]} << ${a[1]})`
            case SLOP.SHR: return W ? `(${a[0]} >> u32(${a[1]}))` : `(${a[0]} >> ${a[1]})`
            case SLOP.CHOOSE: return W ? `select(${a[2]}, ${a[1]}, ${a[0]})` : `(${a[0]} ? ${a[1]} : ${a[2]})`

            case SLOP.ADD: return `(${s[0]} + ${s[1]})`
            case SLOP.SUB: return `(${s[0]} - ${s[1]})`
            case SLOP.MUL: return `(${s[0]} * ${s[1]})`
            case SLOP.DIV: return `(${s[0]} / ${s[1]})`
            // HLSL fmod: truncating, sign of the dividend.
            case SLOP.MOD: return `(${s[0]} - ${s[1]} * trunc(${s[0]} / ${s[1]}))`
            case SLOP.POW: return `pow(abs(${s[0]}), ${s[1]})`
            case SLOP.NEG: return `(-${a[0]})`
            case SLOP.RECIP: return `(${k(1, t)} / ${a[0]})`

            case SLOP.SIN: return `sin(${a[0]})`
            case SLOP.COS: return `cos(${a[0]})`
            case SLOP.TAN: return `tan(${a[0]})`
            case SLOP.ASIN: return `asin(clamp(${a[0]}, ${k(-1, t)}, ${k(1, t)}))`
            case SLOP.ACOS: return `acos(clamp(${a[0]}, ${k(-1, t)}, ${k(1, t)}))`
            case SLOP.ATAN2: return W ? `atan2(${s[0]}, ${s[1]})` : `atan(${s[0]}, ${s[1]})`
            case SLOP.EXP: return `exp(${a[0]})`
            case SLOP.LOG: return `log(max(${a[0]}, ${k(1e-8, t)}))`
            case SLOP.SQRT: return `sqrt(max(${a[0]}, ${k(0, t)}))`
            case SLOP.ABS: return `abs(${a[0]})`
            case SLOP.SIGN: return `sign(${a[0]})`
            case SLOP.FLOOR: return `floor(${a[0]})`
            case SLOP.CEIL: return `ceil(${a[0]})`
            case SLOP.ROUND: return `round(${a[0]})`
            case SLOP.FRACT: return `fract(${a[0]})`
            case SLOP.MIN: return `min(${s[0]}, ${s[1]})`
            case SLOP.MAX: return `max(${s[0]}, ${s[1]})`
            case SLOP.CLAMP: return `clamp(${s[0]}, ${s[1]}, ${s[2]})`
            case SLOP.SATURATE: return `clamp(${a[0]}, ${k(0, t)}, ${k(1, t)})`

            // HLSL takes these of a scalar; WGSL does not, so the scalar case is
            // written out as what HLSL computes for it.
            case SLOP.LENGTH: return w0 === 1 ? `abs(${a[0]})` : `length(${a[0]})`
            case SLOP.DISTANCE: return w0 === 1 ? `abs(${a[0]} - ${a[1]})` : `distance(${a[0]}, ${a[1]})`
            case SLOP.DOT: return w0 === 1 ? `(${a[0]} * ${a[1]})` : `dot(${a[0]}, ${a[1]})`
            case SLOP.NORMALIZE: return w0 === 1 ? `sign(${a[0]})` : `normalize(${a[0]})`
            case SLOP.CROSS: return `cross(${a[0]}, ${a[1]})`
            case SLOP.REFLECT: return w0 === 1
                ? `(${a[0]} - 2.0 * ${a[1]} * ${a[0]} * ${a[1]})`
                : `reflect(${a[0]}, ${a[1]})`
            case SLOP.LUMINANCE: return `dot(${a[0]}.rgb, ${T(3)}(0.2126, 0.7152, 0.0722))`
            case SLOP.TO_LINEAR: return `${lib("sl_toLinear", [hlslType(t)])}(${a[0]})`

            case SLOP.MIX: return `mix(${s[0]}, ${s[1]}, ${s[2]})`
            case SLOP.STEP: return `step(${s[0]}, ${s[1]})`
            case SLOP.SMOOTHSTEP: smoothsteps.add(t); return `sl_smoothstep${t}(${s[0]}, ${s[1]}, ${s[2]})`
            // As the HLSL emitter does it: branchless, so every
            // backend agrees on the edge value.
            case SLOP.SELECT: {
                const c = typeOf(n.args[0])
                return `mix(${splat(n.args[2], t)}, ${splat(n.args[1], t)}, step(${k(0.5, c)}, ${a[0]}))`
            }

            case SLOP.HSV2RGB: return `${lib("sl_hsv2rgb")}(${a[0]})`
            case SLOP.NOISE: return `${lib("sl_valueNoise")}(${a[0]})`
            case SLOP.SIMPLEX: return `${lib("sl_simplex")}(${a[0]})`
            case SLOP.FBM: return octaveCall(Math.round((n.args.length > 1 ? imm[0] : imm[1]) ?? 0), a[0])
            case SLOP.TURBULENCE: return octaveCall(2, a[0])
            case SLOP.RIDGED: return octaveCall(3, a[0])
            case SLOP.VORONOI: return `${lib("sl_voronoi")}(${a[0]})`
            case SLOP.SDF: return sdfCall(Math.round(imm[0] ?? 0), a[0], sdfParams())
            case SLOP.SAMPLE: {
                const slot = Math.round(imm[0] ?? 0)
                sampled.add(slot)
                // Where pixels part ways there are no neighbours to take a mip
                // level from, and WGSL refuses the implicit sample outright, so
                // every backend samples level 0 there (`structure.ts`).
                if (inVaryingFlow(shape, ref)) {
                    return W ? `textureSampleLevel(sl_tex${slot}, sl_samp${slot}, ${a[0]}, 0.0)` : `textureLod(sl_Tex${slot}, ${a[0]}, 0.0)`
                }
                return W ? `textureSample(sl_tex${slot}, sl_samp${slot}, ${a[0]})` : `texture(sl_Tex${slot}, ${a[0]})`
            }
            case SLOP.SAMPLE_LOD: {
                const slot = Math.round(imm[0] ?? 0)
                sampled.add(slot)
                return W
                    ? `textureSampleLevel(sl_tex${slot}, sl_samp${slot}, ${a[0]}, ${a[1]})`
                    : `textureLod(sl_Tex${slot}, ${a[0]}, ${a[1]})`
            }
            default:
                throw new SLError(
                    `the ${lang.toUpperCase()} emitter has no case for opcode ${n.op}. A program using it would ` +
                    `differ between a browser and a Unity build, which is the one failure this design cannot tolerate.`,
                )
        }

        /**
         * The library's onejsFbmKind, resolved here since the kind is a
         * constant: calling the dispatcher would print a WGSL `select` that
         * runs two of the four fields to keep one. The count is a literal when
         * it is an immediate, and an operand rounded and held to 1 to 4 as
         * `sl_fbm` holds it when it is a value.
         */
        function octaveCall(kind: number, pt: string): string {
            const o = n.args.length > 1
                ? `clamp(${W ? "i32" : "int"}(floor(${a[1]} + 0.5)), 1, 4)`
                : String(Math.min(4, Math.max(1, Math.round(imm[0] ?? 3))))
            const fn = kind === 2 ? "onejsTurbulence" : kind === 3 ? "onejsRidged" : kind === 1 ? "onejsFbmSimplex" : "onejsFbm"
            return `${lib(fn, ["float2", "float", "int", "float", "float"])}(${pt}, 0.0, ${o}, 2.0, 0.5)`
        }

        /**
         * The six shape parameters, each as a float expression and, when it
         * is a constant, its number: literals when they are immediates, the
         * components of the float4 and float2 operands when they are values.
         */
        function sdfParams(): Array<{ text: string; value?: number }> {
            if (n.args.length === 1) {
                return [1, 2, 3, 4, 5, 6].map((i) => ({ text: lit(imm[i] ?? 0), value: imm[i] ?? 0 }))
            }
            return ["x", "y", "z", "w"].map((c) => ({ text: `${a[1]}.${c}` }))
                .concat(["x", "y"].map((c) => ({ text: `${a[2]}.${c}` })))
        }

        /** The shape is a constant, so this calls it directly instead of sl_sdfDistance's switch. */
        function sdfCall(id: number, pt: string, v: Array<{ text: string; value?: number }>): string {
            const shape = SDF_CALLS[id]
            // sl_sdfDistance returns 1e6 for an id it does not know.
            if (shape === undefined) return lit(1e6)
            const fn = lib(shape.fn)
            const args = shape.args.map((arg) => {
                // Truncated toward zero, as HLSL's int() of the float4 does.
                if ("int" in arg) {
                    const p = v[arg.int]!
                    return p.value !== undefined ? String(Math.trunc(p.value)) : W ? `i32(${p.text})` : `int(${p.text})`
                }
                const parts = arg.map((i) => v[i]!.text)
                return parts.length === 1 ? parts[0] : `${T(parts.length as SLType)}(${parts.join(", ")})`
            })
            return `${fn}(${[pt, ...args].join(", ")})`
        }
    }

    const vtype = (ref: NodeRef) => typeName(valueAt(p.nodes, ref))
    const syntax: Syntax = W
        ? {
            value: (ref, e) => `let ${local(ref)}: ${vtype(ref)} = ${e};`,
            mutable: (n, like, init) => `var ${n}: ${vtype(like)}${init === undefined ? "" : ` = ${init}`};`,
            counter: (n) => `var ${n}: i32 = 0;`,
            assign: (n, v) => `${n} = ${v};`,
            increment: (n) => `${n} = ${n} + 1;`,
            ifOpen: (c) => `if (${c}) {`,
            elseOpen: "} else {",
            close: "}",
            loopOpen: "loop {",
            breakUnless: (c, turns, max) => `if (!(${c}) || ${turns} >= ${max}) { break; }`,
        }
        : {
            value: (ref, e) => `${vtype(ref)} ${local(ref)} = ${e};`,
            mutable: (n, like, init) => `${vtype(like)} ${n}${init === undefined ? "" : ` = ${init}`};`,
            counter: (n) => `int ${n} = 0;`,
            assign: (n, v) => `${n} = ${v};`,
            increment: (n) => `${n}++;`,
            ifOpen: (c) => `if (${c}) {`,
            elseOpen: "} else {",
            close: "}",
            loopOpen: "for (;;) {",
            breakUnless: (c, turns, max) => `if (!(${c}) || ${turns} >= ${max}) break;`,
        }
    const body = printBody(p, shape, syntax, expr, "    ").join("\n")
    const library = [...[...smoothsteps].sort().map((w) => smoothstep(w, lang)), ...librarySource(need, lang)].join("\n")
    const header = `// GENERATED from a shader language program (${p.hash}). Do not edit.`
    // Only the textures the program samples. WebGPU's automatic layout leaves
    // out a binding the shader never reads, and a bind group that supplies one
    // anyway does not validate; the host reads these declarations back to know
    // which slots to bind.
    const textures = p.textures.filter((t) => sampled.has(t.slot))

    if (W) {
        const bindings = textures.map((t) =>
            `@group(0) @binding(${1 + 2 * t.slot}) var sl_samp${t.slot}: sampler;\n` +
            `@group(0) @binding(${2 + 2 * t.slot}) var sl_tex${t.slot}: texture_2d<f32>;`).join("\n")
        return `${header}
struct SLFrame { res: vec4f, opt: vec4f, u: array<vec4f, ${WEB_UNIFORM_SLOTS}> }
@group(0) @binding(0) var<uniform> sl: SLFrame;
${bindings}
${library}
@vertex fn sl_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let c = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(c * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn sl_fs(@builtin(position) sl_pos: vec4f) -> @location(0) vec4f {
    var sl_uv = sl_pos.xy / sl.res.xy;
    if (sl.opt.y > 0.5) { sl_uv.y = 1.0 - sl_uv.y; }
${body}
    return n${p.result};
}
`
    }
    const samplers = textures.map((t) => `uniform sampler2D sl_Tex${t.slot};`).join("\n")
    return `#version 300 es
${header}
precision highp float;
precision highp int;
uniform vec4 sl_Res;
uniform vec4 sl_Opt;
uniform vec4 sl_U[${WEB_UNIFORM_SLOTS}];
${samplers}
out vec4 sl_Out;
${library}
void main() {
    vec2 sl_uv = gl_FragCoord.xy / sl_Res.xy;
    if (sl_Opt.y > 0.5) sl_uv.y = 1.0 - sl_uv.y;
${body}
    sl_Out = n${p.result};
}
`
}

/** The needed library functions and everything they call, in library order. */
function librarySource(need: Set<number>, lang: WebLanguage): string[] {
    const texts = lang === "wgsl" ? LIB_WGSL : LIB_GLSL
    return libClosure(need).map((i) => texts[i]!.trim())
}

/**
 * HLSL's smoothstep is the formula whatever the edge order; GLSL leaves
 * edge0 >= edge1 undefined, so the web writes the formula out. This belongs
 * to the web frame rather than the library: the HLSL backends call the
 * intrinsic, which already means this.
 */
function smoothstep(w: SLType, lang: WebLanguage): string {
    if (lang === "glsl") {
        const g = w === 1 ? "float" : `vec${w}`
        return `${g} sl_smoothstep${w}(${g} a, ${g} b, ${g} x) {
    ${g} t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}`
    }
    const t = w === 1 ? "f32" : `vec${w}f`
    return `fn sl_smoothstep${w}(a: ${t}, b: ${t}, x: ${t}) -> ${t} {
    let t = saturate((x - a) / (b - a));
    return t * t * (3.0 - 2.0 * t);
}`
}

/** A literal that survives a float32 round trip and never reads as an int. */
function lit(n: number): string {
    if (!Number.isFinite(n)) throw new SLError(`cannot emit ${n} as a shader literal`)
    return Number.isInteger(n) ? n.toFixed(1) : String(n)
}
