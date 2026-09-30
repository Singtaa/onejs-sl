import { describe, expect, it } from "vitest"
import { emitBody, type BodyTarget } from "./emit/hlsl-body"
import { emitShader } from "./emit/unity"
import { emitGLSL, emitWGSL } from "./emit/web"
import { parse } from "./index"

/**
 * A fractional `tex2Dlod` level blends the level below and the level above by
 * the fraction, on every backend, whatever the texture's own filter between
 * levels: a bilinear texture snaps to one level and a trilinear one blends, so
 * leaving it to the sampler drew one program two ways. `corpus/lod-frac.sl` is
 * the anchor that holds the picture to arithmetic; this holds the text.
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

/** Every backend's text for one program, and the call each samples a level with. */
function emitted(level: string, head?: string) {
    const p = program(level, head)
    return [
        { name: "HLSL", text: emitShader(p), sample: /tex2Dlod\(_Tex0, /g, blend: /lerp\(tex2Dlod\(_Tex0, float4\((n\d+), 0\.0, floor\((n\d+)\)\)\), tex2Dlod\(_Tex0, float4\(\1, 0\.0, floor\(\2\) \+ 1\.0\)\), frac\(\2\)\)/ },
        { name: "WGSL", text: emitWGSL(p), sample: /textureSampleLevel\(sl_tex0, /g, blend: /mix\(textureSampleLevel\(sl_tex0, sl_samp0, (n\d+), floor\((n\d+)\)\), textureSampleLevel\(sl_tex0, sl_samp0, \1, floor\(\2\) \+ 1\.0\), fract\(\2\)\)/ },
        { name: "GLSL", text: emitGLSL(p), sample: /textureLod\(sl_Tex0, /g, blend: /mix\(textureLod\(sl_Tex0, (n\d+), floor\((n\d+)\)\), textureLod\(sl_Tex0, \1, floor\(\2\) \+ 1\.0\), fract\(\2\)\)/ },
        { name: "body", text: emitBody(p, TARGET).body, sample: /SL_SAMPLE_LEVEL\(0, /g, blend: /lerp\(SL_SAMPLE_LEVEL\(0, (n\d+), floor\((n\d+)\)\), SL_SAMPLE_LEVEL\(0, \1, floor\(\2\) \+ 1\.0\), frac\(\2\)\)/ },
    ]
}

describe("a fractional tex2Dlod level", () => {
    it("blends the two whole levels either side by the fraction, on every backend", () => {
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
})
