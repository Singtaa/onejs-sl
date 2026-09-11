import { describe, expect, it } from "vitest"
import { encode } from "../encode"
import { SLOP } from "../ops"
import * as sl from "../sl"
import { PRELUDE_SOURCE, analyze, parse } from "./index"

/**
 * What the language does, as opposed to whether it agrees with the EDSL.
 *
 * `parity.test.ts` covers agreement and is the stronger claim, but it can only
 * speak about constructs the EDSL can also spell. Slot order, the join an `if`
 * produces, what a hex default means and how far a constant folds are decisions
 * this file makes on its own, so they are checked on their own.
 */

const ops = (p: ReturnType<typeof parse>): number[] =>
    p.nodes.filter((n) => n.k === "call").map((n) => (n as { op: number }).op)

describe("declarations", () => {
    it("uniforms take slots in declaration order, used or not", () => {
        const p = parse(`
            uniform float a = 1;
            uniform float2 b = float2(2, 3);
            uniform float4 c = float4(4, 5, 6, 7);
            float4 main() { return float4(c.x, 0, 0, 1); }
        `)
        expect(p.uniforms.map((u) => u.name)).toEqual(["a", "b", "c"])
        expect(p.uniforms.map((u) => u.type)).toEqual([1, 2, 4])
        expect(p.uniforms[1]!.value).toEqual([2, 3])
    })

    it("an omitted default is zero, and a float4's alpha is one", () => {
        const p = parse(`
            uniform float k;
            uniform float4 tint;
            float4 main() { return tint * k; }
        `)
        expect(p.uniforms[0]!.value).toEqual([0])
        expect(p.uniforms[1]!.value).toEqual([0, 0, 0, 1])
    })

    it("a hex default is the colour as written, and reading it converts", () => {
        const p = parse(`
            uniform float4 tint = #ff8040;
            float4 main() { return tint; }
        `)
        // sRGB components, the way a host would set them and the way the
        // generated shader's Properties block shows them.
        expect(p.uniforms[0]!.value.map((n) => Math.round(n * 255))).toEqual([255, 128, 64, 255])
        // ...and the program converts on read, so a hex default and a hex
        // literal are the same colour.
        expect(ops(p)).toContain(SLOP.TO_LINEAR)
    })

    it("textures take slots in declaration order", () => {
        const p = parse(`
            texture2D first;
            texture2D second;
            float4 main() { return tex2D(second, uv); }
        `)
        expect(p.textures.map((t) => [t.name, t.slot])).toEqual([["first", 0], ["second", 1]])
    })

    it("a const is an ordinary value, and folds when it is a number", () => {
        const p = parse(`
            const float N = 2;
            const float4 SKY = #0080ff;
            float4 main() {
                float2 q = uv * N;
                return SKY * q.x;
            }
        `)
        const twin = sl.program(({ uv }) => sl.color("#0080ff").mul(uv.mul(2).x) as never)
        expect(p.hash).toBe(twin.hash)
    })
})

describe("expressions", () => {
    it("literal arithmetic folds, so it costs no instructions", () => {
        const p = parse(`float4 main() { return float4(2 * 3 + 1, 0, 0, 1); }`)
        const twin = sl.program(() => sl.vec4(7, 0, 0, 1))
        expect(p.hash).toBe(twin.hash)
    })

    it("a builtin call is never folded, even on constants", () => {
        // Folding it would mean a second implementation of sin in JavaScript,
        // which is one more place for the two backends to disagree.
        const p = parse(`float4 main() { return float4(sin(0.5), 0, 0, 1); }`)
        expect(ops(p)).toContain(SLOP.SIN)
    })

    it("floatN(x) broadcasts a scalar and floatN(v) of the same width is the value", () => {
        const broadcast = parse(`float4 main() { return float4(uv.x); }`)
        expect(broadcast.hash).toBe(sl.program(({ uv }) => sl.vec4(uv.x, uv.x, uv.x, uv.x)).hash)

        const identity = parse(`float4 main() { float4 c = float4(uv, 0, 1); return float4(c); }`)
        expect(identity.hash).toBe(sl.program(({ uv }) => sl.vec4(uv, 0, 1)).hash)
    })

    it("a scalar broadcasts on either side of an operator", () => {
        const p = parse(`float4 main() { return float4(1 - uv, uv * 8); }`)
        const twin = sl.program(({ uv }) => sl.vec4(sl.float(1).sub(uv), uv.mul(8)))
        expect(p.hash).toBe(twin.hash)
    })

    it("comparisons and logic are arithmetic, not branches", () => {
        const p = parse(`
            float4 main() {
                float hit = uv.x > 0.25 && uv.x < 0.75;
                return float4(hit, 0, 0, 1);
            }
        `)
        const emitted = new Set(ops(p))
        expect(emitted.has(SLOP.STEP)).toBe(true)
        expect(emitted.has(SLOP.MIN)).toBe(true)
        expect(emitted.has(SLOP.SELECT)).toBe(false)
    })

    it("swizzles read through both spellings", () => {
        const p = parse(`float4 main() { float4 c = float4(uv, 0, 1); return float4(c.rgb, c.a); }`)
        expect(p.hash).toBe(sl.program(({ uv }) => {
            const c = sl.vec4(uv, 0, 1)
            return sl.vec4(c.rgb, c.a)
        }).hash)
    })
})

