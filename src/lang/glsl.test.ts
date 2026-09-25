import { describe, expect, it } from "vitest"
import { fromGLSL } from "./glsl"
import { parse } from "./index"

/**
 * A pasted GLSL shader as a `.sl` file (`Specs/SL_NEXT.md` 5, Decision 1 A).
 * Each case is written the way the shader it stands for is written, and is
 * held to compiling, or to saying exactly what it could not carry over.
 */

const convert = (glsl: string) => fromGLSL(glsl)
const compiles = (glsl: string) => {
    const r = convert(glsl)
    expect(r.errors.map((e) => `${e.line}:${e.column} ${e.text}`), r.source).toEqual([])
    expect(() => parse(r.source)).not.toThrow()
    return r
}
/** A mainImage around one statement, for the rewrites that live in an expression. */
const image = (body: string, top = "") =>
    `${top}\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    ${body}\n}`

describe("a Shadertoy shader", () => {
    const PLASMA = [
        "// Plasma",
        "#define PI 3.14159265",
        "#define TAU (2.0 * PI)",
        "",
        "float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }",
        "",
        "float noise(in vec2 p) {",
        "    vec2 i = floor(p);",
        "    vec2 f = fract(p);",
        "    vec2 u = f * f * (3.0 - 2.0 * f);",
        "    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);",
        "}",
        "",
        "void mainImage(out vec4 fragColor, in vec2 fragCoord)",
        "{",
        "    vec2 uv = fragCoord / iResolution.xy;",
        "    float t = iTime * 0.5;",
        "    vec3 col = 0.5 + 0.5 * cos(t + uv.xyx + vec3(0, 2, 4)) * noise(uv * 8.0);",
        "    fragColor = vec4(col, 1.0);",
        "}",
    ].join("\n")

    it("compiles, keeping its comments, its layout and its names", () => {
        const r = compiles(PLASMA)
        expect(r.source).toContain("// Plasma")
        expect(r.source).toContain("const float PI = 3.14159265;")
        expect(r.source).toContain("const float TAU = (2.0 * PI);")
        expect(r.source).toContain("float hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }")
        expect(r.source).toContain("float4 main()\n{\n    float4 fragColor = float4(0.0);")
        expect(r.source).toContain("    float t = time * 0.5;")
        expect(r.source).toMatch(/fragColor = float4\(col, 1\.0\);\n {4}return fragColor;\n}$/)
    })

    it("uses the input uv for Shadertoy's own uv line", () => {
        const r = convert(PLASMA)
        expect(r.source).not.toContain("fragCoord / resolution")
        expect(r.source).toContain("cos(t + uv.xyx")
        expect(r.notes).toContain("line 16: the uv line is dropped: fragCoord / resolution is the input uv, y up")
    })

    it("renames a function that takes a builtin's name, and says so", () => {
        const r = convert(PLASMA)
        expect(r.source).toContain("float noise_(float2 p)")
        expect(r.source).toContain("noise_(uv * 8.0)")
        expect(r.notes).toContain("line 7: noise is renamed noise_, since noise already means something here")
    })

    it("never throws, at any point while a shader is pasted", () => {
        for (let i = 0; i <= PLASMA.length; i++) expect(() => convert(PLASMA.slice(0, i))).not.toThrow()
    })

    it("names the colour and the position after mainImage's own parameters", () => {
        const r = compiles("void mainImage(out vec4 O, in vec2 U) { vec2 p = U / iResolution.y; O = vec4(p, 0, 1); }")
        expect(r.source).toBe("float4 main() {\n    float4 O = float4(0.0); float2 p = fragCoord / resolution.y; O = float4(p, 0, 1);\n    return O;\n}")
    })
})

describe("the other entry points", () => {
    it("takes a WebGL1 main that writes gl_FragColor", () => {
        const r = compiles("precision mediump float;\nvoid main() { gl_FragColor = vec4(gl_FragCoord.xy / iResolution.xy, 0.0, 1.0); }")
        expect(r.source).toContain("fragColor = float4(fragCoord.xy / resolution.xy, 0.0, 1.0);")
        expect(r.source).not.toContain("precision")
    })

    it("takes a WebGL2 main with an out colour", () => {
        const r = compiles("out vec4 outColor;\nvoid main() { outColor = vec4(1.0); }")
        expect(r.source).toContain("float4 outColor = float4(0.0);")
        expect(r.source).not.toContain("out vec4")
    })

    it("says so when there is no entry point", () => {
        expect(convert("float f(float x) { return x; }").notes)
            .toContain("there is no mainImage or main to convert; add `float4 main() { ... }` returning the colour")
    })
})

