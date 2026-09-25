/**
 * The web backends: prints a program as GLSL ES 3.00 or WGSL, for a browser to
 * compile at runtime on Unity's own graphics device.
 *
 * Unity cannot compile a shader in a built game, which is why the VM exists.
 * A browser can, and the Play container runs on WebGPU with WebGL2 behind it,
 * so a program becomes WGSL on one and GLSL ES on the other and runs compiled:
 * no register budget, no interpreter, and on the spike's measurements 100 to
 * 600 times cheaper per pixel. The host that compiles and draws these lives in
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

import { SLError, TYPE, type Program, type SLNode, type SLType } from "./ir"
import { INPUT_ID, SLOP, VM_UNIFORMS } from "./ops"
import { SDF_CALLS, WEB_LIB } from "./weblib"

export type WebLanguage = "glsl" | "wgsl"

/** Uniform slots the host always provides, so every program shares one layout. */
export const WEB_UNIFORM_SLOTS = VM_UNIFORMS

export function emitGLSL(p: Program): string {
    return emitWeb(p, "glsl")
}

export function emitWGSL(p: Program): string {
    return emitWeb(p, "wgsl")
}

function emitWeb(p: Program, lang: WebLanguage): string {
    const W = lang === "wgsl"
    const need = new Set<string>()
    const sampled = new Set<number>()
    const lines: string[] = []
    const emitted = new Set<number>()
    const T = (t: SLType) => (W ? (t === 1 ? "f32" : `vec${t}f`) : t === 1 ? "float" : `vec${t}`)
    const typeOf = (ref: number) => p.nodes[ref].type

    /** A node's value widened to `t` when it is a scalar and `t` is not. */
    const splat = (ref: number, t: SLType) => (typeOf(ref) === 1 && t > 1 ? `${T(t)}(n${ref})` : `n${ref}`)
    /** A literal at width `t`. */
    const k = (v: number, t: SLType) => (t > 1 ? `${T(t)}(${lit(v)})` : lit(v))

    const walk = (ref: number): void => {
        if (emitted.has(ref)) return
        const n = p.nodes[ref]
        const deps = n.k === "swizzle" ? [n.src] : n.k === "call" ? n.args : []
        for (const d of deps) walk(d)
        emitted.add(ref)
        const e = expr(n)
        lines.push(W ? `    let n${ref}: ${T(n.type)} = ${e};` : `    ${T(n.type)} n${ref} = ${e};`)
    }

    const expr = (n: SLNode): string => {
        switch (n.k) {
            case "const": return n.type === 1 ? lit(n.v[0]) : `${T(n.type)}(${n.v.map(lit).join(", ")})`
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
                if (typeOf(n.src) === 1) return n.type === 1 ? `n${n.src}` : `${T(n.type)}(n${n.src})`
                return `n${n.src}.${n.chans.map((c) => "xyzw"[c]).join("")}`
            }
            case "call": return call(n)
        }
    }

    const call = (n: Extract<SLNode, { k: "call" }>): string => {
        const t = n.type
        const a = n.args.map((r) => `n${r}`)
        // Every argument at the result's width, for the element wise ops. WGSL
        // refuses min(vec2f, f32) where HLSL and GLSL broadcast.
        const s = n.args.map((r) => splat(r, t))
        const w0 = n.args.length > 0 ? typeOf(n.args[0]) : 1
        const imm = n.imm ?? []
        const lib = (name: string) => { need.add(name); return name }
        switch (n.op) {
            case SLOP.COMPOSE: return t === 1 ? a[0] : `${T(t)}(${a.join(", ")})`

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
            case SLOP.TO_LINEAR: return `${lib(`sl_toLinear${t}`)}(${a[0]})`

            case SLOP.MIX: return `mix(${s[0]}, ${s[1]}, ${s[2]})`
            case SLOP.STEP: return `step(${s[0]}, ${s[1]})`
            case SLOP.SMOOTHSTEP: return `${lib(`sl_smoothstep${t}`)}(${s[0]}, ${s[1]}, ${s[2]})`
            // As the VM and the HLSL emitter do it: branchless, so every
            // backend agrees on the edge value.
            case SLOP.SELECT: {
                const c = typeOf(n.args[0])
                return `mix(${splat(n.args[2], t)}, ${splat(n.args[1], t)}, step(${k(0.5, c)}, ${a[0]}))`
            }

            case SLOP.HSV2RGB: return `${lib("sl_hsv2rgb")}(${a[0]})`
            case SLOP.NOISE: return `${lib("oj_vnoise")}(${a[0]}, 0.0)`
            case SLOP.SIMPLEX: return `${lib("oj_simplex")}(${a[0]}, 0.0)`
            case SLOP.FBM: return octaveCall(Math.round(imm[1] ?? 0), a[0], imm[0])
            case SLOP.TURBULENCE: return octaveCall(2, a[0], imm[0])
            case SLOP.RIDGED: return octaveCall(3, a[0], imm[0])
            case SLOP.VORONOI: return `${lib("sl_voronoi")}(${a[0]})`
            case SLOP.SDF: return sdfCall(Math.round(imm[0] ?? 0), a[0], imm)
            case SLOP.SAMPLE: {
                const slot = Math.round(imm[0] ?? 0)
                sampled.add(slot)
                return W ? `textureSample(sl_tex${slot}, sl_samp${slot}, ${a[0]})` : `texture(sl_Tex${slot}, ${a[0]})`
            }
            default:
                throw new SLError(
                    `the ${lang.toUpperCase()} emitter has no case for opcode ${n.op}. A program using it would ` +
                    `differ between the VM and a compiled build, which is the one failure this design cannot tolerate.`,
                )
        }

        /** Noise2D.cginc's onejsFbmKind, resolved here since the kind is a constant. */
        function octaveCall(kind: number, pt: string, octaves: number | undefined): string {
            const o = Math.min(4, Math.max(1, Math.round(octaves ?? 3)))
            const fn = kind === 2 ? "oj_turbulence" : kind === 3 ? "oj_ridged" : kind === 1 ? "oj_fbmSimplex" : "oj_fbm"
            return `${lib(fn)}(${pt}, 0.0, ${o})`
        }

        /** The shape is a constant, so this calls it directly instead of SLCommon's switch. */
        function sdfCall(id: number, pt: string, im: number[]): string {
            const shape = SDF_CALLS[id]
            // SLCommon's dispatcher returns 1e6 for an id it does not know.
            if (shape === undefined) return lit(1e6)
            lib(shape.fn)
            const v = [im[1] ?? 0, im[2] ?? 0, im[3] ?? 0, im[4] ?? 0, im[5] ?? 0, im[6] ?? 0]
            const args = shape.args.map((arg) => {
                if (!Array.isArray(arg)) return String(Math.trunc(v[arg.int]))
                const parts = arg.map((i) => lit(v[i]))
                return parts.length === 1 ? parts[0] : `${T(parts.length as SLType)}(${parts.join(", ")})`
            })
            return `${shape.fn}(${[pt, ...args].join(", ")})`
        }
    }

    walk(p.result)
    const body = lines.join("\n")
    const library = librarySource(need, lang)
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

/** The needed entries and everything they depend on, in library order. */
function librarySource(need: Set<string>, lang: WebLanguage): string {
    const want = new Set<string>()
    const byName = new Map(WEB_LIB.map((e) => [e.name, e]))
    const add = (name: string) => {
        if (want.has(name)) return
        const entry = byName.get(name)
        if (entry === undefined) throw new SLError(`internal: the web library has no entry "${name}"`)
        want.add(name)
        for (const d of entry.deps) add(d)
    }
    for (const n of need) add(n)
    return WEB_LIB.filter((e) => want.has(e.name)).map((e) => (lang === "wgsl" ? e.wgsl : e.glsl).trim()).join("\n")
}

/** A literal that survives a float32 round trip and never reads as an int. */
function lit(n: number): string {
    if (!Number.isFinite(n)) throw new SLError(`cannot emit ${n} as a shader literal`)
    return Number.isInteger(n) ? n.toFixed(1) : String(n)
}
