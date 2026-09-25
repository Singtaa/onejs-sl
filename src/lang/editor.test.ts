import { describe, expect, it } from "vitest"
import { SLParseError } from "./lexer"
import { classify, parse, SL_KEYWORDS, SL_TYPES } from "./index"
import { PRELUDE_SOURCE } from "./prelude-source"

/**
 * What an editor needs from the package (`Specs/SL_NEXT.md` 5 and 9): an error
 * it can mark without parsing its message, a fix it can offer as one click, and
 * a highlighter that agrees with the parser.
 */

function refuse(source: string): SLParseError {
    try {
        parse(source, { file: "test.sl" })
    } catch (e) {
        if (e instanceof SLParseError) return e
        throw e
    }
    throw new Error("expected this to be refused, and it was not")
}

/** The source with the error's fix applied, as an editor's action would. */
function applyFix(source: string, e: SLParseError): string {
    expect(e.fix, e.text).toBeDefined()
    return source.slice(0, e.offset) + e.fix!.replacement + source.slice(e.offset + e.length)
}

const marked = (source: string, e: SLParseError) => source.slice(e.offset, e.offset + e.length)

describe("an error's fields", () => {
    it("carries its text without the tag and the file:line:col", () => {
        const e = refuse("float4 main() {\n    return float4(mix(0, 1, uv.x), 0, 0, 1);\n}")
        expect(e.message).toBe("[onejs sl] test.sl:2:19: mix is GLSL; this is HLSL, so write lerp")
        expect(e.text).toBe("mix is GLSL; this is HLSL, so write lerp")
    })

    it("carries the offset of the range it marks", () => {
        const src = "float4 main() {\n    return float4(mix(0, 1, uv.x), 0, 0, 1);\n}"
        expect(marked(src, refuse(src))).toBe("mix")
    })

    it("marks the last token for what is missing at the end of a line", () => {
        const src = "float4 main() {\n    float a = 1\n    return float4(a, 0, 0, 1);\n}"
        const e = refuse(src)
        expect(e.text).toBe(`expected ";" after a declaration, got "return"`)
        expect([e.line, e.column, marked(src, e)]).toEqual([2, 15, "1"])
    })

    it("marks the last token for what is missing at the end of the file", () => {
        const src = "float4 main() {\n    return float4(1, 0, 0, 1);"
        const e = refuse(src)
        expect(e.text).toBe("this body is never closed")
        expect(marked(src, e)).toBe(";")
    })
})

describe("fixes", () => {
    const main = (body: string) => `float4 main() {\n    ${body}\n}`

    it("renames a GLSL spelling to one that compiles", () => {
        for (const body of [
            "return float4(mix(0, 1, uv.x), 0, 0, 1);",
            "return float4(fract(uv * 4), 0, 1);",
            "return float4(vec3(uv, 0), 1);",
            "return float4(gl_FragCoord.xy / resolution, 0, 1);",
            "return float4(sin(iTime), 0, 0, 1);",
            "return float4(uv * iResolution.xy, 0, 1);",
            "return float4(atan(uv.y, uv.x), 0, 0, 1);",
            "vec3 c = float3(uv, 0); return float4(c, 1);",
        ]) {
            const src = main(body)
            const fixed = applyFix(src, refuse(src))
            expect(() => parse(fixed), fixed).not.toThrow()
        }
    })

    it("says what it does", () => {
        expect(refuse(main("return float4(mix(0, 1, uv.x), 0, 0, 1);")).fix!.title).toBe("Replace mix with lerp")
    })

    it("offers the name it suggests", () => {
        const src = "uniform float warp = 1;\nfloat4 main() {\n    return float4(uv * wrap, 0, 1);\n}"
        const e = refuse(src)
        expect(e.text).toBe(`"wrap" is not declared; did you mean warp?`)
        expect(() => parse(applyFix(src, e))).not.toThrow()
    })

    it("offers none where the rename would change what the program means", () => {
        // mod floors and % truncates; ivec2 truncates; one argument atan is not atan2;
        // int is a counter's type, and float would change what dividing it does.
        for (const body of [
            "return float4(mod(uv.x, 0.5), 0, 0, 1);",
            "return float4(ivec2(uv), 0, 1);",
            "return float4(atan(uv.x), 0, 0, 1);",
            "int n = 3; return float4(n, 0, 0, 1);",
            "return gl_FragColor;",
        ]) {
            const e = refuse(main(body))
            expect(e.fix, e.text).toBeUndefined()
        }
    })
})

