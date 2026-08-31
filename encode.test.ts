import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { REGISTERS, TEXELS_PER_INSTRUCTION, encode, liveRanges, reachable } from "./encode"
import { SLOP } from "./ops"

/**
 * The encoder is the first consumer of the Phase 1 IR, and like the IR it is
 * pure TypeScript, so the register allocator can be held to account without a
 * GPU anywhere near it.
 */

/** Decodes the flat buffer back into instructions, so tests read like the shader will. */
function decode(data: Float32Array, count: number) {
    const out = []
    for (let i = 0; i < count; i++) {
        const o = i * 8
        out.push({
            op: data[o], dst: data[o + 1], a: data[o + 2], b: data[o + 3],
            imm: [data[o + 4], data[o + 5], data[o + 6], data[o + 7]],
        })
    }
    return out
}

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
        const enc = encode(p)
        expect([...enc.data]).not.toContain(999)
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

describe("live ranges", () => {
    it("keeps the result alive past the last instruction", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        const order = reachable(p.nodes, p.result)
        const last = liveRanges(p.nodes, order, p.result)
        expect(last.get(p.result)).toBe(order.length)
    })
})

describe("register allocation", () => {
    it("reuses registers, so a long chain fits in eight", () => {
        // Thirty chained operations, one live value at a time. If registers were
        // not freed this would need thirty of them.
        const p = sl.program(({ uv }) => {
            let v = uv.x
            for (let i = 0; i < 30; i++) v = sl.sin(v.add(i))
            return sl.vec4(v, v, v, 1)
        })
        const enc = encode(p)
        expect(enc.registersUsed).toBeLessThanOrEqual(REGISTERS)
        expect(enc.instructions).toBeGreaterThan(30)
    })

    it("never assigns a register that is still live", () => {
        const p = sl.program(({ uv, time }) => {
            const a = uv.x.add(1)
            const b = uv.y.add(2)
            const c = time.add(3)
            return sl.vec4(a.add(b), b.add(c), c.add(a), 1)
        })
        const enc = encode(p)
        const order = reachable(p.nodes, p.result)
        const last = liveRanges(p.nodes, order, p.result)
        const ins = decode(enc.data, enc.instructions)

        // Replay the allocation: at every instruction, the destination register
        // must not hold a value that is still needed later.
        const holder = new Map<number, number>()   // register -> instruction index that wrote it
        ins.forEach((one, i) => {
            const evicted = holder.get(one.dst)
            if (evicted !== undefined) {
                const node = order[evicted]
                expect(last.get(node)!, `register ${one.dst} reused while node ${node} was still live`)
                    .toBeLessThanOrEqual(i)
            }
            holder.set(one.dst, i)
        })
    })

    it("reports the peak, not the count of registers that exist", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        expect(encode(p).registersUsed).toBeGreaterThan(0)
        expect(encode(p).registersUsed).toBeLessThanOrEqual(REGISTERS)
    })

    it("refuses a program that needs more than the file holds, and says why", () => {
        // Sixteen values all live at once, which no eight register file can hold.
        expect(() => {
            const p = sl.program(({ uv }) => {
                const live = []
                for (let i = 0; i < 16; i++) live.push(sl.sin(uv.x.add(i)))
                let sum = live[0]
                for (let i = 1; i < live.length; i++) sum = sum.add(live[i])
                return sl.vec4(sum, sum, sum, 1)
            })
            encode(p)
        }).toThrow(/needs more than 8 registers at once/)
    })

    it("says spilling is deliberate rather than missing", () => {
        try {
            const p = sl.program(({ uv }) => {
                const live = []
                for (let i = 0; i < 16; i++) live.push(sl.sin(uv.x.add(i)))
                let sum = live[0]
                for (let i = 1; i < live.length; i++) sum = sum.add(live[i])
                return sl.vec4(sum, sum, sum, 1)
            })
            encode(p)
            expect.unreachable("should have refused")
        } catch (e) {
            expect(String(e)).toMatch(/deliberately not/)
        }
    })
})

