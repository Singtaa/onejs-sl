import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { MAX_TEXTURES, SLError, TYPE, hashProgram } from "./ir"
import { SLOP } from "./ops"
import { SDF_SHAPES } from "../fx/sdf"

/**
 * Phase 1 is pure TypeScript on purpose, so everything the IR promises can be
 * checked with no GPU and no build. These tests are the promises.
 */

const trivial = () => sl.program(({ uv }) => sl.vec4(uv, 0, 1))

describe("the graph is a DAG, not a tree", () => {
    it("records a value used twice as ONE node", () => {
        // This is the whole reason CSE happens at record time: the author
        // already said what is shared by writing `const`.
        const shared = sl.program(({ uv }) => {
            const p = uv.mul(8)
            return sl.vec4(p.x, p.y, p.x, 1)
        })
        const spread = sl.program(({ uv }) => {
            return sl.vec4(uv.mul(8).x, uv.mul(8).y, uv.mul(8).x, 1)
        })
        // Writing it out long hand must cost the same, or the natural way to
        // write a shader would silently be the expensive way.
        expect(spread.nodes.length).toBe(shared.nodes.length)
        expect(spread.hash).toBe(shared.hash)
    })

    it("does not intern nodes that merely look similar", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv.mul(8).x, uv.mul(9).y, 0, 1))
        const muls = p.nodes.filter((n) => n.k === "call" && n.op === SLOP.MUL)
        expect(muls.length).toBe(2)
    })
})

describe("nodes are topologically ordered", () => {
    it("never refers forwards", () => {
        const p = sl.program(({ uv, time }) => {
            const a = uv.mul(8).add(time)
            const b = sl.sin(a.x).add(sl.cos(a.y))
            return sl.vec4(b, b, b, 1)
        })
        p.nodes.forEach((n, i) => {
            if (n.k === "swizzle") expect(n.src).toBeLessThan(i)
            if (n.k === "call") for (const a of n.args) expect(a).toBeLessThan(i)
        })
        expect(p.result).toBeLessThan(p.nodes.length)
    })

    it("every node carries its own type", () => {
        const p = trivial()
        for (const n of p.nodes) expect([1, 2, 3, 4]).toContain(n.type)
    })
})

describe("types are checked at the call site", () => {
    it("broadcasts a float against a vector, as HLSL does", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv.mul(2), 0, 1))
        expect(p.nodes.some((n) => n.k === "call" && n.op === SLOP.MUL && n.type === TYPE.VEC2)).toBe(true)
    })

    it("refuses to combine a vec2 with a vec3", () => {
        expect(() => sl.program(({ uv }) => {
            const three = sl.vec3(1, 2, 3)
            return sl.vec4((uv as any).add(three), 0, 1)
        })).toThrow(/cannot combine a vec2 with a vec3/)
    })

    it("refuses a swizzle component the value does not have", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(uv.swz("z"), 0, 0, 1)))
            .toThrow(/component 3 of a vec2/)
    })

    it("refuses a component that is not a component", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(uv.swz("q" as any), 0, 0, 1)))
            .toThrow(/not a component/)
    })

    it("widens a swizzle by its length", () => {
        const p = sl.program(() => {
            const c = sl.vec4(1, 2, 3, 4)
            return c.swz("wzyx")
        })
        expect(p.nodes[p.result].type).toBe(TYPE.VEC4)
    })

    it("insists a program returns a vec4", () => {
        expect(() => sl.program(({ uv }) => uv as any)).toThrow(/must return a vec4/)
    })

    it("narrows luminance to a float whatever it is given", () => {
        // Width preserving by default is right for sin and wrong for this, and
        // when it was wrong the error surfaced two calls away as "vec4 needs 4
        // components, got 7".
        const p = sl.program(({ uv }) => {
            const c = sl.vec4(uv, 0, 1)
            const lum = sl.luminance(c)
            return sl.vec4(lum, lum, lum, 1)
        })
        const lum = p.nodes.find((n) => n.k === "call" && n.op === SLOP.LUMINANCE)
        expect(lum?.type).toBe(TYPE.FLOAT)
    })

    it("insists vec parts add up exactly", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(uv, 0))).toThrow(/needs 4 components, got 3/)
        expect(() => sl.program(({ uv }) => sl.vec4(uv, uv, uv))).toThrow(/needs 4 components, got 6/)
    })
})

