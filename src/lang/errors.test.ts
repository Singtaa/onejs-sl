import { describe, expect, it } from "vitest"
import { SLParseError } from "./lexer"
import { parse } from "./index"

/**
 * Every refusal, with a place in the file.
 *
 * `Specs/SL_TEXT.md` 3.9. An error without a line is an error an editor cannot
 * put a marker on and a terminal cannot make clickable, so the position is
 * checked here as strictly as the wording. The wording is checked too: most of
 * these exist because the honest answer to "why can I not write this?" is a
 * sentence about how the two backends stay in agreement, and a parser that
 * says "unexpected token" instead has thrown that sentence away.
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

/** Line and column of the caret, as an editor would place it. */
const where = (e: SLParseError): string => `${e.line}:${e.column}`

describe("the lexer", () => {
    it("names a preprocessor directive rather than choking on #", () => {
        const e = refuse("#pragma target 3.0\nfloat4 main() { return #fff; }")
        expect(e.message).toContain("no preprocessor")
        expect(where(e)).toBe("1:1")
    })

    it("finds the start of an unterminated comment, not the end of the file", () => {
        const e = refuse("float4 main() {\n/* off we go\nreturn #fff; }")
        expect(e.message).toContain("never closed")
        expect(where(e)).toBe("2:1")
    })

    it("reads a malformed colour as a colour", () => {
        const e = refuse("float4 main() { return #ggg; }")
        expect(e.message).toContain("#rgb, #rrggbb or #rrggbbaa")
        expect(where(e)).toBe("1:24")
    })
})

describe("the shape of a file", () => {
    it("refuses a file with no main", () => {
        expect(() => parse("float f() { return 1; }")).toThrow(/declares no main/)
    })

    it("refuses two mains", () => {
        expect(() => parse(`
            float4 main() { return #fff; }
            float4 main() { return #000; }
        `)).toThrow(/already declares main/)
    })

    it("refuses a value at the top level, and says where one goes", () => {
        expect(() => parse("float x = 1;\nfloat4 main() { return #fff; }"))
            .toThrow(/Only uniforms, textures, consts and functions live at the top level/)
    })

    it("refuses main with parameters", () => {
        expect(() => parse("float4 main(float2 p) { return #fff; }"))
            .toThrow(/main takes no parameters/)
    })
})

describe("types", () => {
    it("says what to write instead of vec3", () => {
        expect(() => parse("float4 main() { vec3 c = #fff.rgb; return float4(c, 1); }"))
            .toThrow(/"vec3" is not a type here: use float3/)
    })

    it("says why there is no int", () => {
        expect(() => parse("float4 main() { int n = 3; return #fff; }"))
            .toThrow(/there are no integers/)
    })

    it("checks a declaration against what was assigned", () => {
        const e = refuse("float4 main() { float3 c = uv; return float4(c, 1); }")
        expect(e.message).toContain("c is declared float3 and this is a float2")
    })

    it("offers a swizzle when a wider value meets a narrower declaration", () => {
        expect(() => parse("float4 main() { float2 p = float3(uv, 1); return float4(p, 0, 1); }"))
            .toThrow(/Take the components you want with a swizzle, as in \.xy/)
    })

    it("carries the EDSL's own wording, with a line, in the file's type names", () => {
        const e = refuse("float4 main() {\n    float z = uv.z;\n    return float4(z, 0, 0, 1);\n}")
        expect(e.text).toBe("\"z\" is component 3 of a float2, which has 2")
        expect(e.line).toBe(2)
        // A quoted name is the author's, and keeps its spelling.
        const combine = refuse("float4 main() {\n    float3 a = float3(uv, 1);\n    return float4(a + uv, 1);\n}")
        expect(combine.text).toBe("cannot combine a float3 with a float2")
    })
})

describe("what main returns", () => {
    it("points at the return, not at the signature", () => {
        const e = refuse("float4 main() {\n    return uv;\n}")
        expect(e.message).toContain("main returns a float4, a colour with alpha, and this returns a float2")
        expect(where(e)).toBe("2:5")
    })

    it("names a scalar return for what it is", () => {
        const e = refuse("float4 main() {\n    return 1;\n}")
        expect(e.message).toContain("this returns a single number")
        expect(e.line).toBe(2)
    })
})

