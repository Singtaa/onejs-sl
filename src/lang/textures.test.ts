import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { emitBody, type BodyTarget } from "../body"
import { compile } from "../compile"
import { emitShader } from "../hlsl"
import { SL_IR_VERSION, samplingOf } from "../ir"
import { fromJSON, toJSON } from "../serial"
import * as sl from "../sl"
import { emitGLSL, emitWGSL } from "../web"
import { diagnose, parse } from "./index"

/**
 * A program's own sampler for a texture, its size and an unfiltered read
 * (`Specs/SL_NEXT.md` 8, IR 6): `[Wrap(...)]`, `[Filter(...)]`,
 * `textureSize(t)` and `tex2Dfetch(t, pixel)`. What each gives a host, that a
 * program without them is the program it was, and what each refusal says.
 * What each draws is the goldens' (`wrap-repeat.sl`, `wrap-mirror.sl`,
 * `filter-point.sl` and `fetch.sl`, anchored to arithmetic).
 */

const goldens = JSON.parse(fs.readFileSync(path.join(__dirname, "../../goldens/goldens.json"), "utf8"))
const corpus = (name: string) => fs.readFileSync(path.join(__dirname, "../../corpus", name), "utf8")

const sampled = (head: string, body = "return tex2D(t, uv);") => parse(`${head} texture2D t;\nfloat4 main() { ${body} }`)
const errors = (source: string) => diagnose(source).map((e) => e.text)
/** The one error for a file, with the text it marks and its fix. */
const refusal = (source: string) => {
    const es = diagnose(source)
    expect(es, es.map((e) => e.text).join("\n")).toHaveLength(1)
    const e = es[0]!
    return { text: e.text, marks: source.slice(e.offset, e.offset + e.length), fix: e.fix }
}

describe("a program with none of them", () => {
    it("keeps the hash it had before IR 6, and the shader text", () => {
        for (const name of ["texture.sl", "lod.sl", "lod-frac.sl"]) {
            const p = parse(corpus(name), { file: name })
            expect(p.version, name).toBeLessThan(6)
            expect(p.hash, name).toBe(goldens.fixtures[name].hash)
            const hlsl = emitShader(p)
            expect(hlsl).toContain("sampler2D _Tex0;")
            expect(hlsl).not.toMatch(/Texture2D|SamplerState|_TexelSize/)
            for (const text of [emitWGSL(p), emitGLSL(p)]) expect(text).not.toContain("// sampler")
        }
    })
})

