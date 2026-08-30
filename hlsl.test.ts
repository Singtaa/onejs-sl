import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { emitFragmentBody, emitShader, uniformProperty } from "./hlsl"

describe("the HLSL emitter", () => {
    it("gives one local per node, so CSE survives into the shader", () => {
        const p = sl.program(({ uv }) => {
            const q = uv.mul(8)
            return sl.vec4(q.x, q.y, q.x, 1)
        })
        const body = emitFragmentBody(p)
        const lines = body.split("\n")
        // The multiply is written ONCE however many nodes read it, and the
        // component taken from it is written once and referenced twice. That
        // second half is the point: a tree would have recomputed the whole
        // subexpression for each use.
        const muls = lines.filter((l) => /= \(n\d+ \* n\d+\);/.test(l))
        expect(muls.length).toBe(1)
        const mulName = /(n\d+) = \(n\d+ \* n\d+\);/.exec(muls[0])![1]
        const readers = lines.filter((l) => l.includes(`${mulName}.`))
        expect(readers.length).toBe(2)
        const composed = lines.find((l) => /float4 n\d+ = float4\(/.test(l))!
        const first = /float4\((n\d+), (n\d+), (n\d+),/.exec(composed)!
        expect(first[1]).toBe(first[3])   // q.x reused, not recomputed
    })

    it("emits each node exactly once and in dependency order", () => {
        const p = sl.program(({ uv, time }) => sl.vec4(sl.sin(uv.x.add(time)), uv.y, 0, 1))
        const body = emitFragmentBody(p)
        const declared: string[] = []
        for (const line of body.split("\n")) {
            const m = /^\s*\w+ (n\d+) = (.*);$/.exec(line)
            if (m === null) continue
            // Every name it references must already be declared.
            for (const ref of m[2].match(/\bn\d+\b/g) ?? []) {
                expect(declared, `${m[1]} uses ${ref} before it exists`).toContain(ref)
            }
            expect(declared, `${m[1]} declared twice`).not.toContain(m[1])
            declared.push(m[1])
        }
        expect(declared.length).toBeGreaterThan(3)
    })

    it("uses the IR's types directly, with no float4 padding", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        const body = emitFragmentBody(p)
        expect(body).toMatch(/float2 n\d+ = i\.uv;/)
        expect(body).toMatch(/return n\d+;/)
    })

    it("turns uniforms into real shader properties", () => {
        const p = sl.program(() => {
            const k = sl.uniform.float("intensity", 0.5)
            return sl.vec4(k, 0, 0, 1)
        })
        const src = emitShader(p)
        expect(src).toContain(`_u_intensity ("intensity", Vector) = (0.5`)
        expect(src).toContain("float4 _u_intensity;")
        // A float uniform reads one component of the float4 it is declared as.
        expect(emitFragmentBody(p)).toMatch(/_u_intensity\.x/)
    })

    it("declares a sampler per texture slot", () => {
        const p = sl.program(({ uv }) => {
            const t = sl.texture("art")
            return t.sample(uv)
        })
        const src = emitShader(p)
        expect(src).toContain(`_Tex0 ("art", 2D)`)
        expect(src).toContain("sampler2D _Tex0;")
        expect(src).toContain("tex2D(_Tex0,")
    })

    it("includes the helpers the VM shares, rather than restating them", () => {
        // Both backends computing noise from one source is what makes them
        // comparable at all. A second copy here would fail the golden image
        // check on nearly every program.
        const p = sl.program(({ uv }) => {
            const n = sl.noise(uv.mul(4))
            return sl.vec4(n, n, n, 1)
        })
        const src = emitShader(p)
        expect(src).toContain('#include "SLCommon.cginc"')
        expect(src).toContain("sl_valueNoise(")
        expect(src).not.toMatch(/float sl_valueNoise\s*\(/)   // included, not redefined
    })

    it("carries the program hash in the shader name, which is the link to it", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        expect(emitShader(p)).toContain(`Shader "Hidden/SLGenerated/${p.hash}"`)
    })

    it("is deterministic, so regenerating does not churn the file", () => {
        const build = () => sl.program(({ uv, time }) => {
            const q = uv.mul(3).add(time)
            return sl.ramp(sl.sin(q.x).mul(0.5).add(0.5), ["#001", "#fff"])
        })
        expect(emitShader(build())).toBe(emitShader(build()))
    })

    it("emits float literals that cannot be read as integers", () => {
        // `pow(x, 2)` and `pow(x, 2.0)` differ in some HLSL compilers, and an
        // integer literal where a float is meant is a classic silent divergence.
        const p = sl.program(({ uv }) => sl.vec4(uv.x.mul(2), 0, 0, 1))
        expect(emitFragmentBody(p)).toContain("2.0")
    })

    it("refuses an opcode it has no case for, rather than emitting nothing", () => {
        // A missing case must fail loudly here. Emitting a program that silently
        // differs between the VM and a compiled build is the one failure this
        // design cannot tolerate.
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        const broken = { ...p, nodes: p.nodes.map((n, i) => i === p.result ? { ...n, op: 9999 } as any : n) }
        expect(() => emitFragmentBody(broken as any)).toThrow(/no case for opcode 9999/)
    })

    it("names a uniform that could collide with ours", () => {
        expect(uniformProperty("Secs")).toBe("_u_Secs")
        expect(() => uniformProperty("not valid")).toThrow(/usable shader property name/)
    })
})