describe("names", () => {
    it("suggests the nearest declared name", () => {
        expect(() => parse(`
            uniform float warp = 0.5;
            float4 main() { return float4(wrap, 0, 0, 1); }
        `)).toThrow(/"wrap" is not declared; did you mean warp\?/)
    })

    it("answers a GLSL spelling with the HLSL one", () => {
        expect(() => parse("float4 main() { return float4(mix(0, 1, uv.x), 0, 0, 1); }"))
            .toThrow(/mix is GLSL; this is HLSL, so write lerp/)
        expect(() => parse("float4 main() { return float4(fract(uv.x), 0, 0, 1); }"))
            .toThrow(/write frac/)
    })

    it("answers a name that has an opcode and no implementation", () => {
        expect(() => parse("float4 main() { return float4(rgb2hsv(#fff.rgb), 1); }"))
            .toThrow(/rgb2hsv has an opcode but no implementation/)
    })

    it("refuses a declaration that takes an existing name", () => {
        expect(() => parse(`
            uniform float time = 1;
            float4 main() { return #fff; }
        `)).toThrow(/"time" already names an input/)
        expect(() => parse(`
            float wobble(float x) { return x; }
            float4 main() { float wobble = 1; return float4(wobble, 0, 0, 1); }
        `)).toThrow(/"wobble" already names a function/)
    })

    it("refuses calling a name that a value has taken, where the value is visible", () => {
        const e = refuse("float4 main() {\n    float circle = 0.2;\n    return float4(circle(uv, 0.1), 0, 0, 1);\n}")
        expect(e.message).toContain("\"circle\" is a local here, so it cannot be called")
        expect(where(e)).toBe("3:19")
        expect(() => parse("uniform float noise = 1;\nfloat4 main() { return float4(noise(uv), 0, 0, 1); }"))
            .toThrow(/"noise" is a uniform here/)
    })

    it("refuses assigning to something that is not a local", () => {
        expect(() => parse(`
            uniform float k = 1;
            float4 main() { k = 2; return float4(k, 0, 0, 1); }
        `)).toThrow(/"k" is a uniform and cannot be assigned to/)
    })

    it("refuses a swizzle that writes a component twice, or one the local does not have", () => {
        const body = (w: string) => `float4 main() {\n    float2 p = uv;\n    ${w}\n    return float4(p, 0, 1);\n}`
        expect(refuse(body("p.xx = 0;")).message).toContain("xx names a component twice")
        const e = refuse(body("p.z = 0;"))
        expect(e.message).toContain("z writes a component a float2 does not have")
        expect(e.line).toBe(3)
        expect(refuse(body("p.xg = 0;")).message).toContain("xg is not a swizzle that can be assigned to")
        expect(refuse(body("p.xy = float3(uv, 1);")).message).toContain("xy is 2 components and this is a float3")
    })

    it("refuses writing through a swizzle of something that is not a local", () => {
        expect(() => parse("float4 main() { uv.x = 0; return float4(uv, 0, 1); }"))
            .toThrow(/"uv" is an input and cannot be assigned to/)
    })
})

describe("budgets", () => {
    it("reports too many uniforms at the one that went over", () => {
        const decls = Array.from({ length: 17 }, (_, i) => `uniform float u${i} = 0;`).join("\n")
        const e = refuse(`${decls}\nfloat4 main() { return float4(u0, 0, 0, 1); }`)
        expect(e.message).toContain("a program may hold 16")
        expect(e.line).toBe(17)
    })

    it("reports too many textures, and why a fifth cannot work", () => {
        const decls = Array.from({ length: 5 }, (_, i) => `texture2D t${i};`).join("\n")
        const e = refuse(`${decls}\nfloat4 main() { return tex2D(t0, uv); }`)
        expect(e.message).toContain("two different pictures from one file")
        expect(e.line).toBe(5)
    })
})

