import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { manifest } from "./manifest"

const a = () => sl.program(({ uv }) => sl.vec4(uv, 0, 1))
const b = () => sl.program(({ uv }) => sl.vec4(uv.yx, 1, 1))

describe("the program manifest", () => {
    it("carries the hash the runtime looks a shader up by", () => {
        const p = a()
        const m = manifest([p])
        expect(m.programs[0].hash).toBe(p.hash)
        expect(m.programs[0].hlsl).toContain(p.hash)
    })

    it("collapses duplicates, because equal hashes ARE the same program", () => {
        // A shared helper returning a program gets called from several places in
        // any real app, so this is the common case rather than a mistake.
        expect(manifest([a(), a(), a()]).programs.length).toBe(1)
    })

    it("is stable under declaration order, so the file does not churn", () => {
        // A manifest that rewrote itself every build would dirty every generated
        // shader and make Unity recompile all of them for no change.
        expect(JSON.stringify(manifest([a(), b()]))).toBe(JSON.stringify(manifest([b(), a()])))
    })

    it("lists uniform names in slot order, for binding by name", () => {
        const p = sl.program(() => {
            const k = sl.uniform.float("intensity", 1)
            const t = sl.uniform.vec4("tint", [1, 0, 0, 1])
            return t.mul(k) as any
        })
        expect(manifest([p]).programs[0].uniforms).toEqual(["intensity", "tint"])
    })
})