describe("[Wrap] and [Filter]", () => {
    it("say how the program samples, and fill the half left out with clamp or linear", () => {
        expect(sampled("[Wrap(Repeat)]").textures).toEqual([{ name: "t", slot: 0, wrap: "repeat" }])
        expect(sampled("[Filter(Point)]").textures).toEqual([{ name: "t", slot: 0, filter: "point" }])
        expect(sampled("[Filter(Point)] [Wrap(Mirror)]").textures).toEqual([{ name: "t", slot: 0, wrap: "mirror", filter: "point" }])
        expect(samplingOf({ wrap: "repeat" })).toEqual({ wrap: "repeat", filter: "linear" })
        expect(samplingOf({ filter: "point" })).toEqual({ wrap: "clamp", filter: "point" })
        expect(samplingOf({})).toBeNull()
    })

    it("make a program IR 6 and change its hash, once per sampler however it is written", () => {
        const plain = sampled("")
        const clamp = sampled("[Wrap(Clamp)]"), linear = sampled("[Filter(Linear)]"), both = sampled("[Wrap(Clamp)] [Filter(Linear)]")
        expect(plain.version).toBe(2)
        expect(clamp.version).toBe(6)
        expect(SL_IR_VERSION).toBe(6)
        expect(clamp.hash).not.toBe(plain.hash)
        expect(new Set([clamp.hash, linear.hash, both.hash]).size).toBe(1)
        const all = ["[Wrap(Repeat)]", "[Wrap(Mirror)]", "[Wrap(Clamp)]", "[Filter(Point)]", "[Wrap(Repeat)] [Filter(Point)]", "[Wrap(Mirror)] [Filter(Point)]"]
        expect(new Set(all.map((h) => sampled(h).hash)).size).toBe(all.length)
    })

    it("are the same program as sl.texture's sampling", () => {
        const built = sl.program(({ uv }) => sl.texture("t", { wrap: "repeat", filter: "point" }).sample(uv))
        expect(built.hash).toBe(sampled("[Wrap(Repeat)] [Filter(Point)]").hash)
        expect(built.textures).toEqual([{ name: "t", slot: 0, wrap: "repeat", filter: "point" }])
    })

    it("may be said again by a later sl.texture, and not changed", () => {
        expect(sl.program(({ uv }) => {
            sl.texture("t", { wrap: "repeat" })
            return sl.texture("t").sample(uv.add(sl.texture("t", { wrap: "repeat", filter: "point" }).sample(uv).xy))
        }).textures).toEqual([{ name: "t", slot: 0, wrap: "repeat", filter: "point" }])
        expect(() => sl.program(({ uv }) => {
            sl.texture("t", { wrap: "repeat" })
            return sl.texture("t", { wrap: "mirror" }).sample(uv)
        })).toThrow(/texture "t" is given two different wraps, repeat and mirror/)
        expect(() => sl.program(({ uv }) => sl.texture("t", { wrap: "tile" as never }).sample(uv)))
            .toThrow(/a wrap is repeat, clamp, mirror, and this is tile/)
    })

    it("go through the JSON, and an older reader is refused rather than drawing it unwrapped", () => {
        const p = sampled("[Wrap(Mirror)] [Filter(Point)]")
        const back = fromJSON(JSON.parse(JSON.stringify(toJSON(p))))
        expect(back.hash).toBe(p.hash)
        expect(back.textures).toEqual(p.textures)
        expect(() => fromJSON({ ...toJSON(p), v: 5 })).toThrow(/says IR version 5 and holds nodes version 6 added/)
        expect(() => fromJSON({ ...toJSON(p), textures: [{ name: "t", slot: 0, wrap: "tile" }] })).toThrow(/texture 0: a wrap is repeat, clamp, mirror, and this is tile/)
    })

    it("print an inline sampler state for Unity and a note for the web host", () => {
        const p = sampled("[Wrap(Repeat)] [Filter(Point)]", "return tex2D(t, uv) + tex2Dlod(t, uv, 1);")
        const hlsl = emitShader(p)
        expect(hlsl).toContain("Texture2D _Tex0;")
        expect(hlsl).toContain("SamplerState sl_sampler_point_repeat;")
        expect(hlsl).toContain("_Tex0.Sample(sl_sampler_point_repeat, ")
        expect(hlsl).toContain("_Tex0.SampleLevel(sl_sampler_point_repeat, ")
        expect(hlsl).not.toMatch(/sampler2D _Tex0|sampler_Tex0/)
        expect(emitWGSL(p)).toContain("@group(0) @binding(1) var sl_samp0: sampler; // sampler repeat point\n")
        expect(emitGLSL(p)).toContain("uniform sampler2D sl_Tex0; // sampler repeat point\n")
        // One state per sampler, however many textures share it.
        const two = parse("[Wrap(Mirror)] texture2D a;\n[Wrap(Mirror)] texture2D b;\nfloat4 main() { return tex2D(a, uv) + tex2D(b, uv); }")
        expect(emitShader(two).match(/SamplerState sl_sampler_linear_mirror;/g)).toHaveLength(1)
    })

    it("are refused by a host's target that cannot set a sampler, rather than sampled as the texture is set", () => {
        const bare: BodyTarget = {
            inputs: { uv: "U", fragCoord: "F", resolution: "R", time: "T", aspect: "A" },
            uniform: (s) => `u${s}`, sample: (s, uv) => `s(${s}, ${uv})`, sampleLevel: (s, uv, l) => `l(${s}, ${uv}, ${l})`, colour: "linear",
        }
        const p = sampled("[Wrap(Repeat)]")
        expect(() => emitBody(p, bare)).toThrow(/cannot set a texture's sampler, and the program samples t with repeat and linear/)
        const body = emitBody(p, { ...bare, sampleWith: (s, uv, lod, how) => `w(${s}, ${uv}, ${lod}, ${how.wrap}, ${how.filter})` }).body
        expect(body).toContain("w(0, n0, null, repeat, linear)")
        // Declared and never sampled asks nothing of the target.
        expect(() => emitBody(sampled("[Wrap(Repeat)]", "return float4(uv, 0, 1);"), bare)).not.toThrow()
    })
})

describe("what a texture attribute refuses", () => {
    const head = (attrs: string) => `${attrs} texture2D t;\nfloat4 main() { return tex2D(t, uv); }`

    it("a value it does not take, with the one it most likely meant", () => {
        expect(refusal(head("[Wrap(repeat)]"))).toEqual({
            text: "Wrap takes Repeat, Clamp, Mirror, and this is repeat. Did you mean Repeat?",
            marks: "repeat", fix: { title: "Replace repeat with Repeat", replacement: "Repeat" },
        })
        expect(refusal(head("[Filter(Bilinear)]")).fix).toEqual({ title: "Replace Bilinear with Linear", replacement: "Linear" })
        expect(refusal(head("[Filter(Trilinear)]")).text).toMatch(/^Filter\(Trilinear\) is not offered: a program samples one mip level at a time/)
        expect(refusal(head("[Wrap(MirrorOnce)]")).text).toMatch(/^Wrap\(MirrorOnce\) is not offered: WebGPU has no mirror once/)
        expect(refusal(head("[Wrap]")).text).toBe("[Wrap] takes one of Repeat, Clamp, Mirror, as in [Wrap(Repeat)]")
        expect(refusal(head("[Filter(Point, Linear)]")).text).toBe("[Filter] takes one of Point, Linear, as in [Filter(Point)]")
    })

    it("one said twice, a uniform's attribute, and Unity's enum names", () => {
        expect(refusal(head("[Wrap(Repeat)] [Wrap(Clamp)]")).text).toBe("this texture already has [Wrap]")
        expect(refusal(head("[Range(0, 1)]"))).toMatchObject({
            text: "[Range] is for a uniform; a texture takes [Wrap(Repeat)], [Wrap(Mirror)], [Wrap(Clamp)] and [Filter(Point)], [Filter(Linear)]",
            marks: "Range",
        })
        expect(refusal(head("[WrapMode(Repeat)]")).fix).toEqual({ title: "Replace WrapMode with Wrap", replacement: "Wrap" })
        expect(refusal(head("[Tiled]")).text).toBe("\"Tiled\" is not an attribute of a texture; a texture takes Wrap and Filter")
    })

    it("a texture's attribute on a uniform, and an attribute on neither", () => {
        expect(refusal("[Wrap(Repeat)] uniform float w = 0;\nfloat4 main() { return float4(w, 0, 0, 1); }").text)
            .toBe("[Wrap] is for a texture, as in [Wrap(Repeat)] texture2D grain;")
        expect(errors("[Wrap(Repeat)] const float k = 1;\nfloat4 main() { return float4(k, 0, 0, 1); }")[0])
            .toMatch(/^an attribute belongs on a uniform or a texture/)
    })
})

describe("textureSize and tex2Dfetch", () => {
    const fetch = parse(corpus("fetch.sl"), { file: "fetch.sl" })

    it("make a program IR 6, and are what sl.texture's size and fetch record", () => {
        expect(fetch.version).toBe(6)
        const file = parse("texture2D t;\nfloat4 main() { return tex2Dfetch(t, fragCoord) + float4(textureSize(t), 0, 0); }")
        const built = sl.program(({ fragCoord }) => {
            const t = sl.texture("t")
            return t.fetch(fragCoord).add(sl.vec4(t.size(), 0, 0))
        })
        expect(file.version).toBe(6)
        expect(built.hash).toBe(file.hash)
    })

    it("print Unity's _TexelSize and Load, and keep the texture's own sampler for a plain sample", () => {
        const hlsl = emitShader(fetch)
        expect(hlsl).toContain("Texture2D _Tex0;")
        expect(hlsl).toContain("SamplerState sampler_Tex0;")
        expect(hlsl).toContain("float4 _Tex0_TexelSize;")
        expect(hlsl).toMatch(/_Tex0\.Load\(int3\(clamp\(floor\(n\d+\), float2\(0\.0, 0\.0\), _Tex0_TexelSize\.zw - 1\.0\), 0\)\)/)
        expect(hlsl).toMatch(/_Tex0\.Sample\(sampler_Tex0, n\d+\)/)
    })

    it("declare no WGSL sampler for a texture only measured and fetched from", () => {
        const p = parse("texture2D t;\nfloat4 main() { return tex2Dfetch(t, fragCoord) + float4(textureSize(t), 0, 0); }")
        const wgsl = emitWGSL(p)
        expect(wgsl).toContain("var sl_tex0: texture_2d<f32>;")
        expect(wgsl).not.toContain("sl_samp0")
        expect(wgsl).toContain("textureLoad(sl_tex0, vec2i(clamp(floor(")
        expect(emitGLSL(p)).toContain("texelFetch(sl_Tex0, ivec2(clamp(floor(")
        expect(compile(p).textures).toEqual(["t"])
    })

    it("are refused by a host's target without them", () => {
        const bare: BodyTarget = {
            inputs: { uv: "U", fragCoord: "F", resolution: "R", time: "T", aspect: "A" },
            uniform: (s) => `u${s}`, sample: (s, uv) => `s(${s}, ${uv})`, sampleLevel: (s, uv, l) => `l(${s}, ${uv}, ${l})`, colour: "linear",
        }
        const size = parse("texture2D t;\nfloat4 main() { return float4(textureSize(t), 0, 1); }")
        const read = parse("texture2D t;\nfloat4 main() { return tex2Dfetch(t, fragCoord); }")
        expect(() => emitBody(size, bare)).toThrow(/cannot measure a texture, and the program measures t/)
        expect(() => emitBody(read, { ...bare, size: (s) => `z(${s})` })).toThrow(/cannot fetch a texel, and the program reads t with tex2Dfetch/)
        expect(() => emitBody(read, { ...bare, fetch: (s, px) => `f(${s}, ${px})` })).toThrow(/cannot measure a texture/)
        expect(emitBody(read, { ...bare, size: (s) => `z(${s})`, fetch: (s, px) => `f(${s}, ${px})` }).body)
            .toContain("f(0, clamp(floor(n1), float2(0.0, 0.0), z(0) - 1.0))")
    })

    it("refuse previous, a value that is not a texture, and a pixel that is not a float2", () => {
        const main = (body: string) => `texture2D t;\nfloat4 main() { ${body} }`
        expect(refusal(main("return float4(textureSize(previous), 0, 1);")).text).toBe("previous is the size this program draws at, which is `resolution`")
        expect(refusal(main("return tex2Dfetch(previous, fragCoord);")).text).toMatch(/^previous is read at a uv/)
        expect(refusal(main("float2 s = uv; return float4(textureSize(s), 0, 1);")).text)
            .toBe("textureSize measures a texture declared in this file, as in `texture2D grain;` then `textureSize(grain)`")
        expect(refusal(main("return tex2Dfetch(t, 3);")).text).toBe("tex2Dfetch reads at a float2 pixel, as in tex2Dfetch(t, fragCoord)")
        expect(refusal(main("return tex2Dfetch(t);")).text).toMatch(/tex2Dfetch takes 2 arguments/)
    })

    it("are told apart from GLSL's texelFetch, which has a hint", () => {
        expect(errors("texture2D t;\nfloat4 main() { return texelFetch(t, fragCoord, 0); }")[0]).toMatch(/tex2Dfetch/)
    })
})
