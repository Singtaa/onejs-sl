/**
 * The second backend: prints a program as real HLSL, compiled at build time.
 *
 * Phase 3 of `Specs/SHADER_LANG.md` section 6, and the half the whole design
 * exists for. Unity cannot compile a shader at runtime in a player build, so on
 * play.onejs.com a program has to be interpreted. Ejecting to a Unity project
 * does not change what the author wrote, it changes what is POSSIBLE, because
 * an editor compiles shaders at build time.
 *
 * So the same source is interpreted in the browser and compiled after an eject,
 * with no edit in between. That is what stops "Play games eject cleanly" from
 * quietly acquiring an asterisk.
 *
 * WHY THIS IS THE EASY BACKEND. The VM keeps every value in a float4 register
 * and has to be told how wide each one really is. Here the IR's types become the
 * HLSL types directly, so `float2` is a `float2` and nothing needs padding or
 * explaining. One local per node also gives common subexpression elimination for
 * free: a node is emitted once no matter how many nodes reference it.
 *
 * The generated names are `n<index>` and are unreadable on purpose. Generated
 * code that looks hand written invites hand editing, and a hand edit is lost the
 * next time it is generated.
 */

import { SLError, TYPE, type Program, type SLNode, type SLType } from "./ir"
import { SLOP } from "./ops"
import { INPUT_ID } from "./encode"

const HLSL_TYPE: Record<SLType, string> = { 1: "float", 2: "float2", 3: "float3", 4: "float4" }

/** A literal that survives a float32 round trip and never reads as an int. */
function lit(n: number): string {
    if (!Number.isFinite(n)) throw new SLError(`cannot emit ${n} as a shader literal`)
    const s = Number.isInteger(n) ? n.toFixed(1) : String(n)
    return s
}

function ctor(type: SLType, parts: string[]): string {
    return type === TYPE.FLOAT ? parts[0] : `${HLSL_TYPE[type]}(${parts.join(", ")})`
}

const SWZ = "xyzw"

/** The property name a uniform gets. Prefixed so it cannot collide with ours. */
export function uniformProperty(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SLError(`uniform "${name}" is not a usable shader property name`)
    }
    return "_u_" + name
}

export interface EmitOptions {
    /** Shader name. Defaults to a name derived from the program hash. */
    name?: string
    /**
     * Path used for the shared helpers include. Unity resolves this relative to
     * the generated shader's own folder, so a generator writing somewhere other
     * than beside SLCommon.cginc has to say where it went.
     */
    include?: string
}

/**
 * Emits a complete `.shader` for a program.
 *
 * The shader's name carries the program hash, which is how the runtime finds it
 * again. If that link breaks, the runtime silently falls back to the VM and
 * nobody is told: correct output, quietly slow, no error. See `hashProgram`.
 */
export function emitShader(p: Program, options: EmitOptions = {}): string {
    const name = options.name ?? `Hidden/SLGenerated/${p.hash}`
    const include = options.include ?? "SLCommon.cginc"
    const body = emitFragmentBody(p)

    const props: string[] = [
        `        _Secs ("Seconds", Float) = 0`,
        `        _FlipY ("Flip Y", Float) = 0`,
    ]
    const decls: string[] = [`            float _Secs;`, `            float _FlipY;`]

    for (const u of p.uniforms) {
        const prop = uniformProperty(u.name)
        // Declared as a float4 whatever its width, so the host sets uniforms the
        // same way for every program and a widening edit does not change the
        // binding. The body swizzles down to the width the program uses.
        const d = [u.value[0] ?? 0, u.value[1] ?? 0, u.value[2] ?? 0, u.value[3] ?? 1]
        props.push(`        ${prop} ("${u.name}", Vector) = (${d.map(lit).join(", ")})`)
        decls.push(`            float4 ${prop};`)
    }
    for (const t of p.textures) {
        props.push(`        _Tex${t.slot} ("${t.name}", 2D) = "white" {}`)
        decls.push(`            sampler2D _Tex${t.slot};`)
    }

    return `// GENERATED from a shader language program. Do not edit.
//
// Source of truth is the program this was emitted from; edits here are lost the
// next time it is generated. The name carries the program hash, which is how the
// runtime pairs the two. See Specs/SHADER_LANG.md section 6.
Shader "${name}"
{
    Properties
    {
${props.join("\n")}
    }

    SubShader
    {
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"
            // Shared with the VM, so both backends compute the same noise.
            #include "${include}"

${decls.join("\n")}

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                // Origin corrected here exactly as the VM does it, so an ejected
                // game is not upside down relative to the one on the site.
                o.uv = float2(v.uv.x, lerp(v.uv.y, 1.0 - v.uv.y, _FlipY));
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
${body}
            }
            ENDCG
        }
    }
}
`
}

/** The straight line body: one local per reachable node, in order. */
export function emitFragmentBody(p: Program): string {
    const lines: string[] = []
    const name = (ref: number) => `n${ref}`
    const emitted = new Set<number>()

    const walk = (ref: number): void => {
        if (emitted.has(ref)) return
        const n = p.nodes[ref]
        const deps = n.k === "swizzle" ? [n.src] : n.k === "call" ? n.args : []
        for (const d of deps) walk(d)
        emitted.add(ref)
        lines.push(`                ${HLSL_TYPE[n.type]} ${name(ref)} = ${expr(n, name, p)};`)
    }
    walk(p.result)
    lines.push(`                return ${name(p.result)};`)
    return lines.join("\n")
}