describe("the hash is canonical", () => {
    it("is stable for the same program built two ways", () => {
        const a = sl.program(({ uv }) => sl.vec4(uv.x.add(0.5), uv.y, 0, 1))
        const b = sl.program(({ uv }) => {
            const half = sl.float(0.5)
            return sl.vec4(uv.x.add(half), uv.y, 0, 1)
        })
        expect(b.hash).toBe(a.hash)
    })

    it("ignores float noise in constants", () => {
        // 0.1 + 0.2 is 0.30000000000000004. If that produced a different hash,
        // a generated shader would be silently orphaned from its program and the
        // runtime would fall back to the VM without telling anybody.
        const a = sl.program(({ uv }) => sl.vec4(uv.x.add(0.3), 0, 0, 1))
        const b = sl.program(({ uv }) => sl.vec4(uv.x.add(0.1 + 0.2), 0, 0, 1))
        expect(b.hash).toBe(a.hash)
    })

    it("changes when the program changes", () => {
        const a = sl.program(({ uv }) => sl.vec4(uv.x, 0, 0, 1))
        const b = sl.program(({ uv }) => sl.vec4(uv.y, 0, 0, 1))
        expect(b.hash).not.toBe(a.hash)
    })

    it("changes when only a uniform's default changes", () => {
        const a = sl.program(() => sl.vec4(sl.uniform.float("k", 1), 0, 0, 1))
        const b = sl.program(() => sl.vec4(sl.uniform.float("k", 2), 0, 0, 1))
        expect(b.hash).not.toBe(a.hash)
    })

    it("does not depend on object identity or iteration order", () => {
        const p = trivial()
        expect(hashProgram(p.nodes, p.result, p.uniforms, p.textures)).toBe(p.hash)
        expect(hashProgram(p.nodes.slice(), p.result, p.uniforms.slice(), p.textures.slice())).toBe(p.hash)
    })

    it("is eight lowercase hex characters, so C# can produce the same string", () => {
        expect(trivial().hash).toMatch(/^[0-9a-f]{8}$/)
    })
})

describe("uniforms", () => {
    it("declares each name once however often it is read", () => {
        const p = sl.program(() => {
            const k = sl.uniform.float("k", 1)
            const k2 = sl.uniform.float("k", 1)
            return sl.vec4(k.add(k2), 0, 0, 1)
        })
        expect(p.uniforms.length).toBe(1)
        expect(p.uniforms[0]).toEqual({ name: "k", type: TYPE.FLOAT, value: [1] })
    })

    it("refuses one name declared at two widths", () => {
        expect(() => sl.program(() => {
            sl.uniform.float("k", 1)
            return sl.vec4(sl.uniform.vec4("k"), 0, 0, 1) as any
        })).toThrow(/declared as both a float and a vec4/)
    })
})

describe("textures", () => {
    it("shares a slot between reads of the same texture", () => {
        const p = sl.program(({ uv }) => {
            const t = sl.texture("noise")
            return t.sample(uv).add(t.sample(uv.mul(2))) as any
        })
        expect(p.textures.length).toBe(1)
    })

    it("refuses more than the sampler budget, when the program is WRITTEN", () => {
        // Sampler slots are the one ceiling neither backend can widen, so this
        // has to fail at authoring time with the limit named, not at draw time.
        expect(() => sl.program(({ uv }) => {
            for (let i = 0; i <= MAX_TEXTURES; i++) sl.texture("t" + i)
            return sl.vec4(uv, 0, 1)
        })).toThrow(new RegExp(`at most ${MAX_TEXTURES} textures`))
    })
})

