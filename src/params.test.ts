import { describe, expect, it } from "vitest"
import { emitBody, type BodyTarget } from "./emit/hlsl-body"
import { parse } from "./index"
import { INPUTS } from "./ir"
import { BUILTINS } from "./lang/builtins"
import { preludeFunctions } from "./lang/prelude"
import { PRELUDE_DOCS, PRELUDE_NAMES } from "./lang/prelude-source"
import { LIB_FUNCTIONS } from "./lib/table"
import { BUILTIN_DOCS, BUILTIN_PARAMS, INPUT_DOCS, LIB_SIGNATURES, LIBRARY, SL_SDF_PARAM_NAMES } from "./params"
import { SL_SDF_PARAMS } from "./shapes"

/**
 * Parameter names for an editor: one for every argument of every builtin,
 * shape and library function, so completions can show `lerp(x, y, s)`.
 */

const IDENT = /^[A-Za-z_]\w*(\.[xyzw])?$/

describe("parameter names", () => {
    it("names every argument of every builtin", () => {
        for (const [name, b] of Object.entries(BUILTINS)) {
            const names = BUILTIN_PARAMS[name]
            expect(names, `${name} has no parameter names`).toBeDefined()
            const last = names![names!.length - 1] ?? ""
            // A repeating last name stands for every argument from there to max;
            // sdf's entry is the point, and its shape's names are checked below.
            const want = last.endsWith("...") || name === "sdf" ? b.min : b.max
            expect(names!.length, `${name} takes ${b.min} to ${b.max} arguments and names ${names!.length}`).toBe(want)
            for (const n of names!) expect(n.replace(/\.\.\.$/, ""), `${name}: ${n}`).toMatch(IDENT)
        }
        expect(Object.keys(BUILTIN_PARAMS).sort()).toEqual(Object.keys(BUILTINS).sort())
    })

    it("names every parameter of every shape, in its slot", () => {
        for (const [shape, count] of Object.entries(SL_SDF_PARAMS)) {
            const names = SL_SDF_PARAM_NAMES[shape as keyof typeof SL_SDF_PARAMS]
            expect(names.length, shape).toBe(count)
            // A hole is a slot sl_sdfDistance never passes, which would name the rest wrong.
            for (let i = 0; i < count; i++) expect(names[i], `${shape} slot ${i}`).toMatch(IDENT)
        }
        expect(SL_SDF_PARAM_NAMES.roundedBox).toEqual(["b.x", "b.y", "r.x", "r.y", "r.z", "r.w"])
        expect(SL_SDF_PARAM_NAMES.star).toEqual(["r", "n", "m"])
    })

    it("gives every library function the names its source writes", () => {
        expect(LIB_SIGNATURES.length).toBe(LIB_FUNCTIONS.length)
        LIB_SIGNATURES.forEach((s, i) => {
            expect(s.params.map((p) => p.type), s.name).toEqual(LIB_FUNCTIONS[i]!.params)
            for (const p of s.params) expect(p.name, s.name).toMatch(IDENT)
            expect(new Set(s.params.map((p) => p.name)).size, s.name).toBe(s.params.length)
        })
        const fbm = LIB_SIGNATURES.find((s) => s.name === "sl_fbm")!
        expect(fbm.params.map((p) => `${p.type} ${p.name}`)).toEqual(["float2 p", "int octaves", "int kind"])
    })

    it("names a library builtin after the helper it really lowers to", () => {
        const target: BodyTarget = {
            inputs: { uv: "uv", fragCoord: "fc", resolution: "res", time: "t", aspect: "asp" },
            uniform: (slot) => `u${slot}`, sample: (slot, uv) => `s${slot}(${uv})`, colour: "linear", result: "c",
        }
        // A call to each, returning a float4 whatever the call returns.
        const program: Record<string, string> = {
            hsv2rgb: "float4(hsv2rgb(float3(uv, 0.5)), 1)",
            luminance: "float4(luminance(float3(uv, 0.5)), 0, 0, 1)",
            toLinear: "float4(toLinear(uv.x), 0, 0, 1)",
            sdf: "float4(sdf.circle(uv, 0.5), 0, 0, 1)",
        }
        for (const [name, [helper]] of Object.entries(LIBRARY)) {
            const result = program[name] ?? `float4(${name}(uv), 0, 0, 1)`
            const source = `float4 main() {\n    return ${result};\n}`
            const helpers = emitBody(parse(source, { file: `${name}.sl` }), target).uses.helpers
            expect(helpers, name).toContain(helper)
        }
    })
})

describe("descriptions", () => {
    /** One sentence or two, ending in a full stop, with no dash as punctuation. */
    const line = (what: string, text: string | undefined) => {
        expect(text, `${what} has no description`).toBeDefined()
        expect(text!.length, what).toBeLessThan(100)
        expect(text!, what).toMatch(/\.$/)
        expect(text!, what).not.toMatch(/ [-\u2013\u2014] /)
    }

    it("describes every builtin and nothing else", () => {
        for (const name of Object.keys(BUILTINS)) line(name, BUILTIN_DOCS[name])
        expect(Object.keys(BUILTIN_DOCS).sort()).toEqual(Object.keys(BUILTINS).sort())
    })

    it("describes every input", () => {
        for (const name of Object.keys(INPUTS) as (keyof typeof INPUTS)[]) line(name, INPUT_DOCS[name])
        expect(Object.keys(INPUT_DOCS).sort()).toEqual(Object.keys(INPUTS).sort())
    })

    it("describes every prelude function, from the comment above it", () => {
        const declared = preludeFunctions().map((f) => f.name).sort()
        expect([...PRELUDE_NAMES].sort()).toEqual(declared)
        for (const name of declared) line(name, PRELUDE_DOCS[name])
        expect(PRELUDE_DOCS.rotate).toBe("Rotate a point about the origin. Translate first if you want another centre.")
    })
})