describe("control flow", () => {
    it("refuses a return inside an if, and offers the alternative", () => {
        expect(() => parse(`
            float4 main() {
                if (uv.x > 0.5) { return #fff; }
                return #000;
            }
        `)).toThrow(/has nothing to skip.*or use \?:/s)
    })

    it("refuses code after a return", () => {
        expect(() => parse(`
            float4 main() {
                return #fff;
                float x = 1;
            }
        `)).toThrow(/after the return, so it can never run/)
    })

    it("refuses a while loop and says which loop it can compile", () => {
        expect(() => parse("float4 main() { while (1) { } return #fff; }"))
            .toThrow(/only a for loop with constant bounds can/)
    })

    it("refuses a loop bound that is not constant", () => {
        expect(() => parse(`
            uniform float count = 4;
            float4 main() {
                float v = 0;
                for (int i = 0; i < count; i++) { v = v + 1; }
                return float4(v, 0, 0, 1);
            }
        `)).toThrow(/its bound has to be a constant/)
    })

    it("refuses a loop that would unroll past the ceiling", () => {
        expect(() => parse(`
            float4 main() {
                float v = 0;
                for (int i = 0; i < 500; i++) { v = v + uv.x; }
                return float4(v, 0, 0, 1);
            }
        `)).toThrow(/more than 64 iterations/)
    })

    it("refuses assigning to a loop counter", () => {
        expect(() => parse(`
            float4 main() {
                float v = 0;
                for (int i = 0; i < 4; i++) { i = 2; v = v + i; }
                return float4(v, 0, 0, 1);
            }
        `)).toThrow(/"i" is a loop counter/)
    })

    it("refuses recursion by naming the cycle", () => {
        expect(() => parse(`
            float a(float x) { return b(x); }
            float b(float x) { return a(x); }
            float4 main() { return float4(a(uv.x), 0, 0, 1); }
        `)).toThrow(/a calls b calls a/)
    })
})

describe("calls", () => {
    it("counts arguments", () => {
        expect(() => parse("float4 main() { return float4(sin(uv.x, 1), 0, 0, 1); }"))
            .toThrow(/sin takes 1 argument, got 2/)
    })

    it("counts a user function's arguments", () => {
        expect(() => parse(`
            float ring(float2 p, float r) { return length(p) - r; }
            float4 main() { return float4(ring(uv), 0, 0, 1); }
        `)).toThrow(/ring takes 2 arguments, got 1/)
    })

    it("says how to call a shape when sdf is used bare", () => {
        expect(() => parse("float4 main() { return float4(sdf(uv, 0.25), 0, 0, 1); }"))
            .toThrow(/sdf names a family of shapes/)
    })

    it("refuses an operand width the two backends would read differently", () => {
        // The VM writes a.xy whatever the register holds; the generated HLSL
        // passes the real type. A float3 here works in the browser and warns or
        // fails to compile after an eject.
        expect(() => parse("float4 main() { return float4(noise(float3(uv, 1)), 0, 0, 1); }"))
            .toThrow(/noise takes a float2 to sample at, and this is a float3/)
        expect(() => parse("float4 main() { return float4(luminance(uv.x), 0, 0, 1); }"))
            .toThrow(/luminance takes a colour, so a float3 or a float4/)
        expect(() => parse("float4 main() { return float4(hsv2rgb(uv), 0, 1); }"))
            .toThrow(/hsv2rgb takes a float3 of hue, saturation and value/)
    })

    it("refuses a shape that does not exist", () => {
        expect(() => parse("float4 main() { return float4(sdf.blob(uv, 1), 0, 0, 1); }"))
            .toThrow(/"blob" is not a shape/)
    })

    it("refuses a shape parameter that is not constant", () => {
        expect(() => parse(`
            uniform float r = 0.25;
            float4 main() { return float4(sdf.circle(uv - 0.5, r), 0, 0, 1); }
        `)).toThrow(/ride inside the instruction, so they have to be constants/)
    })

    it("refuses a ramp stop that is not a colour", () => {
        expect(() => parse(`
            uniform float4 hot = #ff0000;
            float4 main() { return ramp(uv.x, #000000, hot); }
        `)).toThrow(/a ramp's stops are constants, written as colours/)
    })

    it("explains that a texture is only ever tex2D's first argument", () => {
        expect(() => parse(`
            texture2D art;
            float4 main() { return art * 2; }
        `)).toThrow(/a texture is only ever the first argument of tex2D/)
    })

    it("refuses a uniform default that is not written out", () => {
        expect(() => parse(`
            uniform float k = time;
            float4 main() { return float4(k, 0, 0, 1); }
        `)).toThrow(/baked into the program before anything runs/)
    })
    it("refuses atan2 of vectors, whose one result every backend read differently", () => {
        const e = refuse("float4 main() {\n    return float4(atan2(uv, uv), 0, 1);\n}")
        expect(e.message).toContain("atan2 takes two floats, and this is a float2")
        expect(e.line).toBe(2)
        expect(() => parse("float4 main() { return float4(atan2(uv.y, uv.x), 0, 0, 1); }")).not.toThrow()
    })
})
