import { describe, it, expect } from "vitest"
import { parse, sl, SL_SDF_PARAMS } from "./index"
import { compile } from "./compile"
import { uniformDefaults } from "./sl"
// @ts-expect-error: plain JavaScript tooling, shared with the QuickJS run and the goldens runner
import { fixtureSources } from "../corpus/fixtures.mjs"

const sources: Record<string, string> = fixtureSources(SL_SDF_PARAMS)
const programs = Object.entries(sources).map(([name, source]) => [name, parse(source, { file: name })] as const)

describe("compile", () => {
    it("gives every program its own hash, names in slot order, defaults and sources", () => {
        expect(programs.length).toBeGreaterThan(50)
        for (const [name, p] of programs) {
            const c = compile(p)
            expect(c.hash, name).toBe(p.hash)
            expect(c.uniforms, name).toEqual(p.uniforms.map((u) => u.name))
            expect(c.defaults, name).toEqual(uniformDefaults(p))
            expect(c.textures, name).toEqual(p.textures.map((t) => t.name))
            for (const text of [c.hlsl, c.wgsl, c.glsl]) expect(text.length, name).toBeGreaterThan(0)
        }
    })

    it("enumerates its names and defaults, and not its sources", () => {
        const c = compile(programs[0]![1])
        expect(Object.keys(c).sort()).toEqual(["defaults", "hash", "textures", "uniforms"])
        expect(typeof c.hlsl).toBe("string")
    })

    /**
     * No budget: `long.sl` is over a thousand operations and `probe-hash.sl`
     * holds more than 8 values at once. Every backend draws them, and the
     * goldens hold what they draw.
     */
    it("takes a long program and one holding many values at once", () => {
        for (const name of ["long.sl", "probe-hash.sl"]) {
            const p = programs.find(([n]) => n === name)![1]
            const c = compile(p)
            expect(c.hash, name).toBe(p.hash)
            for (const text of [c.hlsl, c.wgsl, c.glsl]) expect(text.length, name).toBeGreaterThan(0)
        }
    })
})

describe("compile holds a program to the caps", () => {
    // Every program passes through compile on its way to a host, however it
    // was made, so this is the check nothing can go around.
    const base = parse("texture2D t0;\nuniform float u0 = 0;\nfloat4 main() { return tex2D(t0, uv) * u0; }")

    it("refuses a fifth texture", () => {
        const textures = Array.from({ length: 5 }, (_, i) => ({ name: "t" + i, slot: i }))
        expect(() => compile({ ...base, textures })).toThrow(/this program declares 5 textures and a program may sample 4\./)
    })

    it("refuses a seventeenth uniform", () => {
        const uniforms = Array.from({ length: 17 }, (_, i) => ({ name: "u" + i, type: 1 as const, value: [0] }))
        expect(() => compile({ ...base, uniforms })).toThrow(/this program declares 17 uniforms and a program may hold 16\./)
    })

    it("takes a program at both caps", () => {
        const textures = Array.from({ length: 4 }, (_, i) => ({ name: "t" + i, slot: i }))
        const uniforms = Array.from({ length: 16 }, (_, i) => ({ name: "u" + i, type: 1 as const, value: [0] }))
        expect(compile({ ...base, textures, uniforms }).textures).toHaveLength(4)
    })
})

/**
 * The uniform names, in slot order.
 *
 * Every backend addresses a uniform by slot, so a host holding the name
 * "warp" needs this to find slot 0.
 */
describe("the uniform table", () => {
    it("lists names in the order their slots were handed out", () => {
        const p = sl.program(() => {
            const a = sl.uniform.float("alpha", 0.1)
            const b = sl.uniform.float("beta", 0.2)
            return sl.vec4(a, b, 0, 1)
        })
        expect(compile(p).uniforms).toEqual(["alpha", "beta"])
    })

    it("indexes at the slot each uniform was given", () => {
        const p = sl.program(() => {
            const a = sl.uniform.float("first", 0)
            const b = sl.uniform.float("second", 0)
            return sl.vec4(b, a, 0, 1)
        })
        const c = compile(p)
        for (const [slot, name] of c.uniforms.entries()) {
            expect(p.uniforms[slot]!.name, `slot ${slot} is ${name}`).toBe(name)
        }
    })

    it("declares one entry per uniform, not one per use", () => {
        const p = sl.program(({ uv }) => {
            const k = sl.uniform.float("k", 0.5)
            return sl.vec4(uv.x.mul(k), uv.y.mul(k), k, 1)
        })
        expect(compile(p).uniforms).toEqual(["k"])
    })

    it("is empty for a program that declares none", () => {
        expect(compile(sl.program(({ uv }) => sl.vec4(uv, 0, 1))).uniforms).toEqual([])
    })
})

describe("the compiled program carries its HLSL for a host that can compile it", () => {
    it("emits lazily, once, and keeps it out of enumeration", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        const c = compile(p)
        expect(Object.keys(c)).not.toContain("hlsl")
        expect(JSON.stringify(c)).not.toContain("Shader ")
        const first = c.hlsl
        expect(first).toContain(`Shader "Hidden/SLGenerated/${p.hash}"`)
        expect(c.hlsl).toBe(first)
    })
})
