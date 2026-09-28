import { describe, expect, it } from "vitest"
import { fromJSON, toJSON } from "../serial"
import * as sl from "../sl"
import { classify } from "./classify"
import { diagnose, parse } from "./index"

/**
 * Attributes on uniforms (`Specs/SL_NEXT.md` 1): what each one gives a host,
 * that none of them changes what a program computes, and what each refusal
 * says and where it points.
 */

const main = "\nfloat4 main() { return float4(uv, 0, 1); }\n"
const errors = (head: string) => diagnose(head + main).map((e) => `${e.line}:${e.column} ${e.text}`)
/** The one error for `head`, with the text it marks. */
const refusal = (head: string) => {
    const es = diagnose(head + main)
    expect(es, es.map((e) => e.text).join("\n")).toHaveLength(1)
    const e = es[0]!
    return { text: e.text, marks: (head + main).slice(e.offset, e.offset + e.length), fix: e.fix }
}

describe("what a host is given", () => {
    const SPEC = [
        "[Header(\"Shape\")]",
        "[Range(0, 2)] uniform float warp = 1;",
        "[Range(1, 16, 1)] uniform float petals = 5;",
        "[Toggle] uniform float invert = 0;",
        "[Enum(Soft, Hard, Glow)] uniform float edge = 0;",
        "[Label(\"Glow colour\")] uniform float4 tint = #ff8040;",
        "[Color] uniform float4 base = float4(1, 1, 1, 1);",
        "[Hide] uniform float seed = 0;",
    ].join("\n")

    it("reads the spec's list, in declaration order", () => {
        // The Header is on warp: it heads the group warp starts.
        const us = parse(SPEC.replace("[Header(\"Shape\")]\n", "[Header(\"Shape\")] ") + main).uniforms
        expect(us.map(({ name, value, ...rest }) => ({ name, ...rest, value }))).toEqual([
            { name: "warp", type: 1, range: { min: 0, max: 2 }, header: "Shape", value: [1] },
            { name: "petals", type: 1, range: { min: 1, max: 16, step: 1 }, value: [5] },
            { name: "invert", type: 1, toggle: true, value: [0] },
            { name: "edge", type: 1, options: ["Soft", "Hard", "Glow"], value: [0] },
            { name: "tint", type: 4, colour: true, label: "Glow colour", value: [1, 128 / 255, 64 / 255, 1] },
            { name: "base", type: 4, colour: true, value: [1, 1, 1, 1] },
            { name: "seed", type: 1, hide: true, value: [0] },
        ])
    })

    it("takes attributes on one line or on the lines above, in any order", () => {
        const a = parse("[Label(\"Amount\")]\n[Range(0, 1)]\nuniform float k = 0.5;" + main).uniforms[0]
        const b = parse("[Range(0, 1)] [Label(\"Amount\")] uniform float k = 0.5;" + main).uniforms[0]
        expect(a).toEqual(b)
        expect(a).toMatchObject({ range: { min: 0, max: 1 }, label: "Amount" })
    })

    it("reads a negative range, a bare word as a heading, and a string as an option", () => {
        const u = parse("[Header(Motion)] [Range(-1, 1)] uniform float drift = -0.5;\n[Enum(\"Soft edge\", Hard)] uniform float e = 1;" + main).uniforms
        expect(u[0]).toMatchObject({ header: "Motion", range: { min: -1, max: 1 } })
        expect(u[1]).toMatchObject({ options: ["Soft edge", "Hard"] })
    })

    it("reads a quote and a backslash inside a string", () => {
        expect(parse("[Label(\"say \\\"hi\\\" \\\\ bye\")] uniform float g = 0;" + main).uniforms[0]!.label).toBe("say \"hi\" \\ bye")
    })

    it("changes no hash: a control is metadata, as a colour flag is", () => {
        const plain = "uniform float warp = 1;\nuniform float edge = 2;\nuniform float4 tint = #ff8040;\nfloat4 main() { return tint * warp * edge; }"
        const dressed = "[Header(\"Look\")] [Range(0, 2, 0.5)] [Label(\"Warp\")] uniform float warp = 1;\n" +
            "[Enum(A, B, C)] uniform float edge = 2;\n[Hide] [Color] uniform float4 tint = #ff8040;\nfloat4 main() { return tint * warp * edge; }"
        expect(parse(dressed).hash).toBe(parse(plain).hash)
    })

    it("[Color] is a hex default written as numbers: the same program", () => {
        expect(parse("[Color] uniform float4 c = float4(1, 1, 1, 1);\nfloat4 main() { return c; }").hash)
            .toBe(parse("uniform float4 c = #ffffff;\nfloat4 main() { return c; }").hash)
        expect(parse("[Color] uniform float3 c = float3(1, 0, 0);\nfloat4 main() { return float4(c, 1); }").uniforms[0])
            .toMatchObject({ colour: true, value: [1, 0, 0] })
    })

    it("survives toJSON and fromJSON", () => {
        const p = parse("[Range(0, 2, 0.25)] [Header(\"A\")] [Label(\"B\")] uniform float w = 1;\n[Enum(X, Y)] [Hide] uniform float e = 1;\n[Toggle] uniform float t = 1;" + main)
        const back = fromJSON(JSON.parse(JSON.stringify(toJSON(p))))
        expect(back.uniforms).toEqual(p.uniforms)
        expect(back.hash).toBe(p.hash)
    })

    it("refuses a saved program edited into a control a host would choke on", () => {
        const json = toJSON(parse("[Range(0, 2)] uniform float w = 1;" + main))
        const edit = (range: unknown) => ({ ...json, uniforms: [{ ...json.uniforms[0]!, range }] })
        expect(() => fromJSON(edit({ min: 0, max: 0.5 }))).toThrow(/uniform 0: the default 1 is outside the range 0 to 0.5/)
        expect(() => fromJSON(edit({ min: "0", max: 2 }))).toThrow(/uniform 0's range needs a min and a max/)
    })

    it("the EDSL writes the same program as the file", () => {
        const edsl = sl.program(({ uv }) => {
            const w = sl.uniform.float("warp", 1, { range: { min: 0, max: 2 }, label: "Warp" })
            return sl.vec4(uv.mul(w), 0, 1)
        })
        const file = parse("[Range(0, 2)] [Label(\"Warp\")] uniform float warp = 1;\nfloat4 main() { return float4(uv * warp, 0, 1); }")
        expect(toJSON(edsl)).toEqual(toJSON(file))
    })

    it("lets a second read in the EDSL say nothing, or the same, and refuses a different control", () => {
        const p = sl.program(({ uv }) => {
            const a = sl.uniform.float("k", 1, { range: { min: 0, max: 2 } })
            const b = sl.uniform.float("k", 1)
            const c = sl.uniform.float("k", 1, { range: { min: 0, max: 2 }, label: "K" })
            return sl.vec4(uv, a.add(b).add(c), 1)
        })
        expect(p.uniforms).toEqual([{ name: "k", type: 1, value: [1], range: { min: 0, max: 2 }, label: "K" }])
        expect(() => sl.program(({ uv }) => {
            sl.uniform.float("k", 1, { range: { min: 0, max: 2 } })
            return sl.vec4(uv, sl.uniform.float("k", 1, { range: { min: 0, max: 3 } }), 1)
        })).toThrow(/uniform "k" is given two different ranges/)
    })

    it("refuses in the EDSL what it refuses in a file", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(uv, sl.uniform.float("k", 5, { range: { min: 0, max: 2 } }), 1)))
            .toThrow(/uniform "k": the default 5 is outside the range 0 to 2/)
        expect(() => sl.program(({ uv }) => sl.vec4(uv.mul(sl.uniform.vec2("k", [0, 0], { toggle: true })), 0, 1)))
            .toThrow(/uniform "k": \[Toggle\] is for a float, and this is a vec2/)
    })

    it("classifies an attribute's name and its strings", () => {
        const kinds = classify("[Label(\"Glow\")] uniform float g = 0;").map((t) => `${t.kind}:${t.text}`)
        expect(kinds.slice(0, 6)).toEqual(["punct:[", "attribute:Label", "punct:(", "string:\"Glow\"", "punct:)", "punct:]"])
    })
})

