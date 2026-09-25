import { describe, expect, it } from "vitest"
import { SLParseError, tokenize } from "./lexer"
import { diagnose, parse } from "./index"

/**
 * Several errors per file, for an editor checking as it is typed
 * (`Specs/SL_NEXT.md` 5). The first property is the one that matters: whatever
 * `parse` refuses a file with, `diagnose` reports too, at the same place.
 */

const texts = (src: string) => diagnose(src, { file: "t.sl" }).map((e) => `${e.line}:${e.column} ${e.text}`)

const main = (...lines: string[]) => ["float4 main() {", ...lines.map((l) => `    ${l}`), "}"].join("\n")

describe("diagnose", () => {
    it("finds nothing in a file that compiles", () => {
        expect(diagnose(main("return float4(uv, 0, 1);"))).toEqual([])
    })

    it("finds a mistake in each statement", () => {
        expect(texts(main("float a = wrap;", "float b = sine(a);", "return float4(a, b, 0, 1);"))).toEqual([
            `2:15 "wrap" is not declared`,
            `3:15 "sine" is not declared; did you mean sin?`,
        ])
    })

    it("finds a mistake inside the arguments of a call it refuses, and on both sides of an operator", () => {
        expect(texts(main("float t = fract(uv.x * wrap);", "return float4(mix(0, 1, t), 0, 0, 1);"))).toEqual([
            "2:15 fract is GLSL; this is HLSL, so write frac",
            `2:28 "wrap" is not declared`,
            "3:19 mix is GLSL; this is HLSL, so write lerp",
        ])
        expect(texts(main("float t = wrap * sine;", "return #fff;"))).toEqual([
            `2:15 "wrap" is not declared`,
            `2:22 "sine" is not declared; did you mean sin?`,
        ])
    })

    it("does not follow a refused declaration with the uses of its name", () => {
        expect(texts(main("float a = wrap;", "return float4(a, a, a, 1);"))).toEqual([`2:15 "wrap" is not declared`])
        expect(texts(main("float3 c = uv;", "return float4(c, 1);"))).toEqual(["2:5 c is declared float3 and this is a float2."])
    })

    it("finds a syntax error in each function", () => {
        const src = [
            "float wobble(float x) {", "    return x *;", "}",
            "float4 main() {", "    float a = 1", "    return float4(wobble(a), 0, 0, 1);", "}",
        ].join("\n")
        expect(texts(src)).toEqual([
            `2:15 expected a value, got ";"`,
            `5:15 expected ";" after a declaration, got "return"`,
        ])
    })

    it("finds the width mistakes in several statements", () => {
        expect(texts(main("float2 a = float3(uv, 1);", "float3 b = float2(1, 2);", "return float4(a, b.xy);"))).toEqual([
            "2:5 a is declared float2 and this is a float3. Take the components you want with a swizzle, as in .xy.",
            "3:5 b is declared float3 and this is a float2.",
        ])
    })

    it("finds the width mistakes in several assignments", () => {
        expect(texts(main("float a = 0;", "a = uv;", "a += float3(uv, 1);", "return float4(a, 0, 0, 1);"))).toHaveLength(2)
    })

    it("reports a mistake in a loop body once, not once per iteration", () => {
        expect(texts(main("float s = 0;", "for (int i = 0; i < 4; i++) { s += float2(i, 1); }", "return float4(s, 0, 0, 1);")))
            .toHaveLength(1)
    })

    it("reports only syntax while the file cannot be read, and names once it can", () => {
        // The second statement's name error is not reported until the first
        // statement parses: a check of a file with a hole in it is about the hole.
        expect(texts(main("float a = ;", "float b = wrap;", "return #fff;"))).toEqual([`2:15 expected a value, got ";"`])
    })

    it("reports whatever parse refuses, at the same place", () => {
        const program = [
            "uniform float warp = 1;", "uniform float4 tint = #ff8040;", "texture2D grain;",
            "const float k = 2;",
            "float wobble(float2 p, float t) {", "    return sin(p.x * k + t) * warp;", "}",
            "float4 main() {",
            "    float2 p = uv * 2 - 1;",
            "    float d = sdf.circle(p, 0.5);",
            "    float3 c = tint.rgb;",
            "    for (int i = 0; i < 3; i++) { c.rg += wobble(p, time + i) * 0.1; }",
            "    if (d < 0) { c = c * tex2D(grain, uv).rgb; } else { c = lerp(c, 1, 0.5); }",
            "    return float4(c, smoothstep(0.02, 0, d));",
            "}",
        ].join("\n")
        expect(diagnose(program)).toEqual([])
        // Every program one token short of it.
        const tokens = tokenize(program, "t.sl").filter((t) => t.kind !== "eof")
        let refused = 0
        for (const t of tokens) {
            const src = program.slice(0, t.offset) + program.slice(t.offset + t.text.length)
            let thrown: SLParseError | null = null
            try { parse(src) } catch (e) { if (e instanceof SLParseError) thrown = e; else throw e }
            const all = diagnose(src)
            if (thrown === null) { expect(all, src).toEqual([]); continue }
            refused++
            expect(all.map((e) => `${e.offset} ${e.text}`), src).toContain(`${thrown.offset} ${thrown.text}`)
        }
        expect(refused).toBeGreaterThan(100)
    })

    it("does not add that main is missing to a body that was never closed", () => {
        // The unclosed body read to the end of the file, main with it: one mistake, one error.
        expect(texts("float4 main() {\n    return #fff;")).toEqual(["2:16 this body is never closed"])
        expect(texts("float f(float x) {\n    return x;\nfloat4 main() { return #fff; }").map((t) => t.replace(/^\S+ /, "")))
            .not.toContain("this file declares no main. A .sl file is one fragment function: add `float4 main() { ... }`")
        expect(texts("float f(float x) { return x; }")).toEqual([
            "1:30 this file declares no main. A .sl file is one fragment function: add `float4 main() { ... }`",
        ])
    })

    it("carries on past a character it cannot read only as far as the lexer does", () => {
        expect(texts(main("float a = 1 @ 2;", "return #fff;"))).toEqual([`2:17 "@" means nothing here`])
    })
})
