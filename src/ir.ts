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

/**
 * Inputs a program can name that are built from the ones above rather than
 * handed over by the host (`Specs/SL_NEXT.md` 6). Each read records the same
 * few nodes a program would if it wrote the expression out, and the builder's
 * hash consing makes every later read the same node. So there is no new
 * instruction, no VM or host change, and a program that never names one holds
 * no extra node, compiling to the bytes it always did.
 *
 *   texel     1 / resolution: one pixel, in uv
 *   centered  (uv - 0.5) * float2(aspect, 1): 0 at the centre, circles stay round
 */
export const DERIVED_INPUTS = {
    texel: TYPE.VEC2,
    centered: TYPE.VEC2,
} as const
export type DerivedInputName = keyof typeof DERIVED_INPUTS

/** Every input a program can name: the host's, then the derived ones. */
export type SourceInputName = InputName | DerivedInputName
export const SOURCE_INPUTS: Readonly<Record<SourceInputName, SLType>> = { ...INPUTS, ...DERIVED_INPUTS }

/** Index into `Program.nodes`. Always refers backwards. */
export type NodeRef = number

export type SLNode =
    | { k: "const"; type: SLType; v: number[] }
    | { k: "input"; type: SLType; name: InputName }
    | { k: "uniform"; type: SLType; slot: number }
    | { k: "swizzle"; type: SLType; src: NodeRef; chans: number[] }
    | { k: "call"; type: SLType; op: SLOpCode; args: NodeRef[]; imm?: number[] }

/**
 * How a host presents a uniform: a slider, a checkbox, a dropdown, a heading
 * above it, the name it shows, or no control at all (`Specs/SL_NEXT.md` 1).
 * Written in a `.sl` file as Unity's attributes, `[Range(0, 2)]` and the rest,
 * and in the EDSL as the last argument of `sl.uniform.float`.
 *
 * Metadata for a host, like `colour`: it changes nothing a program computes, so
 * it is never part of the hash, and two programs that differ only in it share
 * one compiled shader.
 */
export interface UniformControl {
    /** A slider from `min` to `max`, moving by `step` when there is one. A float only. */
    range?: { min: number; max: number; step?: number }
    /** A checkbox. The value is 0 or 1. A float only. */
    toggle?: true
    /** A dropdown of these names. The value is the index of the chosen one. A float only. */
    options?: string[]
    /** A heading shown above this uniform's control, starting a group. */
    header?: string
    /** The name the control shows, in place of the uniform's own. */
    label?: string
    /** No control: the host sets this one from code. */
    hide?: true
}

/** The fields of `UniformControl`, in the order a host reads them. */
export const CONTROL_FIELDS = ["range", "toggle", "options", "header", "label", "hide"] as const

/**
 * What is wrong with giving a uniform of `type` and default `value` this
 * control, or null. Names the field at fault, so the text form can mark the
 * attribute that wrote it. The one check, for `.sl` files and the EDSL alike.
 */
export function controlProblem(type: SLType, value: readonly number[], c: UniformControl): { field: keyof UniformControl; message: string } | null {
    const kinds = (["range", "toggle", "options"] as const).filter((k) => c[k] !== undefined)
    if (kinds.length > 1) {
        return { field: kinds[1]!, message: `a uniform is one control, so it cannot have both ${ATTRIBUTE_OF[kinds[0]!]} and ${ATTRIBUTE_OF[kinds[1]!]}` }
    }
    const kind = kinds[0]
    if (kind !== undefined && type !== TYPE.FLOAT) {
        return { field: kind, message: `${ATTRIBUTE_OF[kind]} is for a float, and this is a ${widthName(type)}` }
    }
    const v = value[0] ?? 0
    if (c.range !== undefined) {
        const { min, max, step } = c.range
        if (![min, max].every(Number.isFinite) || !(min < max)) {
            return { field: "range", message: `a range runs from a smaller number to a larger one, and this is ${min} to ${max}` }
        }
        if (step !== undefined && !(Number.isFinite(step) && step > 0)) {
            return { field: "range", message: `a range's step is a number above 0, and this is ${step}` }
        }
        if (v < min || v > max) {
            return { field: "range", message: `the default ${v} is outside the range ${min} to ${max}` }
        }
    }
    if (c.toggle === true && v !== 0 && v !== 1) {
        return { field: "toggle", message: `a toggle is 0 or 1, and the default is ${v}` }
    }
    if (c.options !== undefined) {
        if (c.options.length < 2) return { field: "options", message: "an enum lists at least two options" }
        const empty = c.options.findIndex((o) => o.trim() === "")
        if (empty >= 0) return { field: "options", message: `option ${empty + 1} of the enum has no name` }
        const twice = c.options.findIndex((o, i) => c.options!.indexOf(o) !== i)
        if (twice >= 0) return { field: "options", message: `the enum lists "${c.options[twice]}" twice` }
        if (!Number.isInteger(v) || v < 0 || v >= c.options.length) {
            return { field: "options", message: `an enum's value is the index of an option, 0 to ${c.options.length - 1}, and the default is ${v}` }
        }
    }
    for (const f of ["header", "label"] as const) {
        if (c[f] !== undefined && c[f]!.trim() === "") return { field: f, message: `${ATTRIBUTE_OF[f]} needs some text` }
    }
    return null
}