describe("what each refusal says, and marks", () => {
    it.each([
        ["[Range(0, 2)] uniform float2 w = float2(0, 0);", "Range", "[Range] is for a float, and this is a float2"],
        ["[Range(0, 2)] uniform float w = 5;", "Range", "the default 5 is outside the range 0 to 2"],
        ["[Range(2, 0)] uniform float w = 1;", "Range", "a range runs from a smaller number to a larger one, and this is 2 to 0"],
        ["[Range(0, 2, 0)] uniform float w = 1;", "Range", "a range's step is a number above 0, and this is 0"],
        ["[Range(0)] uniform float w = 0;", "Range", "[Range] takes a minimum, a maximum and an optional step, all numbers: [Range(0, 1)] or [Range(1, 16, 1)]"],
        ["[Toggle] uniform float t = 2;", "Toggle", "a toggle is 0 or 1, and the default is 2"],
        ["[Toggle(1)] uniform float t = 0;", "1", "[Toggle] takes no arguments"],
        ["[Enum(Soft, 0, Hard, 1)] uniform float e = 0;", "0", "[Enum] lists names only, as in [Enum(Soft, Hard, Glow)]; the value is the chosen name's index, from 0"],
        ["[Enum(Soft, Hard)] uniform float e = 2;", "Enum", "an enum's value is the index of an option, 0 to 1, and the default is 2"],
        ["[Enum(Soft)] uniform float e = 0;", "Enum", "an enum lists at least two options"],
        ["[Enum(A, B, A)] uniform float e = 0;", "Enum", "the enum lists \"A\" twice"],
        ["[Range(0, 1)] [Toggle] uniform float t = 0;", "Toggle", "a uniform is one control, so it cannot have both [Range] and [Toggle]"],
        ["[Color] uniform float c = 0;", "Color", "[Color] is for a float3 or a float4, and this is a float"],
        ["[Header] uniform float h = 0;", "Header", "[Header] takes a heading in quotes, as in [Header(\"Shape\")]"],
        ["[Label(\"\")] uniform float h = 0;", "Label", "[Label] needs some text"],
        ["[Hide] [Hide] uniform float h = 0;", "Hide", "this uniform already has [Hide]"],
    ])("%s", (head, marks, text) => {
        const r = refusal(head)
        expect(r.text).toBe(text)
        expect(r.marks).toBe(marks)
    })

    it("offers Unity's and English spellings as one click", () => {
        for (const [from, to] of [["Colour", "Color"], ["HideInInspector", "Hide"], ["ToggleUI", "Toggle"], ["range", "Range"]] as const) {
            const r = refusal(`[${from}] uniform float4 c = float4(0, 0, 0, 1);`.replace("float4 c = float4(0, 0, 0, 1)", to === "Color" ? "float4 c = float4(0, 0, 0, 1)" : "float c = 0"))
            expect(r.marks).toBe(from)
            expect(r.text).toBe(`"${from}" is not an attribute; the attributes are Range, Toggle, Enum, Header, Label, Color and Hide. Did you mean ${to}?`)
            expect(r.fix).toEqual({ title: `Replace ${from} with ${to}`, replacement: to })
        }
        expect(refusal("[IntRange(0, 4)] uniform float n = 0;").text).toMatch(/Did you mean Range\?; a whole number slider is \[Range\(min, max, 1\)\]$/)
    })

    it("refuses an attribute on anything but a uniform", () => {
        expect(errors("[Range(0, 1)] texture2D noise;")).toEqual([
            "1:1 an attribute belongs on a uniform, as in `[Range(0, 1)] uniform float amount = 0.5;`, and this one is followed by \"texture2D\"",
        ])
    })

    it("says a string is only an attribute's argument, and marks one never closed", () => {
        expect(diagnose("float4 main() { return float4(\"red\", 0, 0, 1); }").map((e) => e.text))
            .toEqual(["a string is only an attribute's argument, as in [Label(\"Glow colour\")]; a value is a number"])
        expect(diagnose("[Label(\"Glow)] uniform float g = 0;" + main).map((e) => e.text))
            .toContain("this string is never closed; it ends at the end of its line")
    })

    it("finds a mistake in each attribute, and each uniform", () => {
        expect(errors("[Colour] [Range(0)] uniform float4 c = float4(0, 0, 0, 1);\n[Hide(1)] uniform float h = 0;")).toEqual([
            "1:2 \"Colour\" is not an attribute; the attributes are Range, Toggle, Enum, Header, Label, Color and Hide. Did you mean Color?",
            "1:11 [Range] takes a minimum, a maximum and an optional step, all numbers: [Range(0, 1)] or [Range(1, 16, 1)]",
            "2:7 [Hide] takes no arguments",
        ])
    })
})
