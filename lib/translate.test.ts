import { describe, expect, it } from "vitest"
import { check, parseLibrary, Printer, printedName, type Lang } from "./translate"

/**
 * The translator on small inputs. Whether its output of the real library
 * compiles and draws what the VM draws is proven in a browser (`npm run
 * goldens`, and `Tools/sl-web-parity` in the container); these pin the rules
 * that make it so, one at a time, so a rule that breaks names itself.
 */

function print(src: string, lang: Lang): string {
    const c = check(parseLibrary(src, "t.hlsl"))
    const p = new Printer(c, lang)
    return c.fns.map((_, i) => p.fn(i, printedName(c, i, lang))).join("\n")
}

const refuses = (src: string, why: RegExp) => expect(() => check(parseLibrary(src, "t.hlsl"))).toThrow(why)

describe("the library translator", () => {
    it("makes HLSL's silent int to float conversions explicit", () => {
        const src = `float f(int o, float seed) { float sum = 0; sum += seed + o * 19.0; return sum; }`
        const glsl = print(src, "glsl")
        expect(glsl).toContain("float sum = 0.0;")
        expect(glsl).toContain("seed + float(o) * 19.0")
        expect(print(src, "wgsl")).toContain("seed + f32(o) * 19.0")
        expect(print(src, "hlsl")).toContain("seed + float(o) * 19.0")
    })

    it("widens a scalar an intrinsic broadcasts, in each language's own way", () => {
        const src = `float2 f(float2 q, float t) { return max(q, 0.0) + lerp(q, q.yx, t); }`
        expect(print(src, "glsl")).toContain("max(q, vec2(0.0)) + mix(q, q.yx, vec2(t))")
        expect(print(src, "wgsl")).toContain("max(q, vec2f(0.0)) + mix(q, q.yx, vec2f(t))")
        // HLSL refuses float2(x) and Metal refuses x.xx, so the shared subset repeats it.
        expect(print(src, "hlsl")).toContain("max(q, float2(0.0, 0.0)) + lerp(q, q.yx, float2(t, t))")
        const costly = `float2 f(float2 q, float t) { return lerp(q, q.yx, t * 2.0); }`
        expect(() => print(costly, "hlsl")).toThrow(/cannot widen this scalar/)
        expect(print(costly, "glsl")).toContain("vec2(t * 2.0)")
    })

    it("gives WGSL a mutable copy of a parameter the HLSL assigns", () => {
        const wgsl = print(`float f(float2 p, float r) { p = abs(p); return p.x - r; }`, "wgsl")
        expect(wgsl).toContain("fn f(pIn: vec2f, r: f32) -> f32 {\n    var p: vec2f = pIn;")
        expect(print(`float f(float2 p) { return p.x; }`, "wgsl")).toContain("fn f(p: vec2f)")
    })

    it("declares let for what is never assigned and var for what is", () => {
        const wgsl = print(`float f(float x) { float a = x; float b = x; b *= 2.0; float c; c = a; return b + c; }`, "wgsl")
        expect(wgsl).toContain("let a: f32 = x;")
        expect(wgsl).toContain("var b: f32 = x;")
        expect(wgsl).toContain("var c: f32;")
    })

    it("rebuilds a vector for WGSL, which cannot assign through a swizzle of several components", () => {
        const src = `float4 f(float4 r, float2 d) { r.yw -= d; r.x = 1.0; return r; }`
        const wgsl = print(src, "wgsl")
        expect(wgsl).toContain("let sl_v: vec2f = r.yw - d;")
        expect(wgsl).toContain("r = vec4f(r.x, sl_v.x, r.z, sl_v.y);")
        expect(wgsl).toContain("r.x = 1.0;")
        expect(print(src, "glsl")).toContain("r.yw -= d;")
    })

    it("prints the ternary as select for WGSL, false branch first", () => {
        const src = `float f(float x) { return x > 0.0 ? 1.0 : -1.0; }`
        expect(print(src, "wgsl")).toContain("return select(-1.0, 1.0, x > 0.0);")
        expect(print(src, "glsl")).toContain("return x > 0.0 ? 1.0 : -1.0;")
    })

    it("parenthesises && inside || for WGSL, which refuses to mix them bare", () => {
        const src = `float f(float a, float b) { return (a > 0.0 || a < b && b > 1.0) ? 1.0 : 0.0; }`
        expect(print(src, "wgsl")).toContain("a > 0.0 || (a < b && b > 1.0)")
        expect(print(src, "glsl")).toContain("a > 0.0 || a < b && b > 1.0")
    })

    it("writes the row vector rotation out, in every language", () => {
        const src = `float2 f(float2 q, float2 d) { return mul(q, float2x2(d.x, -d.y, d.y, d.x)); }`
        const want = "(q.x * d.x + q.y * d.y, q.x * (-d.y) + q.y * d.x)"
        expect(print(src, "glsl")).toContain(`vec2${want}`)
        expect(print(src, "wgsl")).toContain(`vec2f${want}`)
        expect(print(src, "hlsl")).toContain(`float2${want}`)
    })

    it("spells intrinsics and casts per language, and drops in and [unroll]", () => {
        const src = `float f(in float2 p) { float s = 0.0; [unroll(4)] for (int i = 0; i < 4; i++) { s += frac(atan2(p.y, p.x)) + (int)p.x; } return saturate(s); }`
        const glsl = print(src, "glsl")
        expect(glsl).toContain("fract(atan(p.y, p.x)) + float(int(p.x))")
        expect(glsl).toContain("return clamp(s, 0.0, 1.0);")
        expect(glsl).not.toContain("unroll")
        const wgsl = print(src, "wgsl")
        expect(wgsl).toContain("for (var i: i32 = 0; i < 4; i++) {")
        expect(wgsl).toContain("fract(atan2(p.y, p.x)) + f32(i32(p.x))")
        const hlsl = print(src, "hlsl")
        expect(hlsl).toContain("float f(float2 p) {")
        expect(hlsl).toContain("frac(atan2(p.y, p.x)) + float((int)p.x)")
        expect(hlsl).not.toContain("unroll")
    })

    it("names an overloaded function by its signature in WGSL only", () => {
        const src = `float2 m(float2 x) { return x; }\nfloat3 m(float3 x) { return x; }\nfloat g(float2 v) { return m(v).x; }`
        const wgsl = print(src, "wgsl")
        expect(wgsl).toContain("fn m_f2(x: vec2f)")
        expect(wgsl).toContain("fn m_f3(x: vec3f)")
        expect(wgsl).toContain("return m_f2(v).x;")
        expect(print(src, "glsl")).toContain("return m(v).x;")
    })

    it("prints a switch with a block per case for WGSL", () => {
        const src = `float f(int id) { switch (id) { case 0: return 1.0; default: return 2.0; } }`
        expect(print(src, "wgsl")).toContain("switch (id) {\n        case 0: {\n            return 1.0;\n        }\n        default: {")
        expect(print(src, "glsl")).toContain("switch (id) {\n        case 0:\n            return 1.0;\n        default:")
    })

    it("reads the colour switch and nothing else of the preprocessor", () => {
        const fns = parseLibrary(`#ifdef UNITY_COLORSPACE_GAMMA\nfloat f(float c) { return c; }\n#else\nfloat f(float c) { return c * c; }\n#endif`, "t.hlsl")
        expect(fns.map((f) => f.colour)).toEqual(["gamma", "linear"])
        expect(() => check(fns)).not.toThrow()
        refuses(`#define X 1\nfloat f() { return 1.0; }`, /outside the subset/)
        refuses(`#ifdef UNITY_COLORSPACE_GAMMA\nfloat f() { return 1.0; }`, /not closed/)
        refuses(`#ifdef UNITY_COLORSPACE_GAMMA\nfloat f(float c) { return c; }\n#else\n#endif`, /defined 1 times/)
    })

    it("refuses what is outside the subset, with the file and line", () => {
        refuses(`float f(out float x) { return 1.0; }`, /t\.hlsl:1: "out" parameters/)
        refuses(`float f(float x) {\n    return x % 2.0;\n}`, /t\.hlsl:2: "%" is outside the subset/)
        refuses(`float f(float x) { return 1.0f; }`, /literal suffix/)
        refuses(`float f(float x) { return fwidth(x); }`, /neither a library function nor an intrinsic/)
        refuses(`float f(float x) { return f(x); }`, /recursion/)
        refuses(`float f(float x) { return g(x); }\nfloat g(float x) { return x; }`, /g is called before it is defined/)
        refuses(`float f(float x) { return x.x; }`, /a swizzle of a float/)
        refuses(`float2 f(float3 v) { return mul(v, float2x2(1.0, 0.0, 0.0, 1.0)); }`, /mul's vector must be a float2/)
        refuses(`float f(float x) { float2x2 m = float2x2(1.0, 0.0, 0.0, 1.0); return x; }`, /./)
        refuses(`float f(float2 x) { float y = x; return y; }`, /a float2 where a float is needed/)
        refuses(`float f(int i) { switch (i) { case 0: i = 1; default: return 1.0; } }`, /must end in return or break/)
        refuses(`float f(float x) { for (int i = 0; i < 4; i++) { i = 2; } return x; }`, /loop counter/)
        refuses(`float f(float x) { return 1.0; }\nfloat f(float y) { return 2.0; }`, /defined 2 times/)
        refuses(`static float k = 1.0;`, /top level declaration must be a function/)
    })
})