describe("repeat unrolls at record time", () => {
    it("produces straight line code, so both backends see the same thing", () => {
        const one = sl.program(({ uv }) => {
            const v = sl.repeat(1, (i, acc) => acc.add(sl.noise(uv.mul(2 ** i))), sl.float(0))
            return sl.vec4(v, v, v, 1)
        })
        const four = sl.program(({ uv }) => {
            const v = sl.repeat(4, (i, acc) => acc.add(sl.noise(uv.mul(2 ** i))), sl.float(0))
            return sl.vec4(v, v, v, 1)
        })
        expect(four.nodes.length).toBeGreaterThan(one.nodes.length)
        expect(four.nodes.some((n) => n.k === "call" && n.op === SLOP.NOISE)).toBe(true)
    })

    it("returns the seed untouched for zero iterations", () => {
        const p = sl.program(({ uv }) => {
            const v = sl.repeat(0, (_i, acc) => acc.add(1), sl.float(7))
            return sl.vec4(v, uv, 1)
        })
        const consts = p.nodes.filter((n) => n.k === "const" && n.v[0] === 7)
        expect(consts.length).toBe(1)
    })

    it("refuses a count that cannot be unrolled", () => {
        expect(() => sl.program(({ uv }) => {
            sl.repeat(1.5, (_i, acc) => acc, sl.float(0))
            return sl.vec4(uv, 0, 1)
        })).toThrow(/whole number from 0 to 64/)
    })
})

describe("recording context", () => {
    it("refuses values built outside a program", () => {
        expect(() => sl.float(1)).toThrow(SLError)
        expect(() => sl.float(1)).toThrow(/only be built inside sl.program/)
    })

    it("refuses a value borrowed from another program", () => {
        let stolen: any = null
        sl.program(({ uv }) => { stolen = uv; return sl.vec4(uv, 0, 1) })
        expect(() => sl.program(({ uv }) => sl.vec4(uv.add(stolen), 0, 1)))
            .toThrow(/from another program/)
    })

    it("refuses nesting", () => {
        expect(() => sl.program((() => {
            // Deliberately wrong: a program cannot be built inside a program.
            return sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        }) as any)).toThrow(/cannot be nested/)
    })

    it("clears the context even when the body throws", () => {
        expect(() => sl.program(() => { throw new Error("boom") })).toThrow("boom")
        // If the context leaked, this would fail with "cannot be nested".
        expect(trivial().nodes.length).toBeGreaterThan(0)
    })
})

describe("the opcode table", () => {
    it("keeps every opcode in its family's range", () => {
        // The families are load bearing: the VM switches on ranges, and a value
        // in the wrong band would be dispatched as the wrong kind of thing.
        const families: Array<[string[], number, number]> = [
            [["ADD", "SUB", "MUL", "DIV", "MOD", "POW", "NEG", "RECIP"], 16, 47],
            [["SIN", "COS", "SQRT", "CLAMP", "SATURATE"], 48, 79],
            [["LENGTH", "DOT", "NORMALIZE"], 80, 95],
            [["MIX", "STEP", "SMOOTHSTEP", "SELECT"], 96, 111],
            [["RAMP", "HSV2RGB", "LUMINANCE"], 112, 127],
            [["NOISE", "SIMPLEX", "FBM", "SDF"], 128, 143],
            [["SAMPLE", "SAMPLE_LOD"], 144, 159],
        ]
        for (const [names, lo, hi] of families) {
            for (const n of names) {
                const code = (SLOP as any)[n]
                expect(code, `${n} is outside ${lo}..${hi}`).toBeGreaterThanOrEqual(lo)
                expect(code, `${n} is outside ${lo}..${hi}`).toBeLessThanOrEqual(hi)
            }
        }
    })

    it("assigns no opcode twice", () => {
        const codes = Object.values(SLOP)
        expect(new Set(codes).size).toBe(codes.length)
    })
})

describe("ramp is a macro, not an opcode", () => {
    it("expands into ops both backends already have", () => {
        const p = sl.program(({ uv }) => sl.ramp(uv.x, ["#000018", "#0080ff", "#ffffff"]))
        // No RAMP instruction anywhere: it became mixes.
        expect(p.nodes.some((n) => n.k === "call" && n.op === SLOP.RAMP)).toBe(false)
        expect(p.nodes.some((n) => n.k === "call" && n.op === SLOP.MIX)).toBe(true)
    })

    it("takes a ramp of any length, which an instruction could not", () => {
        const p = sl.program(({ uv }) =>
            sl.ramp(uv.x, ["#000", "#111", "#222", "#333", "#444", "#555", "#666", "#777"]))
        expect(p.nodes.length).toBeGreaterThan(0)
    })

    it("reads the three hex forms", () => {
        expect(sl.parseColor("#fff")).toEqual([1, 1, 1, 1])
        expect(sl.parseColor("#ff0000")).toEqual([1, 0, 0, 1])
        expect(sl.parseColor("#00ff0080")[3]).toBeCloseTo(128 / 255, 5)
    })

    it("refuses something that is not a colour", () => {
        expect(() => sl.parseColor("red")).toThrow(/not a colour/)
        expect(() => sl.program(({ uv }) => sl.ramp(uv.x, ["#fff"]))).toThrow(/at least 2 stops/)
    })

    it("makes the spec's headline example actually run", () => {
        const plasma = sl.program(({ uv, time }) => {
            const q = uv.mul(8).add(time.mul(0.4))
            const v = sl.sin(q.x).add(sl.sin(q.y)).add(sl.sin(q.x.add(q.y).mul(0.7)))
            return sl.ramp(v.mul(0.25).add(0.5), ["#000018", "#0080ff", "#ffffff"])
        })
        expect(plasma.hash).toMatch(/^[0-9a-f]{8}$/)
    })
})

