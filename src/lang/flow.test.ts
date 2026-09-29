import { describe, expect, it } from "vitest"
import { emitBody, type BodyTarget } from "../body"
import { emitShader } from "../emit/unity"
import { emitGLSL, emitWGSL } from "../emit/web"
import type { Program, SLNode } from "../ir"
import { SLOP } from "../ops"
import { structure } from "../structure"
import { parse } from "./index"

/**
 * Real control flow and the int, uint and bool kinds (`Specs/SL_NEXT.md` 3):
 * what each construct lowers to, and that every emitter prints it.
 */

const kinds = (p: Program, k: SLNode["k"]) => p.nodes.filter((n) => n.k === k)
const loops = (p: Program) => kinds(p, "loop") as Array<Extract<SLNode, { k: "loop" }>>
const calls = (p: Program, op: number) => p.nodes.filter((n) => n.k === "call" && n.op === op)

/** Every emitter prints it: the Unity shader, both web languages and Magerie's body. */
const printsEverywhere = (p: Program) => {
    expect(() => emitShader(p)).not.toThrow()
    expect(() => emitGLSL(p)).not.toThrow()
    expect(() => emitWGSL(p)).not.toThrow()
    const target: BodyTarget = {
        inputs: { uv: "uv", fragCoord: "fc", resolution: "res", time: "t", aspect: "asp" },
        uniform: (slot) => `u${slot}`, sample: (slot, uv) => `s${slot}(${uv})`,
        sampleLevel: (slot, uv, lod) => `l${slot}(${uv}, ${lod})`, colour: "linear",
    }
    expect(() => emitBody(p, target)).not.toThrow()
}

/** Where a node of this op is placed: in the root region, or inside a branch or a loop. */
const placedInRoot = (p: Program, op: number) => {
    const s = structure(p)
    const ref = p.nodes.findIndex((n) => n.k === "call" && n.op === op)
    return s.placed.get(ref) === 0
}

/** A program's one result as a number, when it folds that far. */
const folded = (source: string) => {
    const p = parse(`float4 main() { ${source} }`)
    const out = p.nodes[p.result]!
    if (out.k !== "const") throw new Error(`did not fold: ${out.k}`)
    return out.v[0]
}

describe("early return", () => {
    const lens = `
        float4 main() {
            float d = length(uv - 0.5);
            if (d > 0.45) return float4(0, 0, 0, 0);
            float v = fbm(uv * 4 + time, 4);
            return float4(v, v, v, 1);
        }`

    it("puts the rest of the function on the side that does not return, so it runs only there", () => {
        const p = parse(lens)
        expect(kinds(p, "if").length).toBe(1)
        expect(placedInRoot(p, SLOP.FBM)).toBe(false)
        printsEverywhere(p)
    })

    it("carries a return that only some ways reach as a flag, and runs the rest under it", () => {
        const p = parse(`
            float4 main() {
                float v = uv.x;
                if (uv.y > 0.5) {
                    if (uv.x > 0.5) return float4(1, 0, 0, 1);
                    v = v * 2;
                }
                return float4(v, v, v, 1);
            }`)
        expect(kinds(p, "if").length).toBeGreaterThanOrEqual(2)
        printsEverywhere(p)
    })

    it("returns from inside an inlined function without leaving the caller", () => {
        const p = parse(`
            float shade(float d) {
                if (d < 0) return 1;
                return exp(-d * 8);
            }
            float4 main() { float s = shade(length(uv - 0.5) - 0.2); return float4(s, s, s, 1); }`)
        expect(kinds(p, "if").length).toBe(1)
        printsEverywhere(p)
    })
})

