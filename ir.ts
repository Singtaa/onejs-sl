/**
 * The shader language IR: one graph, two consumers.
 *
 * Phase 1 of `Specs/SHADER_LANG.md` section 4. Everything the VM encoder and the
 * HLSL emitter do is a function of this shape, so it is the part worth getting
 * right before either exists.
 *
 * Four properties are load bearing:
 *
 * **Every node carries its type.** Both backends need it and computing it twice
 * is how they would disagree. It is inferred while recording, which is also what
 * produces the author facing type errors.
 *
 * **Nodes are a flat array in topological order.** A node refers to earlier
 * nodes by index only, never forwards, so an encoder can walk the array once and
 * emit in order. The hash deliberately does NOT depend on that order; see
 * `hashProgram`.
 *
 * **The graph is a DAG, not a tree.** `const p = ...` used twice is one node
 * with two references, enforced here by hash consing rather than left to a later
 * pass. A tree would silently square the cost of the most natural way to write a
 * shader.
 *
 * **Nothing here knows about shaders.** No HLSL, no texture layout, no register
 * allocation. Those belong to the backends; this file is the contract between
 * them, and it is fully testable with no GPU.
 */

import { SLOP, SL_ARITY, SL_NAME, type SLOpCode } from "./ops"

/** Component count. The only notion of type the IR has. */
export const TYPE = { FLOAT: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as const
export type SLType = 1 | 2 | 3 | 4

/** What a program is given per pixel. See section 3.4. */
export const INPUTS = {
    uv: TYPE.VEC2,
    fragCoord: TYPE.VEC2,
    resolution: TYPE.VEC2,
    time: TYPE.FLOAT,
    aspect: TYPE.FLOAT,
} as const
export type InputName = keyof typeof INPUTS

/** Index into `Program.nodes`. Always refers backwards. */
export type NodeRef = number

export type SLNode =
    | { k: "const"; type: SLType; v: number[] }
    | { k: "input"; type: SLType; name: InputName }
    | { k: "uniform"; type: SLType; slot: number }
    | { k: "swizzle"; type: SLType; src: NodeRef; chans: number[] }
    | { k: "call"; type: SLType; op: SLOpCode; args: NodeRef[]; imm?: number[] }

export interface UniformDecl {
    name: string
    type: SLType
    /** Default, used when a caller does not supply the uniform. */
    value: number[]
}

export interface TextureDecl {
    name: string
    /** Sampler slot, assigned in declaration order. */
    slot: number
}

export interface Program {
    nodes: SLNode[]
    /** Must be VEC4: a program produces a colour. */
    result: NodeRef
    uniforms: UniformDecl[]
    textures: TextureDecl[]
    /** Canonical, stable across machines. See `hashProgram`. */
    hash: string
}

/**
 * Sampler slots in a fragment shader on the WebGL2 baseline, minus one for the
 * program texture itself. Exceeding it is refused when the program is written
 * rather than when it is drawn, with a message naming the limit.
 */
export const MAX_TEXTURES = 15

/** Instructions a single program may hold. Generous; the ceiling that matters is registers. */
export const MAX_NODES = 4096

export class SLError extends Error {
    constructor(message: string) {
        super("[onejs sl] " + message)
        this.name = "SLError"
    }
}

/**
 * Records a graph. One per `program()` call.
 *
 * Hash consing happens here, at `add`, rather than as a later pass, because the
 * author already told us what is shared when they wrote `const`. Recomputing it
 * afterwards would be doing work to recover information we were handed.
 */
export class Builder {
    readonly nodes: SLNode[] = []
    readonly uniforms: UniformDecl[] = []
    readonly textures: TextureDecl[] = []
    private readonly interned = new Map<string, NodeRef>()

    add(node: SLNode): NodeRef {
        if (this.nodes.length >= MAX_NODES) {
            throw new SLError(`a program may hold at most ${MAX_NODES} operations`)
        }
        const key = keyOf(node)
        const seen = this.interned.get(key)
        if (seen !== undefined) return seen
        const ref = this.nodes.push(node) - 1
        this.interned.set(key, ref)
        return ref
    }

    call(op: SLOpCode, type: SLType, args: NodeRef[], imm?: number[]): NodeRef {
        const arity = SL_ARITY[op]
        if (arity >= 0 && args.length !== arity) {
            throw new SLError(`${SL_NAME[op]} takes ${arity} argument(s), got ${args.length}`)
        }
        for (const a of args) {
            if (a < 0 || a >= this.nodes.length) {
                throw new SLError(`${SL_NAME[op]} refers to a node that does not exist yet`)
            }
        }
        return this.add(imm === undefined ? { k: "call", type, op, args } : { k: "call", type, op, args, imm })
    }

    constant(v: number[]): NodeRef {
        for (const n of v) {
            if (!Number.isFinite(n)) throw new SLError(`a constant must be finite, got ${n}`)
        }
        return this.add({ k: "const", type: v.length as SLType, v: v.slice() })
    }

    uniform(name: string, type: SLType, value: number[]): NodeRef {
        const existing = this.uniforms.findIndex((u) => u.name === name)
        if (existing >= 0) {
            const u = this.uniforms[existing]
            if (u.type !== type) {
                throw new SLError(`uniform "${name}" is declared as both a ${widthName(u.type)} and a ${widthName(type)}`)
            }
            return this.add({ k: "uniform", type, slot: existing })
        }
        const slot = this.uniforms.length
        this.uniforms.push({ name, type, value: value.slice() })
        return this.add({ k: "uniform", type, slot })
    }

    texture(name: string): number {
        const existing = this.textures.findIndex((t) => t.name === name)
        if (existing >= 0) return this.textures[existing].slot
        if (this.textures.length >= MAX_TEXTURES) {
            throw new SLError(
                `a program may sample at most ${MAX_TEXTURES} textures, and this one asks for ` +
                `${this.textures.length + 1}. That ceiling is the fragment shader's sampler slots ` +
                `on the WebGL2 baseline, so it cannot be widened.`,
            )
        }
        const slot = this.textures.length
        this.textures.push({ name, slot })
        return slot
    }
}

/** Structural key for hash consing. Order matters and is fixed by the node shape. */
function keyOf(n: SLNode): string {
    switch (n.k) {
        case "const": return `c:${n.type}:${n.v.map(fixed).join(",")}`
        case "input": return `i:${n.name}`
        case "uniform": return `u:${n.slot}`
        case "swizzle": return `s:${n.src}:${n.chans.join("")}`
        case "call": return `f:${n.op}:${n.args.join(",")}:${(n.imm ?? []).map(fixed).join(",")}`
    }
}

/**
 * Constants at a fixed precision, so two constants that differ only in float
 * noise intern to one node and, more importantly, hash the same on every
 * machine. See `hashProgram` for why that matters.
 */
export function fixed(n: number): string {
    return Object.is(n, -0) ? "0" : n.toPrecision(9)
}

export function widthName(t: SLType): string {
    return t === 1 ? "float" : `vec${t}`
}

/**
 * A canonical, machine independent hash of a program.
 *
 * This is the link between a program and its compiled shader. If it differs
 * between the machine that generated the shader and the machine that runs it,
 * the runtime silently falls back to the VM and nobody is told, which is the
 * worst failure this design can have: correct output, quietly slow, no error.
 *
 * So it hashes the canonicalised node array and nothing else. Never object
 * identity, never insertion order of a Map, never a JSON stringify whose key
 * order is an implementation detail. Constants go through `fixed` so 0.1 + 0.2
 * and 0.30000000000000004 do not produce different shaders.
 *
 * FNV-1a, because it needs to be stable and identical in TypeScript and in C#,
 * not cryptographic.
 */
export function hashProgram(nodes: SLNode[], result: NodeRef, uniforms: UniformDecl[], textures: TextureDecl[]): string {
    // MERKLE, not a walk of the array in storage order.
    //
    // The first version hashed nodes[] front to back, which made the hash depend
    // on the order the author happened to build things in. Hoisting a shared
    // subexpression into a `const` moved a node earlier, changed the hash, and
    // orphaned the program from a shader generated for it, without changing what
    // the program computes. That is the exact failure this hash exists to
    // prevent, so the fix is to hash the SHAPE and not the storage.
    //
    // Each node's digest is computed from its kind, its type and its children's
    // digests, so two graphs that compute the same thing agree however they were
    // assembled. It also ignores nodes not reachable from the result, which is
    // correct: dead nodes generate no shader code.
    const digest = new Map<NodeRef, string>()

    const of = (ref: NodeRef): string => {
        const seen = digest.get(ref)
        if (seen !== undefined) return seen
        const n = nodes[ref]
        let body: string
        switch (n.k) {
            case "const": body = `c:${n.type}:${n.v.map(fixed).join(",")}`; break
            case "input": body = `i:${n.name}`; break
            // By slot rather than by name: the slot is what the generated shader
            // lays out, so two programs whose uniforms differ only in name still
            // produce different shaders and must not share a hash. The names go
            // in separately below.
            case "uniform": body = `u:${n.slot}:${n.type}`; break
            case "swizzle": body = `s:${of(n.src)}:${n.chans.join("")}`; break
            case "call": body = `f:${n.op}:${n.args.map(of).join(",")}:${(n.imm ?? []).map(fixed).join(",")}`; break
        }
        const d = fnv1a(body + "|" + n.type)
        digest.set(ref, d)
        return d
    }

    const parts: string[] = [`v${SL_HASH_VERSION}`, of(result)]
    for (const u of uniforms) parts.push(`U:${u.name}:${u.type}:${u.value.map(fixed).join(",")}`)
    for (const t of textures) parts.push(`T:${t.name}:${t.slot}`)
    return fnv1a(parts.join("|"))
}

/** Bumped when the hashing scheme changes, which invalidates generated shaders. */
export const SL_HASH_VERSION = 1

function fnv1a(s: string): string {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        // >>> 0 after each step: JS bitwise ops are signed 32 bit, and a C#
        // implementation of the same hash must agree bit for bit.
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
    }
    return h.toString(16).padStart(8, "0")
}

export { SLOP }
