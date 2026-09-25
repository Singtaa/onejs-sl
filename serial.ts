/**
 * The IR as JSON, for a host that stores or ships a program rather than its
 * source (`Specs/SL_PACKAGE.md` section 2).
 *
 * `toJSON` writes the version beside the graph. `fromJSON` is the only way
 * back in, and it checks everything an emitter relies on, because an emitter
 * handed a malformed graph does not fail: it prints a shader that computes
 * something else. A newer version is refused with a message naming both; an
 * older one is migrated to this one and rehashed under it.
 */
import {
    INPUTS, SLError, SL_IR_VERSION, TYPE, hashProgram,
    type NodeRef, type Program, type SLNode, type SLType, type TextureDecl, type UniformDecl,
} from "./ir"
import { SL_ARITY, SL_NAME } from "./ops"

export interface ProgramJSON {
    /** `SL_IR_VERSION` of the writer. Absent means 1. */
    v: number
    nodes: SLNode[]
    result: NodeRef
    uniforms: UniformDecl[]
    textures: TextureDecl[]
    hash: string
}

export function toJSON(p: Program): ProgramJSON {
    return { v: p.version, nodes: p.nodes, result: p.result, uniforms: p.uniforms, textures: p.textures, hash: p.hash }
}

export function fromJSON(json: unknown): Program {
    if (typeof json !== "object" || json === null) fail("a program must be an object")
    const j = json as Partial<ProgramJSON>
    const v = j.v ?? 1
    if (!Number.isInteger(v) || v < 1) fail(`its version must be a whole number from 1, got ${String(j.v)}`)
    if (v > SL_IR_VERSION) {
        fail(`it is IR version ${v}, and this compiler reads up to ${SL_IR_VERSION}. ` +
            `Update onejs-unity to read it, or rebuild it from its .sl source.`)
    }
    if (!Array.isArray(j.nodes) || j.nodes.length === 0) fail("it has no nodes")
    const nodes = j.nodes.map((n, i) => node(n, i))
    const result = j.result
    if (!Number.isInteger(result) || result! < 0 || result! >= nodes.length) fail(`its result ${String(result)} is not a node`)
    if (nodes[result!]!.type !== TYPE.VEC4) fail("its result is not a float4")
    const uniforms = (j.uniforms ?? []).map(uniform)
    const textures = (j.textures ?? []).map(texture)
    for (const n of nodes) {
        if (n.k === "uniform" && n.slot >= uniforms.length) fail(`a node reads uniform slot ${n.slot}, which is not declared`)
    }
    const hash = hashProgram(nodes, result!, uniforms, textures)
    // Same version, so the same maths and the same hash; a different one means
    // the file was edited or damaged, and its cached shader belongs to
    // something else. An older version is rehashed under this one on purpose.
    if (v === SL_IR_VERSION && j.hash !== undefined && j.hash !== hash) {
        fail(`its hash ${j.hash} does not match its nodes (${hash}); it was changed after it was written`)
    }
    return { version: SL_IR_VERSION, nodes, result: result!, uniforms, textures, hash, loops: [] }
}

function node(n: unknown, i: number): SLNode {
    if (typeof n !== "object" || n === null) fail(`node ${i} is not an object`)
    const x = n as Record<string, unknown>
    const type = x.type
    if (type !== 1 && type !== 2 && type !== 3 && type !== 4) fail(`node ${i} has no width 1 to 4`)
    const t = type as SLType
    const ref = (r: unknown, what: string): NodeRef => {
        if (!Number.isInteger(r) || (r as number) < 0 || (r as number) >= i) {
            fail(`node ${i}'s ${what} ${String(r)} does not refer to an earlier node`)
        }
        return r as number
    }
    const nums = (a: unknown, what: string): number[] => {
        if (!Array.isArray(a) || !a.every((e) => typeof e === "number" && Number.isFinite(e))) {
            fail(`node ${i}'s ${what} must be finite numbers`)
        }
        return a as number[]
    }
    switch (x.k) {
        case "const": {
            const v = nums(x.v, "value")
            if (v.length !== t) fail(`node ${i} is a float${t === 1 ? "" : t} constant with ${v.length} values`)
            return { k: "const", type: t, v }
        }
        case "input": {
            const name = x.name as keyof typeof INPUTS
            if (!(name in INPUTS) || INPUTS[name] !== t) fail(`node ${i} reads an input "${String(x.name)}" that does not exist at that width`)
            return { k: "input", type: t, name }
        }
        case "uniform": {
            if (!Number.isInteger(x.slot) || (x.slot as number) < 0) fail(`node ${i} has no uniform slot`)
            return { k: "uniform", type: t, slot: x.slot as number }
        }
        case "swizzle": {
            const chans = nums(x.chans, "channels")
            if (chans.length !== t || !chans.every((c) => Number.isInteger(c) && c >= 0 && c <= 3)) {
                fail(`node ${i}'s swizzle does not pick ${t} channels`)
            }
            return { k: "swizzle", type: t, src: ref(x.src, "source"), chans }
        }
        case "call": {
            const op = x.op as number
            if (SL_NAME[op] === undefined) {
                fail(`node ${i} calls opcode ${String(x.op)}, which this compiler does not know. ` +
                    `A newer compiler wrote it; its version says otherwise, so the file is damaged.`)
            }
            if (!Array.isArray(x.args)) fail(`node ${i} has no arguments list`)
            const args = (x.args as unknown[]).map((a) => ref(a, "argument"))
            const arity = SL_ARITY[op]
            if (arity !== undefined && arity >= 0 && args.length !== arity) {
                fail(`node ${i} calls ${SL_NAME[op]} with ${args.length} arguments; it takes ${arity}`)
            }
            const out: SLNode = { k: "call", type: t, op: op as never, args }
            if (x.imm !== undefined) out.imm = nums(x.imm, "immediates")
            return out
        }
        default:
            fail(`node ${i} is a "${String(x.k)}", which is not a kind of node`)
    }
}

function uniform(u: unknown, i: number): UniformDecl {
    const x = (u ?? {}) as Partial<UniformDecl>
    if (typeof x.name !== "string" || ![1, 2, 3, 4].includes(x.type as number) || !Array.isArray(x.value)) {
        fail(`uniform ${i} needs a name, a width and a value`)
    }
    return { name: x.name!, type: x.type as SLType, value: x.value!.slice() }
}

function texture(t: unknown, i: number): TextureDecl {
    const x = (t ?? {}) as Partial<TextureDecl>
    if (typeof x.name !== "string" || x.slot !== i) fail(`texture ${i} needs a name and slot ${i}`)
    return { name: x.name!, slot: i }
}

function fail(why: string): never {
    throw new SLError(`this program's IR cannot be read: ${why}.`)
}