describe("rewrites that keep the meaning", () => {
    it.each([
        ["mod(uv.x, 0.25)", "(uv.x - 0.25 * floor(uv.x / 0.25))"],
        ["mod(uv.x + 1.0, 0.25)", "((uv.x + 1.0) - 0.25 * floor((uv.x + 1.0) / 0.25))"],
        ["atan(uv.y, uv.x)", "atan2(uv.y, uv.x)"],
        ["atan(uv.x)", "atan2(uv.x, 1.0)"],
        ["inversesqrt(uv.x)", "(1.0 / sqrt(uv.x))"],
        ["radians(uv.x)", "(uv.x * 0.017453292519943295)"],
        ["degrees(uv.x)", "(uv.x * 57.29577951308232)"],
        ["exp2(uv.x)", "pow(2.0, uv.x)"],
        ["log2(uv.x)", "(log(uv.x) * 1.4426950408889634)"],
        ["mix(0.0, 1.0, fract(uv.x))", "lerp(0.0, 1.0, frac(uv.x))"],
    ])("%s is %s", (glsl, sl) => {
        const r = compiles(image(`fragColor = vec4(${glsl}, 0.0, 0.0, 1.0);`))
        expect(r.source).toContain(`float4(${sl}, 0.0, 0.0, 1.0)`)
    })

    it("keeps GLSL's floored mod, not the truncating %", () => {
        // The one rewrite whose whole point is a sign: mod(-0.25, 1.0) is 0.75 in GLSL and -0.25 as %.
        const r = compiles(image("fragColor = vec4(mod(-0.25, 1.0));"))
        expect(r.source).toContain("((-0.25) - 1.0 * floor((-0.25) / 1.0))")
        expect(-0.25 - 1.0 * Math.floor(-0.25 / 1.0)).toBe(0.75)
    })

    it("reads a texture channel from a declared texture", () => {
        const r = compiles(image("fragColor = texture(iChannel0, fragCoord / iResolution.xy);", "uniform sampler2D noiseTex;"))
        expect(r.source.startsWith("texture2D iChannel0;\n")).toBe(true)
        expect(r.source).toContain("texture2D noiseTex;")
        expect(r.source).toContain("tex2D(iChannel0, fragCoord / resolution.xy)")
    })

    it("keeps an int for-loop counter and says what an int elsewhere became", () => {
        const r = compiles(image("float s = 0.0; int n = 3; for (int i = 0; i < 3; i++) { s += 0.25; } fragColor = vec4(s);"))
        expect(r.source).toContain("for (int i = 0;")
        expect(r.source).toContain("float n = 3;")
        expect(r.notes.some((n) => n.includes("an int is a float here"))).toBe(true)
    })

    it("renames a value that takes an input's name", () => {
        const r = compiles(image("float time = iTime * 2.0; fragColor = vec4(time);"))
        expect(r.source).toContain("float time_ = time * 2.0; fragColor = float4(time_);")
        expect(r.notes.some((n) => n.includes("time is renamed time_"))).toBe(true)
    })

    it("makes iResolution a float3 where it is used whole", () => {
        expect(compiles(image("fragColor = vec4(iResolution / 1000.0, 1.0);")).source)
            .toContain("float4(float3(resolution, 1.0) / 1000.0, 1.0)")
    })

    it("gives iMouse a uniform the host sets", () => {
        const r = compiles(image("fragColor = vec4(iMouse.xy / iResolution.xy, 0, 1);"))
        expect(r.source.startsWith("uniform float4 mouse;\n")).toBe(true)
        expect(r.notes.some((n) => n.includes("iMouse is the uniform mouse"))).toBe(true)
    })

    it("turns an early return into returning the colour", () => {
        const r = convert(image("if (fragCoord.x > 10.0) { fragColor = vec4(1); return; } fragColor = vec4(0);"))
        expect(r.source).toContain("return fragColor; }")
        // A return inside an if is refused until real control flow lands (Specs/SL_NEXT.md 3a).
        expect(r.errors.map((e) => e.text)[0]).toMatch(/^a return inside an if/)
    })
})

describe("what cannot be carried over", () => {
    it.each([
        ["iFrame", "fragColor = vec4(float(iFrame));", "iFrame has no counterpart: there is no frame counter yet"],
        ["textureLod", "fragColor = textureLod(iChannel0, fragCoord, 0.0);", "textureLod has no counterpart"],
        ["dFdx", "fragColor = vec4(dFdx(fragCoord.x));", "dFdx has no counterpart: there are no derivatives"],
    ])("says %s has no counterpart, and leaves it for the errors", (_, body, text) => {
        const r = convert(image(body))
        expect(r.notes.some((n) => n.includes(text)), r.notes.join("\n")).toBe(true)
        expect(r.errors.length).toBeGreaterThan(0)
    })

    it("keeps a macro with parameters as a comment, and says so", () => {
        const r = convert(image("fragColor = vec4(1);", "#define SQ(x) ((x) * (x))"))
        expect(r.source).toContain("// #define SQ(x) ((x) * (x))")
        expect(r.notes.some((n) => n.includes("there is no preprocessor"))).toBe(true)
    })

    it("drops a GL_ES guard without a note, since it only ever held a precision line", () => {
        const r = compiles(image("fragColor = vec4(1);", "#ifdef GL_ES\nprecision highp float;\n#endif"))
        expect(r.notes).toEqual([])
    })

    it("says a helper returning nothing has no counterpart", () => {
        const r = convert(image("fragColor = vec4(1);", "void paint(inout vec4 c) { c = vec4(1); }"))
        expect(r.notes.some((n) => n.includes("paint returns nothing"))).toBe(true)
        expect(r.notes.some((n) => n.includes("inout parameters do not exist here"))).toBe(true)
    })
})