describe("loops", () => {
    it("unrolls a constant loop of 64 turns or fewer, as it always has", () => {
        const p = parse("float4 main() { float v = 0; for (int i = 0; i < 8; i++) { v += uv.x; } return float4(v, 0, 0, 1); }")
        expect(loops(p).length).toBe(0)
    })

    it("makes a constant loop of more turns a real one, capped at its count", () => {
        const p = parse("float4 main() { float v = 0; for (int i = 0; i < 500; i++) { v += uv.x * 0.001; } return float4(v, 0, 0, 1); }")
        expect(loops(p).map((l) => l.max)).toEqual([500])
        printsEverywhere(p)
    })

    it("caps a loop bounded by a uniform at its Range's max", () => {
        const p = parse(`
            [Range(16, 256)] uniform float iterations = 64;
            float4 main() {
                float2 z = 0; float n = 0;
                for (int i = 0; i < int(iterations); i++) {
                    if (dot(z, z) > 4) break;
                    z = float2(z.x * z.x - z.y * z.y, 2 * z.x * z.y) + (uv - 0.5) * 3;
                    n += 1;
                }
                return float4(n / iterations, 0, 0, 1);
            }`)
        expect(loops(p).map((l) => l.max)).toEqual([256])
        printsEverywhere(p)
    })

    it("caps a loop whose bound says nothing at 1024", () => {
        const p = parse("float4 main() { float v = 0; while (v < uv.x * 10) { v += 0.5; } return float4(v, 0, 0, 1); }")
        expect(loops(p).map((l) => l.max)).toEqual([1024])
        printsEverywhere(p)
    })

    it("keeps a loop with a break real however few its turns, and carries the break as a bool", () => {
        const p = parse(`
            float4 main() {
                float t = 0;
                for (int i = 0; i < 48; i++) {
                    float d = length(uv - 0.5 + t * 0.01) - 0.3;
                    if (d < 0.001) break;
                    t += d;
                }
                return float4(t, 0, 0, 1);
            }`)
        const [l] = loops(p)
        expect(l!.max).toBe(48)
        // The counter, t, and the break flag.
        expect(l!.init.length).toBe(3)
        printsEverywhere(p)
    })

    it("runs a for loop's update on a turn that continues", () => {
        const p = parse(`
            float4 main() {
                float v = 0;
                for (int i = 0; i < int(uv.x * 100); i++) {
                    if (i % 3 == 0) continue;
                    v += 0.01;
                }
                return float4(v, 0, 0, 1);
            }`)
        expect(loops(p).length).toBe(1)
        printsEverywhere(p)
    })

    it("returns from inside a loop", () => {
        const p = parse(`
            float4 main() {
                for (int i = 0; i < 100; i++) {
                    if (float(i) > uv.x * 100) return float4(float(i) / 100, 0, 0, 1);
                }
                return float4(0, 0, 1, 1);
            }`)
        const [l] = loops(p)
        // The counter, the returned flag and the value returned.
        expect(l!.init.length).toBe(3)
        printsEverywhere(p)
    })

    it("breaks out of the inner of two loops only", () => {
        const p = parse(`
            float4 main() {
                float v = 0;
                for (int i = 0; i < 70; i++) {
                    for (int j = 0; j < 70; j++) {
                        if (j > i) break;
                        v += 0.0001;
                    }
                }
                return float4(v, 0, 0, 1);
            }`)
        expect(loops(p).length).toBe(2)
        printsEverywhere(p)
    })
})

describe("switch", () => {
    const modes = `
        [Range(0, 3)] uniform int mode = 0;
        float4 main() {
            float t;
            switch (mode) {
                case 0: t = uv.x; break;
                case 1: t = uv.y; break;
                case 2: case 3: t = length(uv - 0.5); break;
                default: t = 0; break;
            }
            return float4(t, t, t, 1);
        }`

    it("is an if chain, one arm per case, stacked labels sharing one", () => {
        const p = parse(modes)
        expect(kinds(p, "if").length).toBe(3)
        printsEverywhere(p)
    })

    it("takes a case's body in braces, the closing break inside them or after", () => {
        const braced = modes
            .replace("case 0: t = uv.x; break;", "case 0: { float a = uv.x; t = a; break; }")
            .replace("case 1: t = uv.y; break;", "case 1: { float a = uv.y; t = a; } break;")
        const p = parse(braced)
        expect(kinds(p, "if").length).toBe(3)
        expect(p.hash).toBe(parse(modes).hash)
        printsEverywhere(p)
        expect(folded("int m = 1; float v = 0; switch (m) { case 0: { v = 0.25; break; } case 1: { float q = 0.5; v = q; break; } default: { v = 1; break; } } return float4(v, 0, 0, 1);")).toBe(0.5)
    })

    it("still refuses a break that would leave a braced case early", () => {
        expect(() => parse("float4 main() { float v = 0; switch (int(uv.x * 2)) { case 0: { if (uv.y > 0.5) break; v = 1; break; } default: break; } return float4(v, 0, 0, 1); }"))
            .toThrow(/this break would leave the switch before the end of its case/)
    })

    it("folds on a constant", () => {
        expect(folded("int m = 2; float v = 0; switch (m) { case 1: v = 0.25; break; case 2: v = 0.5; break; } return float4(v, 0, 0, 1);")).toBe(0.5)
    })

    it("returns from a case", () => {
        const p = parse(`
            float4 main() {
                switch (int(uv.x * 3)) {
                    case 0: return #ff0000;
                    case 1: return #00ff00;
                    default: return #0000ff;
                }
            }`)
        printsEverywhere(p)
    })
})

