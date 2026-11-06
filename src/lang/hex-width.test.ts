import { describe, expect, it } from "vitest"
import { parse } from "./index"

/**
 * A hex colour has no width of its own: alone it is a float4, and where a
 * float3 is wanted it is that float3, its alpha dropped. Before, a float3
 * declared from one dropped the alpha, while returning one from a float3
 * function, passing one to a float3 parameter, or a choice or an op beside a
 * float3 was an error (learn Mac, 6 Nov 2026, lessons 7 and 8: "A raymarched
 * scene" and "A path-traced scene").
 *
 * Each form is held to the program spelled out with a float3 declared from
 * the hex, which always worked, so "agrees" means the same program.
 */
const same = (src: string, twin: string) => expect(parse(src).hash).toBe(parse(twin).hash)

describe("a hex colour where a float3 is wanted", () => {
    it("is returned from a float3 function", () => {
        same(
            "float3 tint() { return #ff8000; }\nfloat4 main() { return float4(tint(), 1); }",
            "float3 tint() { float3 c = #ff8000; return c; }\nfloat4 main() { return float4(tint(), 1); }",
        )
    })

    it("is passed to a float3 parameter", () => {
        same(
            "float3 lit(float3 c) { return c * uv.x; }\nfloat4 main() { return float4(lit(#ff8000), 1); }",
            "float3 lit(float3 c) { return c * uv.x; }\nfloat4 main() { float3 k = #ff8000; return float4(lit(k), 1); }",
        )
    })

    it("is a choice between two, returned from a float3 function", () => {
        same(
            "float3 tint(float x) { return x > 0.5 ? #ff8000 : #0080ff; }\nfloat4 main() { return float4(tint(uv.x), 1); }",
            "float3 tint(float x) { float3 c = x > 0.5 ? #ff8000 : #0080ff; return c; }\nfloat4 main() { return float4(tint(uv.x), 1); }",
        )
    })

    it("meets a float3 in a choice, an op and a builtin", () => {
        same(
            "float4 main() { float3 sky = float3(0, 0, uv.y); float3 c = uv.x > 0.5 ? #ff8000 : sky; return float4(c, 1); }",
            "float4 main() { float3 sky = float3(0, 0, uv.y); float3 h = #ff8000; float3 c = uv.x > 0.5 ? h : sky; return float4(c, 1); }",
        )
        same(
            "float4 main() { float3 sky = float3(0, 0, uv.y); return float4(#ff8000 + sky, 1); }",
            "float4 main() { float3 sky = float3(0, 0, uv.y); float3 h = #ff8000; return float4(h + sky, 1); }",
        )
        same(
            "float4 main() { float3 sky = float3(0, 0, uv.y); return float4(lerp(#ff8000, sky, uv.x), 1); }",
            "float4 main() { float3 sky = float3(0, 0, uv.y); float3 h = #ff8000; return float4(lerp(h, sky, uv.x), 1); }",
        )
        same(
            "float4 main() { return float4(float3(#ff8000) * uv.x, 1); }",
            "float4 main() { float3 h = #ff8000; return float4(h * uv.x, 1); }",
        )
    })
})

describe("a hex colour that is a float4", () => {
    it("stays one alone, with its alpha", () => {
        same("float4 main() { return #ff800080; }", "float4 main() { float4 c = #ff800080; return c; }")
        same("float4 main() { return uv.x > 0.5 ? #ff8000 : #0080ff; }", "float4 main() { float4 a = #ff8000; float4 b = #0080ff; return uv.x > 0.5 ? a : b; }")
    })

    it("does not make a computed float4 fit a float3: that is still an error", () => {
        expect(() => parse("float3 t() { return float4(1, 0, 0, 1); }\nfloat4 main() { return float4(t(), 1); }")).toThrow("t is declared to return a float3 and returns a float4")
        expect(() => parse("float4 main() { float4 w = #ff8000; return float4(w + float3(0, 0, 1), 1); }")).toThrow("cannot combine a float4 with a float3")
    })
})
