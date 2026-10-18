import { describe, expect, it } from "vitest"
import { emitBody, type BodyTarget } from "./emit/hlsl-body"
import { emitShader } from "./emit/unity"
import { emitGLSL, emitWGSL } from "./emit/web"
import { parse } from "./index"

/**
 * A fractional `tex2Dlod` level blends the level below and the level above by
 * the fraction, on every backend, whatever the texture's own filter between
 * levels: a bilinear texture snaps to one level and a trilinear one blends, so
 * leaving it to the sampler drew one program two ways. Each level's colour is
 * weighed by its alpha, as trilinear filtering of premultiplied texels does,
 * so a level that reads transparent adds no colour instead of pulling the
 * other toward black. `corpus/lod-frac.sl` and `corpus/lod-alpha.sl` are the
 * anchors that hold the picture to arithmetic; this holds the text: each level
 * read once into a local, the two blended premultiplied, alpha divided back out,
 * and the plain blend where both levels are transparent.
 */

const TARGET: BodyTarget = {
    inputs: { uv: "SL_UV", fragCoord: "SL_FRAGCOORD", resolution: "SL_RES", time: "SL_TIME", aspect: "SL_ASPECT" },
    uniform: (slot) => `SL_U(${slot})`,
    sample: (slot, uv) => `SL_SAMPLE(${slot}, ${uv})`,
    sampleLevel: (slot, uv, lod) => `SL_SAMPLE_LEVEL(${slot}, ${uv}, ${lod})`,
    colour: "linear",
    result: "c",
}

const program = (level: string, head = "") => parse(`${head}texture2D t;\nfloat4 main() { return tex2Dlod(t, uv, ${level}); }`, { file: "lod.sl" })

/**
 * Consecutive lines as a RegExp. `@N` is the sampling node's local, `@UV` the
 * coordinate's and `@L` the level's: the first of each captures, the rest have
 * to be the same local.
 */
function lines(text: string[]): RegExp {
    const group = new Map<string, number>()
    return new RegExp(text.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/@(N|UV|L)/g, (_, k: string) => {
        const at = group.get(k)
        if (at !== undefined) return `\\${at}`
        group.set(k, group.size + 1)
        return "(n\\d+)"
    })).join("\\s*"))
}

/** HLSL's lines, the Unity shader's and a host body's alike, given how each reads a level. */
const hlslBlend = (read: (lod: string) => string) => lines([
    `float4 @N_lo = ${read("floor(@L)")};`,
    `float4 @N_hi = ${read("floor(@L) + 1.0")};`,
    "float4 @N_pm = lerp(float4(@N_lo.rgb * @N_lo.a, @N_lo.a), float4(@N_hi.rgb * @N_hi.a, @N_hi.a), frac(@L));",
    "float4 @N = float4(@N_pm.a > 0.0 ? @N_pm.rgb / @N_pm.a : lerp(@N_lo.rgb, @N_hi.rgb, frac(@L)), @N_pm.a);",
])

/** Every backend's text for one program, the call each samples a level with, and its blend. */
function emitted(level: string, head?: string) {
    const p = program(level, head)
    return [
        { name: "HLSL", text: emitShader(p), sample: /tex2Dlod\(_Tex0, /g, blend: hlslBlend((lod) => `tex2Dlod(_Tex0, float4(@UV, 0.0, ${lod}))`) },
        {
            name: "WGSL", text: emitWGSL(p), sample: /textureSampleLevel\(sl_tex0, /g, blend: lines([
                "let @N_lo: vec4f = textureSampleLevel(sl_tex0, sl_samp0, @UV, floor(@L));",
                "let @N_hi: vec4f = textureSampleLevel(sl_tex0, sl_samp0, @UV, floor(@L) + 1.0);",
                "let @N_pm: vec4f = mix(vec4f(@N_lo.rgb * @N_lo.a, @N_lo.a), vec4f(@N_hi.rgb * @N_hi.a, @N_hi.a), fract(@L));",
                "let @N: vec4f = vec4f(select(mix(@N_lo.rgb, @N_hi.rgb, fract(@L)), @N_pm.rgb / @N_pm.a, @N_pm.a > 0.0), @N_pm.a);",
            ]),
        },
        {
            name: "GLSL", text: emitGLSL(p), sample: /textureLod\(sl_Tex0, /g, blend: lines([
                "vec4 @N_lo = textureLod(sl_Tex0, @UV, floor(@L));",
                "vec4 @N_hi = textureLod(sl_Tex0, @UV, floor(@L) + 1.0);",
                "vec4 @N_pm = mix(vec4(@N_lo.rgb * @N_lo.a, @N_lo.a), vec4(@N_hi.rgb * @N_hi.a, @N_hi.a), fract(@L));",
                "vec4 @N = vec4((@N_pm.a > 0.0 ? @N_pm.rgb / @N_pm.a : mix(@N_lo.rgb, @N_hi.rgb, fract(@L))), @N_pm.a);",
            ]),
        },
        { name: "body", text: emitBody(p, TARGET).body, sample: /SL_SAMPLE_LEVEL\(0, /g, blend: hlslBlend((lod) => `SL_SAMPLE_LEVEL(0, @UV, ${lod})`) },
    ]
}

describe("a fractional tex2Dlod level", () => {
    it("blends the two whole levels either side by the fraction, premultiplied, on every backend", () => {
        for (const level of ["uv.x * 4.5", "1.5"]) {
            for (const b of emitted(level)) {
                expect(b.text.match(b.sample)?.length, `${b.name}, ${level}`).toBe(2)
                expect(b.text, `${b.name}, ${level}`).toMatch(b.blend)
            }
        }
    })

    it("reads a level it can prove whole with one sample and no blend", () => {
        const whole: Array<[string, string?]> = [
            ["2"], ["floor(uv.x * 4)"], ["ceil(uv.x * 3) - 1"], ["round(uv.y * 2) + floor(uv.x)"],
            ["min(floor(uv.x * 8), 3)"], ["n", "uniform int n = 2;\n"],
        ]
        for (const [level, head] of whole) {
            for (const b of emitted(level, head)) {
                expect(b.text.match(b.sample)?.length, `${b.name}, ${level}`).toBe(1)
                expect(b.text, `${b.name}, ${level}`).not.toMatch(b.blend)
                expect(b.text, `${b.name}, ${level}`).not.toMatch(/_pm\b/)
            }
        }
    })

    it("blends a level it cannot prove whole, a whole float uniform included", () => {
        for (const [level, head] of [["floor(uv.x * 4) + 0.5"], ["n", "uniform float n = 2;\n"], ["floor(uv.x) / 2"]] as Array<[string, string?]>) {
            for (const b of emitted(level, head)) {
                expect(b.text.match(b.sample)?.length, `${b.name}, ${level}`).toBe(2)
                expect(b.text, `${b.name}, ${level}`).toMatch(b.blend)
            }
        }
    })

    it("keeps each blend's locals apart when one program blends twice", () => {
        const p = parse("texture2D t;\nfloat4 main() { return tex2Dlod(t, uv, uv.x * 2.5) + tex2Dlod(t, uv.yx, uv.y * 1.5); }", { file: "lod2.sl" })
        for (const text of [emitShader(p), emitWGSL(p), emitGLSL(p), emitBody(p, TARGET).body]) {
            const names = [...text.matchAll(/\b(n\d+)_pm\b(?= =|:)/g)].map((m) => m[1])
            expect(names.length).toBe(2)
            expect(new Set(names).size).toBe(2)
        }
    })
})