describe("blocks", () => {
    it("give their locals a scope of their own", () => {
        expect(folded("float r = 0; { float q = 0.25; r += q; } { float q = 0.5; r += q; } return float4(r, 0, 0, 1);")).toBe(0.75)
        expect(() => parse("float4 main() { { float q = 0.3; } return float4(q, 0, 0, 1); }")).toThrow(/"q" is not declared/)
    })

    it("change nothing about a real loop they sit in: what it carries, its break, its return", () => {
        const loop = (body: string) => parse(`
            [Range(0, 200)] uniform int n = 100;
            float4 main() {
                float r = 0;
                for (int i = 0; i < n; i++) { ${body} }
                return float4(r, 0, 0, 1);
            }`).hash
        for (const body of ["r += 0.01;", "if (r > uv.x) break; r += 0.01;", "if (r > uv.x) return #ff0000; r += 0.01;"]) {
            expect(loop(`{ ${body} }`)).toBe(loop(body))
        }
    })

    it("return from inside, and nothing after braces that always return runs", () => {
        printsEverywhere(parse("float4 main() { if (uv.x > 0.5) { { return #ff0000; } } return #0000ff; }"))
        expect(() => parse("float4 main() { { return #ff0000; } float x = 1; return float4(x, 0, 0, 1); }"))
            .toThrow(/this can never run: every way through the braces above ends/)
    })
})

describe("a local declared without a value", () => {
    it("holds zero, or false, until it is assigned", () => {
        expect(folded("float t; return float4(t, 0, 0, 1);")).toBe(0)
        expect(folded("int n; n += 3; return float4(n, 0, 0, 1);")).toBe(3)
        expect(folded("uint u; return float4(u, 0, 0, 1);")).toBe(0)
        expect(folded("uint u; u += 3u; return float4(u, 0, 0, 1);")).toBe(3)
        expect(folded("bool b; return float4(b ? 1 : 0.5, 0, 0, 1);")).toBe(0.5)
        const vec = (decl: string) => parse(`float4 main() { ${decl} c.y = uv.x; return float4(c, 1); }`).hash
        expect(vec("float3 c;")).toBe(vec("float3 c = 0;"))
    })

    it("takes its value from whichever side of a branch assigns it", () => {
        const p = parse("float4 main() { float t; if (uv.x > 0.5) t = 0.7; else t = 0.2; return float4(t, 0, 0, 1); }")
        expect(p.hash).toBe(parse("float4 main() { float t = 0; if (uv.x > 0.5) t = 0.7; else t = 0.2; return float4(t, 0, 0, 1); }").hash)
        printsEverywhere(p)
    })
})

describe("ints", () => {
    it("divide as whole numbers, toward zero as HLSL does, and give 0 for a zero divisor", () => {
        const div = (a: number, b: number) => folded(`int n = ${a} / ${b}; return float4(n, 0, 0, 1);`)
        expect([div(7, 2), div(-7, 2), div(7, 0)]).toEqual([3, -3, 0])
    })

    it("keep a whole number a float until it meets an int", () => {
        // 1 / 2 is 0.5 wherever no int is involved, as it always was.
        expect(folded("float f = 1 / 2; return float4(f, 0, 0, 1);")).toBe(0.5)
        expect(folded("int i = 3; float f = i / 2.0; return float4(f, 0, 0, 1);")).toBe(1.5)
    })

    it("take % truncated, so a negative stays negative, as fmod does", () => {
        expect(folded("int n = -7 % 3; return float4(n, 0, 0, 1);")).toBe(-1)
    })

    it("truncate a float toward zero, held to the int's range", () => {
        expect(folded("int n = int(-2.7); return float4(n, 0, 0, 1);")).toBe(-2)
        expect(folded("int n = int(1e12); return float4(n, 0, 0, 1);")).toBe(2147483520)
    })

    it("wrap at 32 bits and shift by their count modulo 32", () => {
        expect(folded("int n = 2147483647 + 1; return float4(n, 0, 0, 1);")).toBe(-2147483648)
        expect(folded("int n = 1 << 33; return float4(n, 0, 0, 1);")).toBe(2)
        expect(folded("int n = (0xff & 0x0f) | 0x30 ^ 1; return float4(n, 0, 0, 1);")).toBe(0x3f)
    })

    it("hash as uints", () => {
        const p = parse(`
            float4 main() {
                uint h = uint(fragCoord.x) * 1664525u + 1013904223u;
                h ^= h >> 16;
                h *= 0x7feb352du;
                return float4(float(h & 255u) / 255, 0, 0, 1);
            }`)
        expect(calls(p, SLOP.SHR).length).toBe(1)
        printsEverywhere(p)
    })

    it("read an int uniform as the whole number it holds", () => {
        const p = parse("[Range(1, 8)] uniform int count = 3;\nfloat4 main() { return float4(float(count) / 8, 0, 0, 1); }")
        expect(p.uniforms[0]).toEqual({ name: "count", type: 1, kind: "int", value: [3], range: { min: 1, max: 8 } })
        expect(calls(p, SLOP.CAST).length).toBe(2)
    })

    it("choose between ints with ?:", () => {
        const p = parse("float4 main() { int k = uv.x > 0.5 ? 3 : 1; return float4(float(k) / 3, 0, 0, 1); }")
        expect(calls(p, SLOP.CHOOSE).length).toBe(1)
        printsEverywhere(p)
    })
})