/** How each field is written in a `.sl` file, for the messages above. */
const ATTRIBUTE_OF: Record<keyof UniformControl, string> = {
    range: "[Range]", toggle: "[Toggle]", options: "[Enum]", header: "[Header]", label: "[Label]", hide: "[Hide]",
}

export interface UniformDecl extends UniformControl {
    name: string
    type: SLType
    /** Default, used when a caller does not supply the uniform. */
    value: number[]
    /**
     * A colour: `value` is sRGB as written, what a host sets and a colour
     * picker shows, and every read converts it to linear. Set by a hex default
     * in a `.sl` file or `sl.uniform.colour`. Metadata for a host: the reads'
     * conversion is already in the graph, so it is not part of the hash.
     */
    colour?: true
}

export interface TextureDecl {
    name: string
    /** Sampler slot, assigned in declaration order. */
    slot: number
}

/**
 * The nodes one `sl.repeat` call unrolled into, as the half open range
 * `[start, end)` of `nodes`. Diagnostic only: the instruction ceiling error
 * uses it to say which loop the operations came from, since a program that is
 * "too long" has usually been made so by one count.
 */
export interface LoopSpan {
    count: number
    start: NodeRef
    end: NodeRef
}

export interface Program {
    /** The `SL_IR_VERSION` this program's nodes mean what they mean under. */
    version: number
    nodes: SLNode[]
    /** Must be VEC4: a program produces a colour. */
    result: NodeRef
    uniforms: UniformDecl[]
    textures: TextureDecl[]
    /** Canonical, stable across machines. See `hashProgram`. */
    hash: string
    /** Not part of the hash: it changes nothing about what the program computes. */
    loops: LoopSpan[]
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
    readonly loops: LoopSpan[] = []
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

