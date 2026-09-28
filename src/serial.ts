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
    INPUTS, SLError, SL_IR_VERSION, TYPE, checkCaps, controlOf, controlProblem, formProblem, hashProgram, programVersion,
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
            `Update onejs-sl to read it, or rebuild it from its .sl source.`)
    }
    if (!Array.isArray(j.nodes) || j.nodes.length === 0) fail("it has no nodes")
    const nodes = j.nodes.map((n, i) => node(n, i))
    nodes.forEach((n, i) => {
        const problem = n.k === "call" ? formProblem(n, nodes) : null
        if (problem !== null) fail(`node ${i} is not a form its op has: ${problem}`)
    })
    const result = j.result
    if (!Number.isInteger(result) || result! < 0 || result! >= nodes.length) fail(`its result ${String(result)} is not a node`)
    const out = nodes[result!]!
    if (out.k === "if" || out.k === "loop" || out.type !== TYPE.VEC4 || out.kind !== undefined) fail("its result is not a float4")
    const uniforms = (j.uniforms ?? []).map(uniform)
    const textures = (j.textures ?? []).map(texture)
    checkCaps({ uniforms, textures })
    for (const n of nodes) {
        if (n.k === "uniform" && n.slot >= uniforms.length) fail(`a node reads uniform slot ${n.slot}, which is not declared`)
    }
    // The lowest version that has these nodes, which is what the writer
    // recorded unless the file predates version 2 (whose nodes version 2 reads
    // as they are) or was edited. One that claims less than its nodes need
    // holds something its version never had.
    const version = programVersion(nodes, result!)
    if (v < version && v >= 2) fail(`it says IR version ${v} and holds nodes version ${version} added; it was changed after it was written`)
    const hash = hashProgram(nodes, result!, uniforms, textures)
    // Same version, so the same maths and the same hash; a different one means
    // the file was edited or damaged, and its cached shader belongs to
    // something else. A version 1 file is rehashed under version 2 on purpose.
    if (v === version && j.hash !== undefined && j.hash !== hash) {
        fail(`its hash ${j.hash} does not match its nodes (${hash}); it was changed after it was written`)
    }
    return { version, nodes, result: result!, uniforms, textures, hash }
}

function node(n: unknown, i: number): SLNode {
    if (typeof n !== "object" || n === null) fail(`node ${i} is not an object`)
    const x = n as Record<string, unknown>
    const refs = (a: unknown, what: string): NodeRef[] => {
        if (!Array.isArray(a) || !a.every((r) => Number.isInteger(r) && r >= 0 && r < i)) fail(`node ${i}'s ${what} do not all refer to earlier nodes`)
        return a as number[]
    }
    const whole = (v: unknown, what: string): number => {
        if (!Number.isInteger(v) || (v as number) < 0) fail(`node ${i}'s ${what} is not a whole number`)
        return v as number
    }
    // IR 4's control nodes carry no type of their own.
    if (x.k === "if") {
        const [cond, then, otherwise] = [refs([x.cond], "condition")[0]!, refs(x.then, "then results"), refs(x.else, "else results")]
        if (then.length !== otherwise.length) fail(`node ${i} is an if whose two sides give different numbers of results`)
        return { k: "if", cond, then, else: otherwise }
    }
    if (x.k === "loop") {
        const init = refs(x.init, "starting values"), next = refs(x.next, "next values")
        if (init.length !== next.length) fail(`node ${i} is a loop whose next values do not match its starting values`)
        if (!Number.isInteger(x.max) || (x.max as number) < 1) fail(`node ${i} is a loop with no turn limit`)
        return { k: "loop", id: whole(x.id, "loop id"), init, cond: refs([x.cond], "condition")[0]!, next, max: x.max as number }
    }
    const kind = x.kind
    if (kind !== undefined && kind !== "int" && kind !== "uint" && kind !== "bool") fail(`node ${i} holds a "${String(kind)}", which is not a kind`)
    const withKind = <T extends SLNode>(v: T): T => (kind === undefined ? v : { ...v, kind })
    if (x.k === "param" || x.k === "proj") {
        const type = x.type
        if (type !== 1 && type !== 2 && type !== 3 && type !== 4) fail(`node ${i} has no width 1 to 4`)
        if (x.k === "param") return withKind({ k: "param", type: type as SLType, loop: whole(x.loop, "loop"), index: whole(x.index, "index") })
        return withKind({ k: "proj", type: type as SLType, src: refs([x.src], "source")[0]!, index: whole(x.index, "index") })
    }
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
            return withKind({ k: "const", type: t, v })
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
            return withKind({ k: "swizzle", type: t, src: ref(x.src, "source"), chans })
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
            const out: SLNode = withKind({ k: "call", type: t, op: op as never, args })
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
    const out: UniformDecl = { name: x.name!, type: x.type as SLType, value: x.value!.slice() }
    if (x.colour === true) out.colour = true
    // Its control: shapes checked here, sense checked by the one check the
    // compiler uses, so a hand edited file cannot give a host a range it would
    // choke on.
    const r = x.range as { min?: unknown; max?: unknown; step?: unknown } | undefined
    if (r !== undefined && (typeof r !== "object" || r === null || typeof r.min !== "number" || typeof r.max !== "number" ||
        (r.step !== undefined && typeof r.step !== "number"))) {
        fail(`uniform ${i}'s range needs a min and a max, and a step if any, as numbers`)
    }
    if (x.options !== undefined && (!Array.isArray(x.options) || !x.options.every((o) => typeof o === "string"))) {
        fail(`uniform ${i}'s options must be a list of names`)
    }
    for (const f of ["header", "label"] as const) {
        if (x[f] !== undefined && typeof x[f] !== "string") fail(`uniform ${i}'s ${f} must be text`)
    }
    for (const f of ["toggle", "hide"] as const) {
        if (x[f] !== undefined && x[f] !== true) fail(`uniform ${i}'s ${f} can only be true`)
    }
    const control = controlOf(x)
    const problem = controlProblem(out.type, out.value, control)
    if (problem !== null) fail(`uniform ${i}: ${problem.message}`)
    return Object.assign(out, control)
}

function texture(t: unknown, i: number): TextureDecl {
    const x = (t ?? {}) as Partial<TextureDecl>
    if (typeof x.name !== "string" || x.slot !== i) fail(`texture ${i} needs a name and slot ${i}`)
    return { name: x.name!, slot: i }
}

function fail(why: string): never {
    throw new SLError(`this program's IR cannot be read: ${why}.`)
}
