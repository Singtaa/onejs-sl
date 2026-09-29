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
const folded = (source: string, options = {}) => {
    const p = parse(`float4 main() { ${source} }`, options)
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
        const p = parse(modes.replace("float t;", "float t = 0;"))
        expect(kinds(p, "if").length).toBe(3)
        printsEverywhere(p)
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

describe("ints", () => {
    it("divide as whole numbers under truncate, toward zero, and give 0 for a zero divisor", () => {
        const div = (a: number, b: number) => folded(`int n = ${a} / ${b}; return float4(n, 0, 0, 1);`)
        expect([div(7, 2), div(-7, 2), div(7, 0)]).toEqual([3, -3, 0])
    })

    it("divide as floats under float, and refuse the result into an int with the conversion", () => {
        expect(folded("float f = 7 / 2; return float4(f, 0, 0, 1);", { intDivision: "float" })).toBe(3.5)
        expect(() => parse("float4 main() { int a = 7; int n = a / 2; return float4(n, 0, 0, 1); }", { intDivision: "float" }))
            .toThrow(/\/ always divides as floats. To divide as whole numbers, write int\(a \/ b\)/)
        expect(folded("int a = 7; int n = int(a / 2); return float4(n, 0, 0, 1);", { intDivision: "float" })).toBe(3)
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
        expect(p.uniforms[0]).toMatchObject({ name: "count", type: 1 })
        expect(calls(p, SLOP.CAST).length).toBe(2)
    })

    it("choose between ints with ?:", () => {
        const p = parse("float4 main() { int k = uv.x > 0.5 ? 3 : 1; return float4(float(k) / 3, 0, 0, 1); }")
        expect(calls(p, SLOP.CHOOSE).length).toBe(1)
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
