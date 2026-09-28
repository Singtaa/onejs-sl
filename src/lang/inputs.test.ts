import { describe, expect, it } from "vitest"
import { toJSON } from "../serial"
import { SLOP } from "../ops"
import type { Program } from "../ir"
import * as sl from "../sl"
import { parse } from "./index"

/**
 * `texel` and `centered` (`Specs/SL_NEXT.md` 6). They are built from the
 * inputs a host hands over, so what these pin down is that each one is exactly
 * the expression it names, that a program which never names one is recorded as
 * it always was, and that a program which already had its own `texel` still
 * compiles.
 */

const main = (body: string, head = "") => `${head}\nfloat4 main() {\n${body}\n}\n`

/** How many nodes call `op`: one per distinct operation, since the builder hash conses. */
const calls = (p: Program, op: number) => p.nodes.filter((n) => n.k === "call" && n.op === op).length

describe("texel and centered", () => {
    it("texel is 1 / resolution", () => {
        expect(parse(main("return float4(texel, 0, 1);")).hash)
            .toBe(parse(main("return float4(float2(1, 1) / resolution, 0, 1);")).hash)
    })

    it("centered is (uv - 0.5) * float2(aspect, 1)", () => {
        expect(parse(main("return float4(centered, 0, 1);")).hash)
            .toBe(parse(main("return float4((uv - 0.5) * float2(aspect, 1), 0, 1);")).hash)
    })

    it("a program that never names one records nothing for it", () => {
        // Dead nodes change no shader, but they are serialized: recording these
        // eagerly would have changed the bytes of every program already built.
        const p = parse(main("return float4(uv, 0, 1);"))
        expect([calls(p, SLOP.DIV), calls(p, SLOP.SUB), calls(p, SLOP.MUL)]).toEqual([0, 0, 0])
        expect(JSON.stringify(toJSON(p))).not.toMatch(/"(texel|centered)"/)
    })

    it("naming one twice records it once", () => {
        const p = parse(main("float2 a = texel; float2 b = texel * 2; return float4(a + b, centered + centered);"))
        expect(calls(p, SLOP.DIV)).toBe(1)
        expect(calls(p, SLOP.SUB)).toBe(1)
    })

    it("reads the same inside a loop and after it", () => {
        const p = parse(main("float2 s = 0;\nfor (int i = 0; i < 3; i++) { s += texel; }\nreturn float4(s + texel, 0, 1);"))
        expect(calls(p, SLOP.DIV)).toBe(1)
    })

    it("the EDSL has both, recorded only when read", () => {
        const both = sl.program(({ texel, centered }) => sl.vec4(texel, centered))
        expect(both.hash).toBe(parse(main("return float4(texel, centered);")).hash)
        const neither = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        expect(calls(neither, SLOP.DIV) + calls(neither, SLOP.SUB)).toBe(0)
    })
})

describe("a program that already had its own", () => {
    it("keeps its local texel, and can assign to it", () => {
        const own = parse(main("float2 texel = 1.0 / resolution;\ntexel *= 2;\nreturn float4(texel, 0, 1);"))
        expect(own.hash).toBe(parse(main("float2 t = 1.0 / resolution;\nt *= 2;\nreturn float4(t, 0, 1);")).hash)
    })

    it("keeps a uniform named centered, which reads the uniform", () => {
        const p = parse(main("return float4(centered, 0, 0, 1);", "uniform float centered = 0.5;"))
        expect(p.uniforms.map((u) => u.name)).toEqual(["centered"])
        expect(calls(p, SLOP.SUB)).toBe(0)
    })

    it("keeps a parameter named texel", () => {
        expect(() => parse(main("return float4(blur(texel), 0, 1);", "float2 blur(float2 texel) { return texel * 3; }"))).not.toThrow()
    })

    it("cannot assign to the input itself", () => {
        expect(() => parse(main("texel = float2(1, 1);\nreturn float4(texel, 0, 1);")))
            .toThrow(/"texel" is a derived input and cannot be assigned to/)
    })

    it("can assign to a local named after a builtin, which it may already declare", () => {
        expect(() => parse(main("float length = 1;\nlength = 2;\nreturn float4(length, 0, 0, 1);"))).not.toThrow()
    })
})
