import { describe, expect, it } from "vitest"
import { emitFragmentBody } from "./hlsl"
import { SLOP } from "./ops"
import { SL_SDF_PARAMS, SL_SDF_SHAPES } from "./shapes"
import { emitGLSL, emitWGSL, WEB_UNIFORM_SLOTS } from "./web"
import { SDF_CALLS, WEB_LIB } from "./weblib"
import { TYPE, type Program, type SLNode } from "./ir"
import { sl } from "./index"
import { parse } from "./lang"

/**
 * The web emitters print; whether what they print compiles and matches the VM
 * is proven in a browser (`Tools/sl-web-parity` in the container, every
 * example and every shape, compiled against the VM within 1/255). These are the
 * structural checks that do not need a GPU: a table that drifted, a library
 * entry out of order, an opcode the HLSL emitter knows and these do not.
 */

const SOURCE = `
uniform float warp = 0.5;
uniform float4 tint = #ff8040;
texture2D grain;

float4 main() {
    float2 p = (uv - 0.5) * float2(aspect, 1);
    float g = tex2D(grain, uv * 4 + time * 0.05).r;
    float d = sdf.star(p, 0.3, 5, 2.5) + fbm(p * 3, 3) * warp * g;
    return float4(tint.rgb * smoothstep(0.02, 0, d), 1);
}
`

describe("the web emitters", () => {
    it("have a shape for every sdf id, in id order", () => {
        const ids = Object.values(SL_SDF_SHAPES)
        expect(SDF_CALLS.length).toBe(ids.length)
        const names = new Set(WEB_LIB.map((e) => e.name))
        for (const [shape, id] of Object.entries(SL_SDF_SHAPES)) {
            const call = SDF_CALLS[id]!
            // sdCircle for circle, sdStar5 for star5: the table is by id, so a
            // shape inserted in the middle of one list shows up here. Two keep
            // SDF2D.cginc's (and Inigo Quilez's) spelling.
            const fn = { octagon: "sdOctogon", hyperbola: "sdHyberbola" }[shape] ?? "sd" + shape
            expect(call.fn.toLowerCase(), `id ${id}`).toBe(fn.toLowerCase())
            expect(names.has(call.fn), `${call.fn} is in the library`).toBe(true)
        }
    })

    it("read as many parameters per shape as SL_SDF_PARAMS says (#129)", () => {
        // Derived from the call table, which maps each argument onto
        // [a.x, a.y, a.z, a.w, b.x, b.y]: the highest index a shape reads is
        // its count. Two tables written by hand, held level by this.
        for (const [shape, id] of Object.entries(SL_SDF_SHAPES)) {
            const read = Math.max(0, ...SDF_CALLS[id]!.args.map((a) => Array.isArray(a) ? Math.max(...a) + 1 : a.int + 1))
            expect(SL_SDF_PARAMS[shape as keyof typeof SL_SDF_PARAMS], shape).toBe(read)
        }
    })

    it("keep the library in dependency order, with every entry in both languages", () => {
        const seen = new Set<string>()
        for (const e of WEB_LIB) {
            expect(seen.has(e.name), `${e.name} appears twice`).toBe(false)
            for (const d of e.deps) expect(seen.has(d), `${e.name} needs ${d} before it`).toBe(true)
            expect(e.glsl.trim().length).toBeGreaterThan(0)
            expect(e.wgsl.trim().length).toBeGreaterThan(0)
            seen.add(e.name)
        }
    })

    it("handle every opcode the HLSL emitter handles", () => {
        // One call node per opcode over uv, printed by both. A case missing
        // from the web emitters throws, which is the point: the op would
        // otherwise run on the VM and fail to compile, or differ, on the web.
        for (const [name, op] of Object.entries(SLOP)) {
            if (op <= SLOP.SWIZZLE) continue
            const nodes: SLNode[] = [
                { k: "input", type: TYPE.VEC2, name: "uv" },
                { k: "call", type: TYPE.VEC2, op, args: [0, 0, 0], imm: [3, 0, 0, 0, 0] },
                { k: "call", type: TYPE.VEC4, op: SLOP.COMPOSE, args: [1, 1] },
            ]
            const p: Program = { nodes, result: 2, uniforms: [], textures: [{ name: "t", slot: 0 }], hash: "x", loops: [] } as unknown as Program
            let hlslKnows = true
            try { emitFragmentBody(p) } catch { hlslKnows = false }
            if (!hlslKnows) continue
            expect(() => emitGLSL(p), name).not.toThrow()
            expect(() => emitWGSL(p), name).not.toThrow()
        }
    })

    it("print a parsed program against the host's fixed layout", () => {
        const p = parse(SOURCE, { file: "star.sl" })
        const glsl = emitGLSL(p)
        const wgsl = emitWGSL(p)

        expect(glsl.startsWith("#version 300 es\n")).toBe(true)
        expect(glsl).toContain(`uniform vec4 sl_U[${WEB_UNIFORM_SLOTS}];`)
        expect(glsl).toContain("uniform sampler2D sl_Tex0;")
        expect(glsl).toContain("texture(sl_Tex0, ")
        expect(glsl).toContain("sdStar(")

        expect(wgsl).toContain(`u: array<vec4f, ${WEB_UNIFORM_SLOTS}>`)
        expect(wgsl).toContain("@group(0) @binding(1) var sl_samp0: sampler;")
        expect(wgsl).toContain("@group(0) @binding(2) var sl_tex0: texture_2d<f32>;")
        expect(wgsl).toContain("@vertex fn sl_vs(")
        expect(wgsl).toContain("@fragment fn sl_fs(")
        // WGSL has no ternary; a `?` anywhere is a line copied from GLSL.
        expect(wgsl).not.toContain("?")

        // A declared texture nothing samples is not bound: WebGPU's automatic
        // layout would leave it out and the bind group would not validate.
        const unused = parse(`texture2D grain;\nfloat4 main() { return float4(uv, 0, 1); }`, { file: "unused.sl" })
        expect(emitWGSL(unused)).not.toContain("sl_tex0")
        expect(emitGLSL(unused)).not.toContain("sl_Tex0")

        // Only what the program calls is carried.
        expect(glsl).not.toContain("sdHeart")
        expect(wgsl).not.toContain("sl_voronoi")
    })

    it("read uniforms from their slot at their width", () => {
        const p = sl.program(() => {
            const a = sl.uniform.float("a", 0.5)
            const b = sl.uniform.vec2("b", [0, 1])
            return sl.vec4(a, b, 1)
        })
        expect(emitGLSL(p)).toMatch(/= sl_U\[0\]\.x;/)
        expect(emitGLSL(p)).toMatch(/= sl_U\[1\]\.xy;/)
        expect(emitWGSL(p)).toMatch(/= sl\.u\[1\]\.xy;/)
    })

    it("print every sdf shape", () => {
        for (const shape of Object.keys(SL_SDF_SHAPES)) {
            const p = parse(`float4 main() { float d = sdf.${shape}(uv - 0.5, 0.3, 0.2, 0.1, 0.05); return float4(d, d, d, 1); }`, { file: shape + ".sl" })
            expect(emitGLSL(p), shape).toContain(SDF_CALLS[SL_SDF_SHAPES[shape as keyof typeof SL_SDF_SHAPES]]!.fn + "(")
            expect(() => emitWGSL(p), shape).not.toThrow()
        }
    })
})