describe("uint constants", () => {
    /** The folded number, having checked the program holds no uint, int or bool node at all. */
    const plain = (source: string) => {
        const v = folded(source)
        const p = parse(`float4 main() { ${source} }`)
        expect(p.nodes.filter((n) => "kind" in n && n.kind !== undefined)).toEqual([])
        return v
    }

    it("fold into a float with no conversion left", () => {
        expect(plain("return float4(float(5u), 0, 0, 1);")).toBe(5)
        expect(plain("return float4(float(3u + 4u), 0, 0, 1);")).toBe(7)
        expect(plain("uint u = 9u; return float4(u, 0, 0, 1);")).toBe(9)
        const p = parse("float4 main() { return float4(float(3u + 4u), 0, 0, 1); }")
        expect([calls(p, SLOP.CAST).length, calls(p, SLOP.ADD).length]).toEqual([0, 0])
        expect(p.hash).toBe(parse("float4 main() { return float4(7, 0, 0, 1); }").hash)
    })

    it("wrap at 32 bits", () => {
        expect(plain("return float4(float(0u - 1u), 0, 0, 1);")).toBe(4294967295)
        expect(plain("return float4(float(4294967295u + 1u), 0, 0, 1);")).toBe(0)
        expect(plain("return float4(float(65536u * 65537u), 0, 0, 1);")).toBe(65536)
    })

    it("divide as whole numbers, and give 0 for a zero divisor as a computed one does", () => {
        expect(plain("return float4(float(7u / 2u), float(7u % 3u), float(7u / 0u), float(7u % 0u));")).toBe(3)
        const p = parse("float4 main() { return float4(float(7u / 2u), float(7u % 3u), float(7u / 0u), float(7u % 0u)); }")
        const out = p.nodes[p.result]!
        expect(out.k === "const" && out.v).toEqual([3, 1, 0, 0])
    })

    it("fold bit operators, a right shift filling with zeros and a count taken modulo 32", () => {
        expect(plain("return float4(float(0xf0u | 0x0fu), 0, 0, 1);")).toBe(255)
        expect(plain("return float4(float(0xffu & 0x3cu ^ 1u), 0, 0, 1);")).toBe(0x3d)
        expect(plain("return float4(float(~0u), 0, 0, 1);")).toBe(4294967295)
        expect(plain("return float4(float(1u << 33u), 0, 0, 1);")).toBe(2)
        expect(plain("return float4(float(0x80000000u >> 31), 0, 0, 1);")).toBe(1)
        expect(plain("uint h = 0x9e3779b9u; h ^= h >> 16; h *= 0x7feb352du; return float4(float(h & 255u), 0, 0, 1);"))
            .toBe(Number((0x9e3779b9n ^ (0x9e3779b9n >> 16n)) * 0x7feb352dn & 255n))
    })

    it("convert to and from an int keeping the bits, and from a float truncating, held to the range", () => {
        expect(plain("return float4(float(int(4294967295u)), 0, 0, 1);")).toBe(-1)
        expect(plain("int k = -1; return float4(float(uint(k)), 0, 0, 1);")).toBe(4294967295)
        expect(plain("return float4(float(uint(2.7)), 0, 0, 1);")).toBe(2)
        expect(plain("return float4(float(uint(-3.5)), 0, 0, 1);")).toBe(0)
        expect(plain("return float4(float(uint(int(7))), 0, 0, 1);")).toBe(7)
        expect(plain("return float4(bool(0u) ? 1 : 0.5, 0, 0, 1);")).toBe(0.5)
    })

    it("compare, and decide a choice and a branch", () => {
        expect(plain("return float4(3u < 4u ? 1 : 0.5, 0, 0, 1);")).toBe(1)
        expect(plain("float v = 0.25; if (5u == 5u) v = 0.75; return float4(v, 0, 0, 1);")).toBe(0.75)
        expect(plain("return float4(5u ? 1 : 0.5, 0, 0, 1);")).toBe(1)
        expect(plain("return float4(!0u ? 1 : 0.5, 0, 0, 1);")).toBe(1)
    })

    it("negate as a float, as a uint node is negated", () => {
        expect(plain("return float4(-5u + 10, 0, 0, 1);")).toBe(5)
    })

    it("join as one value when both sides hold the same uint", () => {
        expect(folded("uint h = 1u; if (uv.x > 0.5) { h = 1u; } return float4(float(h), 0, 0, 1);")).toBe(1)
    })

    it("count a loop whose turns are known, which then unrolls", () => {
        expect(plain("uint s = 0u; for (uint i = 0u; i < 4u; i++) s += i; return float4(float(s), 0, 0, 1);")).toBe(6)
    })

    it("become nodes to cross a join, a real loop or a switch", () => {
        const join = parse("float4 main() { uint h = 1u; if (uv.x > 0.5) { h = 2u; } else { h = h + 5u; } return float4(float(h) / 8, 0, 0, 1); }")
        expect(kinds(join, "if").length).toBe(1)
        const loop = parse("uniform int n = 4;\nfloat4 main() { uint h = 1u; for (int i = 0; i < n; i++) { h = h * 3u + 1u; } return float4(float(h & 255u) / 255, 0, 0, 1); }")
        expect(loops(loop).length).toBe(1)
        const sw = parse("uniform float s = 1;\nfloat4 main() { uint k = uint(s); switch (k) { case 1u: return #ff0000; case 2: return #00ff00; default: return #000000; } }")
        for (const p of [join, loop, sw]) printsEverywhere(p)
        expect(folded("uint k = 2u + 1u; switch (k) { case 3: return float4(1, 0, 0, 1); default: return float4(0, 0, 0, 1); }")).toBe(1)
    })

    it("stay uints when a swizzle reads one", () => {
        const p = parse("float4 main() { uint h = 5u; uint g = h.x; return float4(float(g ^ 1u) / 8, 0, 0, 1); }")
        expect(p.nodes.filter((n) => n.k === "swizzle" && n.kind === "uint").length).toBe(1)
        printsEverywhere(p)
    })

    it("still refuse an int", () => {
        expect(() => parse("float4 main() { int k = 1; return float4(float(k + 1u), 0, 0, 1); }")).toThrow(/an int with a uint/)
    })

    it("become a node where they meet one", () => {
        const p = parse("uniform float s = 1; float4 main() { uint h = uint(s) * 3u + 1u; return float4(float(h), 0, 0, 1); }")
        expect(calls(p, SLOP.MUL).length).toBe(1)
        expect(p.nodes.filter((n) => n.k === "const" && n.kind === "uint").map((n) => (n as { v: number[] }).v)).toEqual([[3], [1]])
        printsEverywhere(p)
    })
})