describe("two component swizzles are real properties", () => {
    it("answers uv.yx rather than undefined", () => {
        // JavaScript gives `undefined` for an undeclared property, and that
        // undefined then fails inside vec4() about a value the author never
        // wrote. Anything reachable at runtime should be in the types too.
        const p = sl.program(({ uv }) => sl.vec4(uv.yx, 0, 1))
        expect(p.nodes.some((n) => n.k === "swizzle" && n.chans.join("") === "10")).toBe(true)
    })

    it("covers both naming sets", () => {
        const p = sl.program(() => {
            const c = sl.vec4(1, 2, 3, 4)
            return sl.vec4(c.gb, c.zw)
        })
        expect(p.nodes.filter((n) => n.k === "swizzle" && n.chans.length === 2).length).toBeGreaterThan(0)
    })

    it("still refuses a component the value does not have", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(uv.zw, 0, 1))).toThrow(/component 3 of a vec2/)
    })
})

describe("hsv2rgb", () => {
    it("stays a vec3 and reaches both backends", () => {
        const p = sl.program(({ uv }) => {
            const rgb = sl.hsv2rgb(sl.vec3(uv.x, 1, 1))
            return sl.vec4(rgb, 1)
        })
        const n = p.nodes.find((x) => x.k === "call" && x.op === SLOP.HSV2RGB)
        expect(n?.type).toBe(TYPE.VEC3)
    })
})

describe("sdf and voronoi", () => {
    it("uses the same shape ids fx does, so a hexagon means one thing", () => {
        const p = sl.program(({ uv }) => {
            const d = sl.sdf("hexagon", uv.sub(0.5), [0.3])
            return sl.vec4(d, d, d, 1)
        })
        const n = p.nodes.find((x) => x.k === "call" && x.op === SLOP.SDF)
        expect(n?.type).toBe(TYPE.FLOAT)
        expect((n as any).imm[0]).toBe(SDF_SHAPES.hexagon)
    })

    it("refuses a name that is not a shape", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(sl.sdf("blob" as any, uv), 0, 0, 1)))
            .toThrow(/not a shape/)
    })

    it("refuses more parameters than one instruction holds, and says why", () => {
        expect(() => sl.program(({ uv }) => sl.vec4(sl.sdf("circle", uv, [1, 2, 3, 4, 5]), 0, 0, 1)))
            .toThrow(/at most 4 shape parameters/)
    })

    it("takes an already transformed point rather than an offset", () => {
        // Position and rotation are not parameters on purpose: transforming the
        // point composes with the rest of the language and keeps the shape's own
        // parameters inside one instruction.
        const p = sl.program(({ uv }) => {
            const d = sl.sdf("circle", uv.sub(sl.vec2(0.5, 0.5)), [0.25])
            return sl.vec4(sl.smoothstep(0.01, 0, d), 0, 0, 1)
        })
        expect(p.nodes.some((n) => n.k === "call" && n.op === SLOP.SUB)).toBe(true)
    })

    it("gives voronoi a float from a vec2", () => {
        const p = sl.program(({ uv }) => {
            const v = sl.voronoi(uv.mul(6))
            return sl.vec4(v, v, v, 1)
        })
        const n = p.nodes.find((x) => x.k === "call" && x.op === SLOP.VORONOI)
        expect(n?.type).toBe(TYPE.FLOAT)
    })
})