describe("control flow", () => {
    it("an if joins every local either side assigned", () => {
        const p = parse(`
            float4 main() {
                float a = 0;
                float b = 1;
                if (uv.x > 0.5) {
                    a = uv.y;
                } else {
                    b = time;
                }
                return float4(a, b, 0, 1);
            }
        `)
        // Two locals changed, so two selects. They have to be given different
        // values to count: two joins that pick between the same pair of
        // constants are one node, because the IR interns as it builds.
        expect(ops(p).filter((o) => o === SLOP.SELECT).length).toBe(2)
        expect(p.hash).toBe(sl.program(({ uv, time }) => {
            const cond = sl.float(1).sub(sl.step(uv.x, 0.5))
            return sl.vec4(sl.select(cond, uv.y, 0), sl.select(cond, 1, time), 0, 1)
        }).hash)
    })

    it("a local the branches leave alone is not selected", () => {
        const p = parse(`
            float4 main() {
                float a = 0;
                float untouched = uv.y;
                if (uv.x > 0.5) { a = 1; }
                return float4(a, untouched, 0, 1);
            }
        `)
        expect(ops(p).filter((o) => o === SLOP.SELECT).length).toBe(1)
    })

    it("a constant condition folds away entirely", () => {
        const p = parse(`
            float4 main() {
                float a = uv.x;
                if (1) { a = uv.y; }
                return float4(a, 0, 0, 1);
            }
        `)
        expect(ops(p)).not.toContain(SLOP.SELECT)
        expect(p.hash).toBe(sl.program(({ uv }) => sl.vec4(uv.y, 0, 0, 1)).hash)
    })

    it("else if chains", () => {
        const p = parse(`
            float4 main() {
                float a = 0;
                if (uv.x < 0.33) { a = 1; }
                else if (uv.x < 0.66) { a = 2; }
                else { a = 3; }
                return float4(a, 0, 0, 1);
            }
        `)
        expect(ops(p).filter((o) => o === SLOP.SELECT).length).toBe(2)
    })

    it("a for loop unrolls, and the span is recorded for the ceiling error", () => {
        const p = parse(`
            float4 main() {
                float v = 0;
                for (int i = 0; i < 4; i++) { v = v + uv.x * i; }
                return float4(v, 0, 0, 1);
            }
        `)
        expect(p.loops.length).toBe(1)
        expect(p.loops[0]!.count).toBe(4)
    })

    it("the counter is a number, so it reaches an immediate", () => {
        const p = parse(`
            float4 main() {
                float v = 0;
                for (int i = 1; i <= 3; i += 1) { v = v + fbm(uv, i); }
                return float4(v, 0, 0, 1);
            }
        `)
        const octaves = p.nodes
            .filter((n) => n.k === "call" && n.op === SLOP.FBM)
            .map((n) => (n as { imm?: number[] }).imm![0])
        expect(octaves).toEqual([1, 2, 3])
    })

    it("nested loops multiply", () => {
        const p = parse(`
            float4 main() {
                float v = 0;
                for (int i = 0; i < 2; i++) {
                    for (int j = 0; j < 3; j++) {
                        v = v + uv.x * i * j;
                    }
                }
                return float4(v, 0, 0, 1);
            }
        `)
        expect(p.loops.length).toBe(3)
    })
})

describe("functions", () => {
    it("a file function shadows a prelude function of the same name", () => {
        const p = parse(`
            float circle(float2 p, float r) { return r; }
            float4 main() { return float4(circle(uv, 0.25), 0, 0, 1); }
        `)
        expect(p.hash).toBe(sl.program(() => sl.vec4(0.25, 0, 0, 1)).hash)
    })

    it("a function cannot see the caller's locals", () => {
        expect(() => parse(`
            float f() { return hidden; }
            float4 main() {
                float hidden = 1;
                return float4(f(), 0, 0, 1);
            }
        `)).toThrow(/"hidden" is not declared/)
    })

    it("a function can read uniforms and inputs", () => {
        const p = parse(`
            uniform float k = 2;
            float scaled() { return uv.x * k; }
            float4 main() { return float4(scaled(), 0, 0, 1); }
        `)
        expect(p.hash).toBe(sl.program(({ uv }) =>
            sl.vec4(uv.x.mul(sl.uniform.float("k", 2)), 0, 0, 1)).hash)
    })

    it("every prelude function lowers", () => {
        const p = parse(`
            float4 main() {
                float2 r = rotate(uv - 0.5, time);
                float2 q = polar(r);
                float2 t = tile(uv, 4);
                float d = min(circle(r, 0.3), box(t, float2(0.2, 0.2)));
                float3 c = palette(q.y + d, float3(0.5, 0.5, 0.5), float3(0.5, 0.5, 0.5),
                                   float3(1, 1, 1), float3(0, 0.33, 0.67));
                return float4(c, 1);
            }
        `)
        expect(encode(p).instructions).toBeGreaterThan(0)
    })
})

describe("the prelude itself", () => {
    it("parses as a unit of functions with no main", () => {
        const checked = analyze(PRELUDE_SOURCE, { file: "prelude.sl", requireMain: false })
        expect(checked.unit.main).toBe(null)
        expect(checked.unit.funcs.map((f) => f.name).sort())
            .toEqual(["box", "circle", "palette", "polar", "rotate", "tile"])
    })
})
