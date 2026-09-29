import { describe, expect, it } from "vitest"
import { compile } from "../compile"
import { emitBody, type BodyTarget } from "../body"
import { emitShader } from "../hlsl"
import { readsOf, SL_IR_VERSION, type Program } from "../ir"
import { SLOP } from "../ops"
import { fromJSON, toJSON } from "../serial"
import * as sl from "../sl"
import { emitGLSL, emitWGSL } from "../web"
import { fromGLSL } from "./glsl"
import { classify, parse } from "./index"

/**
 * The previous frame, `frame` and `deltaTime` (`Specs/SL_NEXT.md` 4). What
 * these pin down is the language's half: each name means one node, a program
 * that names none of them is the program it always was, a file that already
 * used one of the names keeps compiling, and a host that cannot supply one is
 * told so. Whether a host steps them right is the goldens' multi-frame mode.
 */

const main = (body: string, head = "") => `${head}\nfloat4 main() {\n${body}\n}\n`
const calls = (p: Program, op: number) => p.nodes.filter((n) => n.k === "call" && n.op === op).length
const inputs = (p: Program, name: string) => p.nodes.filter((n) => n.k === "input" && n.name === name).length

const TRAIL = main("float4 last = tex2D(previous, uv);\nreturn max(last * 0.9, float4(step(length(uv - 0.5), 0.1), 0, 0, 1));")

describe("frame, deltaTime and previous", () => {
    it("are each one node, however often a program names them", () => {
        const p = parse(main("float a = deltaTime + deltaTime; int f = frame + frame; float4 c = tex2D(previous, uv) + tex2D(previous, uv);\nreturn c + float4(a, f, 0, 0);"))
        expect([inputs(p, "frame"), inputs(p, "deltaTime"), calls(p, SLOP.SAMPLE_PREVIOUS)]).toEqual([1, 1, 1])
    })

    it("frame is an int, so it divides as one", () => {
        expect(parse(main("return float4(frame / 2, 0, 0, 1);")).hash)
            .toBe(parse(main("return float4(int(frame) / int(2), 0, 0, 1);")).hash)
        expect(parse(main("return float4(frame % 2 == 0 ? 1 : 0, 0, 0, 1);")).nodes.some((n) => n.k === "call" && n.op === SLOP.MOD && n.kind === "int")).toBe(true)
    })

    it("are the EDSL's inputs too, recorded only when read", () => {
        const edsl = sl.program(({ uv, frame, deltaTime, previous }) =>
            sl.vec4(previous.sample(uv).rgb.mul(sl.float(frame)).add(deltaTime), 1))
        expect(edsl.hash).toBe(parse(main("return float4(tex2D(previous, uv).rgb * float(frame) + deltaTime, 1);")).hash)
        const plain = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        expect(plain.nodes.some((n) => n.k === "input" && (n.name === "frame" || n.name === "deltaTime"))).toBe(false)
    })

    it("leave a program that reads none of them as it was: its version, its JSON and its shaders", () => {
        const p = parse(main("return float4(uv, time, 1);"))
        expect(p.version).toBeLessThan(5)
        expect(JSON.stringify(toJSON(p))).not.toMatch(/frame|deltaTime|previous/)
        expect(readsOf(p)).toEqual({ previous: false, frame: false, deltaTime: false })
        const hlsl = emitShader(p)
        expect(hlsl).not.toContain("_Prev")
        expect(hlsl).toContain("fixed4 frag(")
        expect(emitWGSL(p)).not.toContain("sl_prev")
        expect(emitGLSL(p)).not.toContain("sl_Prev")
    })

    it("make a program IR 5, and say which a host has to keep", () => {
        const p = parse(TRAIL)
        expect(p.version).toBe(5)
        expect(SL_IR_VERSION).toBe(5)
        expect(compile(p).reads).toEqual({ previous: true, frame: false, deltaTime: false })
        expect(compile(parse(main("return float4(frame, deltaTime, 0, 1);"))).reads).toEqual({ previous: false, frame: true, deltaTime: true })
    })

    it("a dead read is not a read", () => {
        const p = parse(main("float4 unused = tex2D(previous, uv);\nfloat f = frame;\nreturn float4(uv, 0, 1);"))
        expect(readsOf(p)).toEqual({ previous: false, frame: false, deltaTime: false })
        expect(p.version).toBeLessThan(5)
    })
})

describe("a file that already used the names", () => {
    it("keeps a local frame, and can assign to it", () => {
        const own = parse(main("float frame = 2;\nframe *= 3;\nreturn float4(frame, 0, 0, 1);"))
        expect(readsOf(own).frame).toBe(false)
        expect(own.hash).toBe(parse(main("float f = 2;\nf *= 3;\nreturn float4(f, 0, 0, 1);")).hash)
    })

    it("keeps a uniform named deltaTime, which reads the uniform", () => {
        const p = parse(main("return float4(deltaTime, 0, 0, 1);", "uniform float deltaTime = 0.5;"))
        expect(p.uniforms.map((u) => u.name)).toEqual(["deltaTime"])
        expect(readsOf(p).deltaTime).toBe(false)
    })

    it("keeps its own texture named previous, which samples that texture", () => {
        const p = parse(main("return tex2D(previous, uv);", "texture2D previous;"))
        expect(p.textures.map((t) => t.name)).toEqual(["previous"])
        expect([calls(p, SLOP.SAMPLE), calls(p, SLOP.SAMPLE_PREVIOUS)]).toEqual([1, 0])
    })

    it("keeps a function named frame, which the call reaches while the bare name is still the input", () => {
        const p = parse(main("return float4(frame(0.5), frame, 0, 1);", "float frame(float t) { return t * 2; }"))
        expect(readsOf(p).frame).toBe(true)
        expect(p.hash).toBe(parse(main("return float4(twice(0.5), frame, 0, 1);", "float twice(float t) { return t * 2; }")).hash)
    })

    it("cannot assign to the input itself", () => {
        expect(() => parse(main("frame = 1;\nreturn float4(0, 0, 0, 1);"))).toThrow(/"frame" is a built in input and cannot be assigned to/)
    })
})

