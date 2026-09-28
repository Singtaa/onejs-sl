import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { encode } from "./encode"
import { SL_IR_VERSION, hashProgram } from "./ir"
import { fromJSON, toJSON } from "./serial"
import { SL_WIRE_VERSION } from "./ops"

const plasma = () => sl.program(({ uv, time }) => {
    const k = sl.uniform.float("k", 0.5)
    const p = uv.mul(8).add(time.mul(k))
    return sl.vec4(sl.sin(p.x), sl.cos(p.y), k, 1)
})

describe("IR versions", () => {
    it("stamp every program with the IR version, and put it in the hash", () => {
        const p = plasma()
        expect(p.version).toBe(SL_IR_VERSION)
        expect(hashProgram(p.nodes, p.result, p.uniforms, p.textures)).toBe(p.hash)
        expect(p.hash).toMatch(/^[0-9a-f]{8}$/)
    })

    it("round trip through JSON to an identical program", () => {
        const p = plasma()
        const back = fromJSON(JSON.parse(JSON.stringify(toJSON(p))))
        expect(back.hash).toBe(p.hash)
        expect(back.nodes).toEqual(p.nodes)
        expect(back.uniforms).toEqual(p.uniforms)
        expect(encode(back).data).toEqual(encode(p).data)
    })

    it("refuse a newer version, naming both", () => {
        const j = { ...toJSON(plasma()), v: SL_IR_VERSION + 1 }
        expect(() => fromJSON(j)).toThrow(new RegExp(`version ${SL_IR_VERSION + 1}.*up to ${SL_IR_VERSION}`))
    })

    it("read a missing version as 1", () => {
        const { v: _, ...rest } = toJSON(plasma())
        expect(fromJSON(rest).version).toBe(SL_IR_VERSION)
    })

    it("refuse an edited graph whose hash no longer matches", () => {
        const j = toJSON(plasma())
        const at = j.nodes.findIndex((n) => n.k === "const")
        const nodes = j.nodes.map((n, i) => i === at && n.k === "const" ? { ...n, v: n.v.map((x) => x + 1) } : n)
        expect(nodes).not.toEqual(j.nodes)
        expect(() => fromJSON({ ...j, nodes })).toThrow(/does not match its nodes/)
    })

    it("refuse what an emitter would print wrong rather than reject", () => {
        const j = toJSON(plasma())
        const bad = (nodes: unknown[], why: RegExp) => expect(() => fromJSON({ ...j, nodes })).toThrow(why)
        bad([{ k: "const", type: 1, v: [1] }, { k: "call", type: 1, op: 999, args: [0] }], /opcode 999/)
        bad([{ k: "call", type: 1, op: 16, args: [0] }], /earlier node/)
        bad([{ k: "const", type: 2, v: [1] }], /2 constant with 1 values/)
        bad([{ k: "input", type: 1, name: "uv" }], /does not exist at that width/)
        bad([{ k: "loop", type: 1 }], /not a kind of node/)
        expect(() => fromJSON({ ...j, result: j.nodes.length })).toThrow(/not a node/)
    })
})

describe("the caps", () => {
    // 0.2.0's builder wrote these; the builder refuses them now, so a stored
    // one is the way they still arrive.
    it("refuses a program with a fifth texture", () => {
        const j = toJSON(sl.program(({ uv }) => {
            for (let i = 0; i < 4; i++) sl.texture("t" + i)
            return sl.vec4(uv, 0, 1)
        }))
        const five = { ...j, textures: [...j.textures, { name: "t4", slot: 4 }], hash: undefined }
        expect(() => fromJSON(five)).toThrow(/this program declares 5 textures and a program may sample 4\./)
    })

    it("refuses a program with a seventeenth uniform", () => {
        const j = toJSON(sl.program(() => {
            for (let i = 0; i < 16; i++) sl.uniform.float("u" + i)
            return sl.vec4(0, 0, 0, 1)
        }))
        const seventeen = { ...j, uniforms: [...j.uniforms, { name: "u16", type: 1, value: [0] }], hash: undefined }
        expect(() => fromJSON(seventeen)).toThrow(/this program declares 17 uniforms and a program may hold 16\./)
    })
})

describe("the wire version", () => {
    it("is 1 for every program that uses nothing newer", () => {
        expect(encode(plasma()).wire).toBe(1)
        expect(SL_WIRE_VERSION).toBeGreaterThanOrEqual(1)
    })
})