describe("bools", () => {
    it("hold a comparison and decide a branch", () => {
        const p = parse(`
            float4 main() {
                bool inside = length(uv - 0.5) < 0.3;
                float v = 0.2;
                if (inside && !(uv.x > 0.6)) { v = 1; }
                return float4(v, v, v, 1);
            }`)
        expect(kinds(p, "if").length).toBe(1)
        printsEverywhere(p)
    })

    it("are 0 or 1 where a float is wanted", () => {
        expect(folded("float f = true; return float4(f, 0, 0, 1);")).toBe(1)
    })
})

describe("a texture read in a branch", () => {
    it("samples level 0 where pixels part ways, and implicitly where they do not", () => {
        const p = parse(`
            texture2D t;
            uniform float on = 1;
            float4 main() {
                float4 c = float4(0, 0, 0, 1);
                if (uv.x > 0.5) { c = tex2D(t, uv); }
                if (on > 0.5) { c = c + tex2D(t, uv * 2); }
                return c;
            }`)
        const wgsl = emitWGSL(p)
        expect(wgsl).toContain("textureSampleLevel(sl_tex0, sl_samp0, n")
        expect(wgsl).toMatch(/textureSample\(sl_tex0, sl_samp0, n/)
        printsEverywhere(p)
    })
})