describe("what previous refuses", () => {
    it("a mip level, since it has one", () => {
        expect(() => parse(main("return tex2Dlod(previous, uv, 1);"))).toThrow(/previous has one level.*tex2D\(previous, uv\)/)
    })

    it("being read as a value", () => {
        expect(() => parse(main("float4 c = previous;\nreturn c;"))).toThrow(/previous is the frame this program drew before, a texture.*tex2D\(previous, uv\)/)
    })

    it("sampling a value that took its name", () => {
        expect(() => parse(main("return tex2D(previous, uv);", "uniform float previous = 1;"))).toThrow(/tex2D samples a texture declared in this file/)
    })
})

describe("the emitters", () => {
    const p = parse(main("float4 last = tex2D(previous, uv);\nreturn last + float4(frame, deltaTime, 0, 0);"))

    it("give the Unity frame the step in _Res.zw and the previous frame as _Prev, flipped as uv was", () => {
        const hlsl = emitShader(p)
        expect(hlsl).toContain(`_Prev ("Previous frame", 2D) = "black" {}`)
        expect(hlsl).toContain("sampler2D _Prev;")
        expect(hlsl).toContain("float4 frag(")
        expect(hlsl).toContain("_Res.z")
        expect(hlsl).toContain("_Res.w")
        expect(hlsl).toMatch(/tex2Dlod\(_Prev, float4\(n\d+ \* float2\(1\.0, 1\.0 - 2\.0 \* _FlipY\) \+ float2\(0\.0, _FlipY\), 0\.0, 0\.0\)\)/)
    })

    it("give the web frame the step in sl_Res.w and sl_Opt.z and the previous frame its own binding", () => {
        const wgsl = emitWGSL(p), glsl = emitGLSL(p)
        expect(wgsl).toContain("@group(0) @binding(9) var sl_prevSamp: sampler;")
        expect(wgsl).toContain("@group(0) @binding(10) var sl_prev: texture_2d<f32>;")
        expect(wgsl).toContain("sl.res.w")
        expect(wgsl).toContain("sl.opt.z")
        expect(wgsl).toContain("textureSampleLevel(sl_prev, sl_prevSamp, ")
        expect(glsl).toContain("uniform sampler2D sl_Prev;")
        expect(glsl).toContain("sl_Res.w")
        expect(glsl).toContain("sl_Opt.z")
        expect(glsl).toContain("textureLod(sl_Prev, ")
    })

    it("tell a host's target that lacks a hook which one, rather than print a still shader", () => {
        const bare: BodyTarget = {
            inputs: { uv: "U", fragCoord: "F", resolution: "R", time: "T", aspect: "A" },
            uniform: (s) => `u${s}`, sample: (s, uv) => `s(${s}, ${uv})`, sampleLevel: (s, uv, l) => `l(${s}, ${uv}, ${l})`, colour: "linear",
        }
        expect(() => emitBody(parse(main("return float4(frame, 0, 0, 1);")), bare)).toThrow(/no frame input, and the program reads it/)
        expect(() => emitBody(parse(main("return float4(deltaTime, 0, 0, 1);")), bare)).toThrow(/no deltaTime input/)
        expect(() => emitBody(parse(TRAIL), bare)).toThrow(/keeps no previous frame, and the program samples it/)
        expect(() => emitBody(parse(TRAIL), { ...bare, previous: (uv) => `P(${uv})` })).not.toThrow()
    })
})

describe("the JSON", () => {
    it("round trips a program that reads them", () => {
        const p = parse(TRAIL)
        const back = fromJSON(JSON.parse(JSON.stringify(toJSON(p))))
        expect(back.hash).toBe(p.hash)
        expect(back.version).toBe(5)
    })

    it("refuses a file that says IR 4 and holds what IR 5 added", () => {
        const json = { ...toJSON(parse(main("return float4(frame, 0, 0, 1);"))), v: 4 }
        expect(() => fromJSON(json)).toThrow(/says IR version 4 and holds nodes version 5 added/)
    })

    it("refuses the previous frame read at anything but a float2", () => {
        const json = toJSON(parse(TRAIL))
        const nodes = json.nodes.map((n) => (n.k === "call" && n.op === SLOP.SAMPLE_PREVIOUS ? { ...n, imm: [0] } : n))
        expect(() => fromJSON({ ...json, nodes })).toThrow(/the previous frame is a float4 read at a float2/)
    })
})

describe("the rest of the language's tooling", () => {
    it("highlights all three as inputs", () => {
        const kinds = classify("float4 main() { return tex2D(previous, uv) * frame + deltaTime; }")
        for (const name of ["previous", "frame", "deltaTime"]) expect(kinds.find((t) => t.text === name)?.kind, name).toBe("input")
    })

    it("carries Shadertoy's iFrame and iTimeDelta over, declared or not", () => {
        const image = (top: string) =>
            `${top}\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    fragColor = vec4(float(iFrame) * iTimeDelta, 0, 0, 1);\n}`
        for (const top of ["", "uniform int iFrame;\nuniform float iTimeDelta;"]) {
            const r = fromGLSL(image(top))
            expect(r.errors).toEqual([])
            expect(r.source).toContain("float(frame) * deltaTime")
            expect(readsOf(parse(r.source))).toEqual({ previous: false, frame: true, deltaTime: true })
        }
    })
})