describe("GLSL names used as values", () => {
    it("gets the hint, not just \"is not declared\"", () => {
        const e = refuse("float4 main() {\n    float2 p = gl_FragCoord.xy;\n    return float4(p, 0, 1);\n}")
        expect(e.text).toBe("gl_FragCoord is GLSL; this is HLSL, so write fragCoord")
        expect([e.line, e.column, e.length]).toEqual([2, 16, 12])
    })
})

describe("statements that do not exist", () => {
    it.each([
        ["break", "there is no break: a for loop unrolls, so every iteration runs"],
        ["continue", "there is no continue: a for loop unrolls, so every iteration runs"],
        ["switch", "there is no switch; write it as an if and else if"],
    ])("names %s", (word, text) => {
        const body = word === "switch" ? "switch (uv.x) { }" : `${word};`
        const e = refuse(`float4 main() {\n    for (int i = 0; i < 2; i++) { ${body} }\n    return #fff;\n}`)
        expect(e.text.startsWith(text), e.text).toBe(true)
        expect(e.length).toBe(word.length)
    })
})

describe("the word lists", () => {
    it("are what the parser refuses as a name", () => {
        for (const word of [...SL_KEYWORDS, ...SL_TYPES]) {
            const e = refuse(`float4 main() {\n    float ${word} = 1;\n    return #fff;\n}`)
            expect(e.text).toMatch(new RegExp(`^"${word}" is a (keyword|type), so it cannot be a local's name$`))
        }
    })

    it("are every word the parser reads", () => {
        // One program with every keyword and type in it compiles, so none of them is spurious.
        const src = [
            "uniform float a = 1;", "uniform float2 b = 0;", "uniform float3 c = 0;", "uniform float4 d = 0;",
            "texture2D t;", "const float k = 2;",
            "float4 main() {",
            "    float s = 0;",
            "    for (int i = 0; i < 2; i++) { s += i; }",
            "    if (s > 1) { s = 1; } else { s = 0; }",
            "    return tex2D(t, uv) * float4(c, a) + d + float4(b, s, k);",
            "}",
        ].join("\n")
        expect(() => parse(src)).not.toThrow()
        const read = new Set(classify(src).filter((t) => t.kind === "keyword" || t.kind === "type").map((t) => t.text))
        expect([...read].sort()).toEqual([...SL_KEYWORDS, ...SL_TYPES].sort())
    })
})

describe("classify", () => {
    const kinds = (src: string) => classify(src).map((t) => `${t.kind}:${t.text}`)

    it("names what each token is", () => {
        expect(kinds("uniform float3 tint = #ff8040; // warm\nfloat4 main() { return float4(rotate(uv, time) * sin(tint.x), 0, 1.0f); }")).toEqual([
            "keyword:uniform", "type:float3", "ident:tint", "punct:=", "hex:#ff8040", "punct:;", "comment:// warm",
            "type:float4", "ident:main", "punct:(", "punct:)", "punct:{", "keyword:return", "type:float4", "punct:(",
            "prelude:rotate", "punct:(", "input:uv", "punct:,", "input:time", "punct:)", "punct:*", "builtin:sin",
            "punct:(", "ident:tint", "punct:.", "member:x", "punct:)", "punct:,", "number:0", "punct:,",
            "number:1.0", "punct:)", "punct:;", "punct:}",
        ])
    })

    it("reads a shape after sdf as a builtin, and a comment between does not change that", () => {
        expect(kinds("sdf . /* the shape */ circle")).toEqual(["builtin:sdf", "punct:.", "comment:/* the shape */", "builtin:circle"])
    })

    it("covers exactly the characters of each token", () => {
        const src = "float4 main() {\n    /* a\n       b */ return float4(1.5f, #fff.rg, 2e3);\n}"
        for (const t of classify(src)) {
            const covered = src.slice(t.offset, t.offset + t.length)
            expect(covered.startsWith(t.text), `${t.kind} ${t.text}`).toBe(true)
            expect(covered.replace(/^[\d.eE+-]+[fF]$/, (s) => s.slice(0, -1))).toBe(t.text)
            const before = src.slice(0, t.offset).split("\n")
            expect([t.line, t.col]).toEqual([before.length, before[before.length - 1]!.length + 1])
        }
    })

    it("marks what it cannot read and carries on", () => {
        expect(kinds("float a @ b; #pragma x\n/* open")).toEqual([
            "type:float", "ident:a", "invalid:@", "ident:b", "punct:;", "invalid:#pragma", "ident:x", "comment:/* open",
        ])
    })

    it("never throws, at any point while a file is typed", () => {
        const src = `${PRELUDE_SOURCE}\nfloat4 main() { return float4(palette(uv.x, 0.5, 0.5, 1, #00ff80), 1); } #zz @`
        for (let i = 0; i <= src.length; i++) expect(() => classify(src.slice(0, i))).not.toThrow()
    })
})