    uniform(name: string, type: SLType, value: number[], colour = false, control: UniformControl = {}): NodeRef {
        const existing = this.uniforms.findIndex((u) => u.name === name)
        if (existing >= 0) {
            const u = this.uniforms[existing]
            if (u.type !== type) {
                throw new SLError(`uniform "${name}" is declared as both a ${widthName(u.type)} and a ${widthName(type)}`)
            }
            if ((u.colour === true) !== colour) {
                throw new SLError(`uniform "${name}" is declared both as a colour and as plain numbers`)
            }
            // A second read may say nothing about the control, or the same thing again.
            const merged = { ...controlOf(u) }
            for (const f of CONTROL_FIELDS) {
                if (control[f] === undefined) continue
                if (merged[f] !== undefined && JSON.stringify(merged[f]) !== JSON.stringify(control[f])) {
                    throw new SLError(`uniform "${name}" is given two different ${f === "options" ? "enums" : f + "s"}`)
                }
                Object.assign(merged, { [f]: control[f] })
            }
            const problem = controlProblem(type, u.value, merged)
            if (problem !== null) throw new SLError(`uniform "${name}": ${problem.message}`)
            Object.assign(u, merged)
            return this.add({ k: "uniform", type, slot: existing })
        }
        const problem = controlProblem(type, value, control)
        if (problem !== null) throw new SLError(`uniform "${name}": ${problem.message}`)
        const slot = this.uniforms.length
        const decl: UniformDecl = { name, type, value: value.slice() }
        if (colour) decl.colour = true
        Object.assign(decl, controlOf(control))
        this.uniforms.push(decl)
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

/**
 * Nodes the result actually depends on, in order.
 *
 * Dead nodes are dropped rather than encoded. An author can produce them easily
 * by computing something and not using it, and the hash already ignores them, so
 * encoding them would make the buffer disagree with its own hash about what the
 * program is.
 */
export function reachable(nodes: SLNode[], result: NodeRef): NodeRef[] {
    const keep = new Set<NodeRef>()
    const stack = [result]
    while (stack.length > 0) {
        const ref = stack.pop()!
        if (keep.has(ref)) continue
        keep.add(ref)
        const n = nodes[ref]
        if (n.k === "swizzle") stack.push(n.src)
        else if (n.k === "call") for (const a of n.args) stack.push(a)
    }
    // Ascending, which is still topological because a node only refers backwards.
    return [...keep].sort((x, y) => x - y)
}

/**
 * The inputs a program reads, in `INPUTS` order. Dead nodes do not count: a
 * value computed and never used is not in the picture, so a program that does
 * that with `time` is still not animated.
 */
export function inputsUsed(p: Program): InputName[] {
    const read = new Set<InputName>()
    for (const ref of reachable(p.nodes, p.result)) {
        const n = p.nodes[ref]
        if (n.k === "input") read.add(n.name)
    }
    return (Object.keys(INPUTS) as InputName[]).filter((name) => read.has(name))
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

    // The IR version is in the hash, so a change to what an opcode means in the
    // IR changes every hash and every cache keyed by one recompiles rather than
    // serving the old maths. A change to the helper library alone (a noise's
    // arithmetic, say) is not one: every host includes the library's text when
    // it compiles, and none caches a compiled program by hash across a
    // library update, so the new text reaches every shader without a bump.
    const parts: string[] = [`v${SL_HASH_VERSION}:${SL_IR_VERSION}`, of(result)]
    for (const u of uniforms) parts.push(`U:${u.name}:${u.type}:${u.value.map(fixed).join(",")}`)
    for (const t of textures) parts.push(`T:${t.name}:${t.slot}`)
    return fnv1a(parts.join("|"))
}

/** The control fields of `c` that are set, copied, in `CONTROL_FIELDS` order. */
export function controlOf(c: UniformControl): UniformControl {
    const out: UniformControl = {}
    if (c.range !== undefined) out.range = c.range.step === undefined ? { min: c.range.min, max: c.range.max } : { ...c.range }
    if (c.toggle === true) out.toggle = true
    if (c.options !== undefined) out.options = c.options.slice()
    if (c.header !== undefined) out.header = c.header
    if (c.label !== undefined) out.label = c.label
    if (c.hide === true) out.hide = true
    return out
}

/** Bumped when the hashing scheme changes, which invalidates generated shaders. */
export const SL_HASH_VERSION = 1

/**
 * Bumped whenever the IR changes in a way a reader has to know about: a new
 * opcode, a new shape, a change to what an existing opcode's operands or
 * result mean, or a change to the JSON shape (which also gets a migration in
 * `fromJSON`).
 *
 * NOT bumped for a change to the helper library (`lib/*.hlsl`) that keeps the
 * IR's shape, such as 0.1.11's value noise hash. Hosts include the library's
 * text when they compile and do not cache its output by hash: OneJS's
 * generated shaders include `SLCommon.cginc`, which recompiles, and Magerie
 * keys its compiled pipelines by source text. A bump would change every hash,
 * which strands every recorded program in a player built before the editor
 * records it again, for no gain.
 *
 * A reader accepts every version up to its own and refuses a newer one with a
 * message naming both, the rule the particle wire and fx follow. Part of the
 * hash, so a bump recompiles every cached shader.
 *
 *   1  the first versioned IR
 *   2  an SDF call carries up to six shape parameters, not four (#129)
 */
export const SL_IR_VERSION = 2

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