function expr(n: SLNode, name: (r: number) => string, p: Program): string {
    switch (n.k) {
        case "const":
            return ctor(n.type, n.v.map(lit))
        case "input": {
            switch (INPUT_ID[n.name]) {
                case 0: return "i.uv"
                case 1: return "i.uv * _ScreenParams.xy"
                case 2: return "_ScreenParams.xy"
                case 3: return "_Secs"
                default: return "_ScreenParams.x / max(_ScreenParams.y, 1.0)"
            }
        }
        case "uniform": {
            const u = p.uniforms[n.slot]
            const prop = uniformProperty(u.name)
            return n.type === TYPE.VEC4 ? prop : `${prop}.${SWZ.slice(0, n.type)}`
        }
        case "swizzle":
            return `${name(n.src)}.${n.chans.map((c) => SWZ[c]).join("")}`
        case "call":
            return call(n, name)
    }
}

function call(n: Extract<SLNode, { k: "call" }>, name: (r: number) => string): string {
    const a = n.args.map(name)
    const imm = n.imm ?? []
    switch (n.op) {
        case SLOP.COMPOSE: return ctor(n.type, a)

        case SLOP.ADD: return `(${a[0]} + ${a[1]})`
        case SLOP.SUB: return `(${a[0]} - ${a[1]})`
        case SLOP.MUL: return `(${a[0]} * ${a[1]})`
        case SLOP.DIV: return `(${a[0]} / ${a[1]})`
        case SLOP.MOD: return `fmod(${a[0]}, ${a[1]})`
        // abs on the base, matching the VM. pow of a negative base is undefined
        // in HLSL and the two backends must be undefined in the same direction.
        case SLOP.POW: return `pow(abs(${a[0]}), ${a[1]})`
        case SLOP.NEG: return `(-${a[0]})`
        case SLOP.RECIP: return `(1.0 / ${a[0]})`

        case SLOP.SIN: return `sin(${a[0]})`
        case SLOP.COS: return `cos(${a[0]})`
        case SLOP.TAN: return `tan(${a[0]})`
        case SLOP.ASIN: return `asin(clamp(${a[0]}, -1, 1))`
        case SLOP.ACOS: return `acos(clamp(${a[0]}, -1, 1))`
        case SLOP.ATAN2: return `atan2(${a[0]}, ${a[1]})`
        case SLOP.EXP: return `exp(${a[0]})`
        case SLOP.LOG: return `log(max(${a[0]}, 1e-8))`
        case SLOP.SQRT: return `sqrt(max(${a[0]}, 0))`
        case SLOP.ABS: return `abs(${a[0]})`
        case SLOP.SIGN: return `sign(${a[0]})`
        case SLOP.FLOOR: return `floor(${a[0]})`
        case SLOP.CEIL: return `ceil(${a[0]})`
        case SLOP.ROUND: return `round(${a[0]})`
        case SLOP.FRACT: return `frac(${a[0]})`
        case SLOP.MIN: return `min(${a[0]}, ${a[1]})`
        case SLOP.MAX: return `max(${a[0]}, ${a[1]})`
        case SLOP.CLAMP: return `clamp(${a[0]}, ${a[1]}, ${a[2]})`
        case SLOP.SATURATE: return `saturate(${a[0]})`

        case SLOP.LENGTH: return `length(${a[0]})`
        case SLOP.DISTANCE: return `distance(${a[0]}, ${a[1]})`
        case SLOP.DOT: return `dot(${a[0]}, ${a[1]})`
        case SLOP.CROSS: return `cross(${a[0]}, ${a[1]})`
        case SLOP.NORMALIZE: return `normalize(${a[0]})`
        case SLOP.REFLECT: return `reflect(${a[0]}, ${a[1]})`
        case SLOP.LUMINANCE: return `sl_luminance(${a[0]}.rgb)`

        case SLOP.MIX: return `lerp(${a[0]}, ${a[1]}, ${a[2]})`
        case SLOP.STEP: return `step(${a[0]}, ${a[1]})`
        case SLOP.SMOOTHSTEP: return `smoothstep(${a[0]}, ${a[1]}, ${a[2]})`
        // Matches the VM exactly, branchlessly, rather than using an if. Two
        // backends that pick differently here disagree on every edge value.
        case SLOP.SELECT: return `lerp(${a[2]}, ${a[1]}, step(0.5, ${a[0]}))`

        case SLOP.HSV2RGB: return `sl_hsv2rgb(${a[0]})`
        case SLOP.NOISE: return `sl_valueNoise(${a[0]})`
        case SLOP.SIMPLEX: return `sl_simplex(${a[0]})`
        case SLOP.FBM: return `sl_fbm(${a[0]}, ${Math.round(imm[0] ?? 3)})`
        case SLOP.SAMPLE: return `tex2D(_Tex${Math.round(imm[0] ?? 0)}, ${a[0]})`

        default:
            throw new SLError(
                `the HLSL emitter has no case for opcode ${n.op}. A program using it would silently ` +
                `differ between the VM and a compiled build, which is the one failure this design ` +
                `cannot tolerate.`,
            )
    }
}
