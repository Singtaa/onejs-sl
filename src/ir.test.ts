import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { compile } from "./compile"
import { reachable } from "./ir"

describe("reachability", () => {
    it("drops work the result does not depend on", () => {
        const p = sl.program(({ uv }) => {
            const unused = sl.sin(uv.x).mul(999)   // computed and thrown away
            void unused
            return sl.vec4(uv, 0, 1)
        })
        const live = reachable(p.nodes, p.result)
        expect(live.length).toBeLessThan(p.nodes.length)
        // The 999 constant is the giveaway that the dead branch survived.
        expect(compile(p).hlsl).not.toContain("999")
    })

    it("keeps the inputs the program reads and drops the ones it does not", () => {
        // program() declares all five inputs up front, so an unread one is dead
        // by construction. This is the common case, not an edge case: almost no
        // program reads fragCoord, resolution AND aspect.
        const p = sl.program(({ uv, time }) => sl.vec4(uv.x.add(time), uv.y, 0, 1))
        const live = new Set(reachable(p.nodes, p.result))
        const named = (n: string) => p.nodes.findIndex((x) => x.k === "input" && x.name === n)
        expect(live.has(named("uv"))).toBe(true)
        expect(live.has(named("time"))).toBe(true)
        expect(live.has(named("fragCoord"))).toBe(false)
        expect(live.has(named("resolution"))).toBe(false)
        expect(live.has(named("aspect"))).toBe(false)
    })

    it("keeps every node of a program that uses all of them", () => {
        const p = sl.program(({ uv, fragCoord, resolution, time, aspect }) =>
            sl.vec4(uv.x.add(time), fragCoord.y.add(aspect), resolution.x, 1))
        expect(reachable(p.nodes, p.result).length).toBe(p.nodes.length)
    })

    it("stays topologically ordered after pruning", () => {
        const p = sl.program(({ uv, time }) => {
            const a = uv.mul(4).add(time)
            return sl.vec4(sl.sin(a.x), sl.cos(a.y), 0, 1)
        })
        const order = reachable(p.nodes, p.result)
        const pos = new Map(order.map((r, i) => [r, i]))
        for (const ref of order) {
            const n = p.nodes[ref]
            const reads = n.k === "swizzle" ? [n.src] : n.k === "call" ? n.args : []
            for (const r of reads) expect(pos.get(r)!).toBeLessThan(pos.get(ref)!)
        }
    })
})