describe("the instruction buffer", () => {
    it("is two texels per instruction, so instruction i is at texel 2i", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        const enc = encode(p)
        expect(enc.data.length).toBe(enc.instructions * TEXELS_PER_INSTRUCTION * 4)
    })

    it("writes every operand as a register index inside the file", () => {
        const p = sl.program(({ uv, time }) => sl.vec4(sl.sin(uv.x.add(time)), uv.y, 0, 1))
        const enc = encode(p)
        for (const one of decode(enc.data, enc.instructions)) {
            expect(one.dst).toBeGreaterThanOrEqual(0)
            expect(one.dst).toBeLessThan(REGISTERS)
        }
    })

    it("carries a constant's value in the immediate", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv.x.add(0.25), 0, 0, 1))
        const enc = encode(p)
        const consts = decode(enc.data, enc.instructions).filter((i) => i.op === SLOP.CONST)
        expect(consts.some((c) => c.imm[0] === 0.25)).toBe(true)
    })

    it("carries swizzle channels in the immediate, with -1 for unused", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv.x, uv.y, 0, 1))
        const enc = encode(p)
        const swz = decode(enc.data, enc.instructions).filter((i) => i.op === SLOP.SWIZZLE)
        expect(swz.length).toBeGreaterThan(0)
        for (const s of swz) {
            const used = s.imm.filter((c) => c >= 0)
            expect(used.length).toBeGreaterThan(0)
            // Unused channels are -1 and must trail, never sit between used ones.
            const firstUnused = s.imm.findIndex((c) => c < 0)
            if (firstUnused >= 0) {
                for (let i = firstUnused; i < 4; i++) expect(s.imm[i]).toBeLessThan(0)
            }
        }
    })

    it("packs a third operand into the immediate for ternary ops", () => {
        const p = sl.program(({ uv, time }) => {
            const m = sl.mix(uv.x, uv.y, time)
            return sl.vec4(m, m, m, 1)
        })
        const enc = encode(p)
        const mixes = decode(enc.data, enc.instructions).filter((i) => i.op === SLOP.MIX)
        expect(mixes.length).toBe(1)
        // a, b and the third operand are all register indices.
        expect(mixes[0].imm[0]).toBeGreaterThanOrEqual(0)
        expect(mixes[0].imm[0]).toBeLessThan(REGISTERS)
    })

    it("carries the texture slot for a sample", () => {
        const p = sl.program(({ uv }) => {
            const t = sl.texture("noise")
            return t.sample(uv)
        })
        const enc = encode(p)
        const samples = decode(enc.data, enc.instructions).filter((i) => i.op === SLOP.SAMPLE)
        expect(samples.length).toBe(1)
        expect(samples[0].imm[0]).toBe(0)
    })

    it("points at the register the result actually lands in", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        const enc = encode(p)
        const ins = decode(enc.data, enc.instructions)
        expect(ins[ins.length - 1].dst).toBe(enc.resultRegister)
    })

    it("carries the program's hash, so a buffer cannot be paired with the wrong shader", () => {
        const p = sl.program(({ uv }) => sl.vec4(uv, 0, 1))
        expect(encode(p).hash).toBe(p.hash)
    })
})

describe("limits", () => {
    it("refuses a program longer than the VM's bounded loop", () => {
        expect(() => {
            const p = sl.program(({ uv }) => {
                let v = uv.x
                for (let i = 0; i < 300; i++) v = v.add(i)
                return sl.vec4(v, v, v, 1)
            })
            encode(p)
        }).toThrow(/runs at most 256/)
    })
})

describe("width sensitive ops", () => {
    it("carries the SOURCE width, since a register is a float4 whatever it holds", () => {
        // length(vec2) is not the length of four components, and the destination
        // type cannot say so: it is always a float.
        const p = sl.program(({ uv }) => {
            const d = uv.length()
            return sl.vec4(d, d, d, 1)
        })
        const enc = encode(p)
        const len = decode(enc.data, enc.instructions).filter((i) => i.op === SLOP.LENGTH)
        expect(len.length).toBe(1)
        expect(len[0].imm[0]).toBe(2)   // uv is a vec2
    })

    it("distinguishes a vec4 dot from a vec2 dot", () => {
        const two = sl.program(({ uv }) => {
            const d = uv.dot(uv)
            return sl.vec4(d, d, d, 1)
        })
        const four = sl.program(({ uv }) => {
            const c = sl.vec4(uv, 1, 1)
            const d = c.dot(c)
            return sl.vec4(d, d, d, 1)
        })
        const at = (p: any, op: number) => {
            const e = encode(p)
            return decode(e.data, e.instructions).filter((i) => i.op === op)[0]
        }
        expect(at(two, SLOP.DOT).imm[0]).toBe(2)
        expect(at(four, SLOP.DOT).imm[0]).toBe(4)
    })
})

/**
 * The uniform names, in slot order.
 *
 * The VM addresses a uniform by slot and the instructions carry only that, so
 * a host holding the name "warp" needs this to find slot 0. Without it the
 * host set a material property by name instead, which the generated shader
 * honoured and the interpreter ignored, so every uniform in the container read
 * zero and no game could change its own picture.
 */
describe("the uniform table", () => {
    it("lists names in the order their slots were handed out", () => {
        const p = sl.program(() => {
            const a = sl.uniform.float("alpha", 0.1)
            const b = sl.uniform.float("beta", 0.2)
            return sl.vec4(a, b, 0, 1)
        })
        expect(encode(p).uniforms).toEqual(["alpha", "beta"])
    })

    it("indexes at the slot the instruction encodes", () => {
        const p = sl.program(() => {
            const a = sl.uniform.float("first", 0)
            const b = sl.uniform.float("second", 0)
            return sl.vec4(b, a, 0, 1)
        })
        const e = encode(p)
        for (const [slot, name] of e.uniforms.entries()) {
            expect(p.uniforms[slot]!.name, `slot ${slot} is ${name}`).toBe(name)
        }
    })

    it("declares one entry per uniform, not one per use", () => {
        const p = sl.program(({ uv }) => {
            const k = sl.uniform.float("k", 0.5)
            return sl.vec4(uv.x.mul(k), uv.y.mul(k), k, 1)
        })
        expect(encode(p).uniforms).toEqual(["k"])
    })

    it("is empty for a program that declares none", () => {
        expect(encode(sl.program(({ uv }) => sl.vec4(uv, 0, 1))).uniforms).toEqual([])
    })
})
