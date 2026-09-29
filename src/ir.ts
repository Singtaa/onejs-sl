/**
 * The shader language IR: one graph, and every backend a function of it.
 *
 * Phase 1 of `Specs/SHADER_LANG.md` section 4. Every emitter (HLSL, WGSL, GLSL
 * ES) reads this shape and nothing else.
 *
 * Four properties are load bearing:
 *
 * **Every node carries its type.** Both backends need it and computing it twice
 * is how they would disagree. It is inferred while recording, which is also what
 * produces the author facing type errors.
 *
 * **Nodes are a flat array in topological order.** A node refers to earlier
 * nodes by index only, never forwards, so an emitter can walk the array once and
 * emit in order. The hash deliberately does NOT depend on that order; see
 * `hashProgram`.
 *
 * **The graph is a DAG, not a tree.** `const p = ...` used twice is one node
 * with two references, enforced here by hash consing rather than left to a later
 * pass. A tree would silently square the cost of the most natural way to write a
 * shader.
 *
 * **Nothing here knows about shaders.** No HLSL, no texture layout, no binding. Those belong to the backends; this file is the contract between
 * them, and it is fully testable with no GPU.
 */

import { SLOP, SL_ARITY, SL_NAME, TEXTURE_SLOTS, UNIFORM_SLOTS, type SLOpCode } from "./ops"

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
 * operation, no host change, and a program that never names one holds
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

/**
 * What a value holds, beside its width. A node without one holds floats, which
 * is every node before IR 4, so a program of floats is the graph and the hash
 * it always was.
 */
export type SLKind = "int" | "uint" | "bool"

/**
 * A node that is a value. `param` is a loop's carried value at the top of an
 * iteration, `proj` one result of an `if` or a `loop`.
 */
export type ValueNode =
    | { k: "const"; type: SLType; kind?: SLKind; v: number[] }
    | { k: "input"; type: SLType; kind?: undefined; name: InputName }
    | { k: "uniform"; type: SLType; kind?: undefined; slot: number }
    | { k: "swizzle"; type: SLType; kind?: SLKind; src: NodeRef; chans: number[] }
    | { k: "call"; type: SLType; kind?: SLKind; op: SLOpCode; args: NodeRef[]; imm?: number[] }
    | { k: "param"; type: SLType; kind?: SLKind; loop: number; index: number }
    | { k: "proj"; type: SLType; kind?: SLKind; src: NodeRef; index: number }

/**
 * Structured control flow (IR 4), as regions of the one graph rather than as
 * statements: the graph stays a pure DAG, hash consed and hashed as before, and
 * an emitter places each node in the innermost region that uses it
 * (`structure.ts`), which is what makes a branch skip what only it needs.
 *
 *   if    `then` or `else` are the results, per the bool `cond`; its `proj`s read them
 *   loop  the `param`s of loop `id` start as `init`; while `cond` holds and fewer
 *         than `max` turns have run, they become `next`. Its `proj`s are the params
 *         when it stops. `cond` and `next` are computed from the params.
 */
export type ControlNode =
    | { k: "if"; cond: NodeRef; then: NodeRef[]; else: NodeRef[] }
    | { k: "loop"; id: number; init: NodeRef[]; cond: NodeRef; next: NodeRef[]; max: number }

export type SLNode = ValueNode | ControlNode

/**
 * A float to an int or a uint as the GPU converts one: as a 32 bit float,
 * held to the widest such float the kind can hold, then truncated toward zero.
 * The emitters clamp to these bounds, so a folded conversion
 * and a computed one agree.
 */
export function truncateHeld(v: number, kind: "int" | "uint"): number {
    const [lo, hi] = INT_BOUNDS[kind]
    return Math.trunc(Math.min(hi, Math.max(lo, Math.fround(v))))
}

/** The widest 32 bit floats an int and a uint hold, which a conversion clamps to first. */
export const INT_BOUNDS = { int: [-2147483648, 2147483520], uint: [0, 4294967040] } as const

/** The value node at `ref`. A control node is only ever read through its projs. */
export function valueAt(nodes: readonly SLNode[], ref: NodeRef): ValueNode {
    const n = nodes[ref]
    if (n === undefined || n.k === "if" || n.k === "loop") throw new SLError(`node ${ref} is not a value`)
    return n
}

/** The refs a node reads, in order. */
export function operands(n: SLNode): NodeRef[] {
    switch (n.k) {
        case "swizzle": return [n.src]
        case "call": return n.args
        case "proj": return [n.src]
        case "if": return [n.cond, ...n.then, ...n.else]
        case "loop": return [...n.init, n.cond, ...n.next]
        default: return []
    }
}

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

export interface Program {
    /**
     * The `SL_IR_VERSION` this program's nodes mean what they mean under: the
     * lowest one that has every node it holds. See `programVersion`.
     */
    version: number
    nodes: SLNode[]
    /** Must be VEC4: a program produces a colour. */
    result: NodeRef
    uniforms: UniformDecl[]
    textures: TextureDecl[]
    /** Canonical, stable across machines. See `hashProgram`. */
    hash: string
}

/**
 * The refusals for a program past its caps, worded once for the parser (a
 * `file`) and the builder (a `program`) so the two cannot drift apart.
 */
export function tooManyUniforms(declared: number, source: "file" | "program"): string {
    return `this ${source} declares ${declared} uniforms and a program may hold ${UNIFORM_SLOTS}. ` +
        `OneJS keeps a program's uniforms in ${UNIFORM_SLOTS} slots, so this one would have no ` +
        `slot of its own; it is refused here rather than drawn wrong. Pack related values into ` +
        `a ${source === "file" ? "float4" : "vec4"}.`
}

export function tooManyTextures(declared: number, source: "file" | "program"): string {
    return `this ${source} declares ${declared} textures and a program may sample ${TEXTURE_SLOTS}. ` +
        `OneJS binds ${TEXTURE_SLOTS} textures to a program in the editor and a native player, so ` +
        `this one would sample nothing there while a browser drew it: two pictures from one ${source}.`
}

/**
 * Refuses a finished program past either cap. The parser and the builder
 * refuse at the declaration, where the message can point at it; this is for
 * a program that arrived some other way, stored as JSON or put together by
 * hand, and `compile` runs it so nothing reaches a host around it.
 */
export function checkCaps(p: Pick<Program, "uniforms" | "textures">): void {
    if (p.uniforms.length > UNIFORM_SLOTS) throw new SLError(tooManyUniforms(p.uniforms.length, "program"))
    if (p.textures.length > TEXTURE_SLOTS) throw new SLError(tooManyTextures(p.textures.length, "program"))
}

/**
 * The colour as written behind a colour value: the operand of the `TO_LINEAR`
 * that reading a hex or a colour uniform applied, or null for a value computed
 * in the working space. What a ramp's stop has to be, since a ramp blends its
 * stops as written (`sl.ramp`).
 */
export function writtenColour(nodes: readonly SLNode[], ref: NodeRef): NodeRef | null {
    const n = nodes[ref]!
    if (n.k !== "call" || n.op !== SLOP.TO_LINEAR || (n.type !== TYPE.VEC3 && n.type !== TYPE.VEC4)) return null
    return n.args[0]!
}

/** Why a computed value is not a ramp's stop, in one wording for both surfaces. */
export const RAMP_STOP_COMPUTED =
    "a ramp's stop is a colour as written: a hex like #ff8040, or a uniform or const that holds one. " +
    "This one is computed, and a ramp blends its stops as written before it converts them, so it has " +
    "no written colour to blend. Blend computed colours with lerp instead"

/** Operations a single program may hold. Generous: a guard against a runaway builder, not a budget. */
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

    /** The next loop's id: unique within the program, so two loops' params never intern to one node. */
    private loops = 0
    newLoop(): number { return this.loops++ }

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

    call(op: SLOpCode, type: SLType, args: NodeRef[], imm?: number[], kind?: SLKind): NodeRef {
        const arity = SL_ARITY[op]
        if (arity >= 0 && args.length !== arity) {
            throw new SLError(`${SL_NAME[op]} takes ${arity} argument(s), got ${args.length}`)
        }
        for (const a of args) {
            if (a < 0 || a >= this.nodes.length) {
                throw new SLError(`${SL_NAME[op]} refers to a node that does not exist yet`)
            }
        }
        const node: SLNode = imm === undefined ? { k: "call", type, op, args } : { k: "call", type, op, args, imm }
        if (kind !== undefined) node.kind = kind
        return this.add(node)
    }

    constant(v: number[], kind?: SLKind): NodeRef {
        for (const n of v) {
            if (!Number.isFinite(n)) throw new SLError(`a constant must be finite, got ${n}`)
            if (kind !== undefined && !Number.isInteger(n)) throw new SLError(`an ${kind} constant must be a whole number, got ${n}`)
        }
        const node: SLNode = { k: "const", type: v.length as SLType, v: v.slice() }
        if (kind !== undefined) node.kind = kind
        return this.add(node)
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
        if (slot >= UNIFORM_SLOTS) throw new SLError(tooManyUniforms(slot + 1, "program"))
        const decl: UniformDecl = { name, type, value: value.slice() }
        if (colour) decl.colour = true
        Object.assign(decl, controlOf(control))
        this.uniforms.push(decl)
        return this.add({ k: "uniform", type, slot })
    }

    texture(name: string): number {
        const existing = this.textures.findIndex((t) => t.name === name)
        if (existing >= 0) return this.textures[existing].slot
        if (this.textures.length >= TEXTURE_SLOTS) {
            throw new SLError(tooManyTextures(this.textures.length + 1, "program"))
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
        for (const a of operands(nodes[ref]!)) stack.push(a)
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
    const kind = "kind" in n && n.kind !== undefined ? `@${n.kind}` : ""
    switch (n.k) {
        case "const": return `c:${n.type}:${n.v.map((v) => constText(v, n.kind)).join(",")}${kind}`
        case "input": return `i:${n.name}`
        case "uniform": return `u:${n.slot}`
        case "swizzle": return `s:${n.src}:${n.chans.join("")}${kind}`
        case "call": return `f:${n.op}:${n.args.join(",")}:${(n.imm ?? []).map(fixed).join(",")}${kind}`
        case "param": return `p:${n.loop}:${n.index}`
        case "proj": return `j:${n.src}:${n.index}`
        case "if": return `?:${n.cond}:${n.then.join(",")}:${n.else.join(",")}`
        case "loop": return `L:${n.max}:${n.init.join(",")}:${n.cond}:${n.next.join(",")}`
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

/** A constant's value as keyed and hashed: a float at `fixed`'s precision, an int, a uint or a bool exactly. */
function constText(n: number, kind: SLKind | undefined): string {
    return kind === undefined ? fixed(n) : String(n)
}

export function widthName(t: SLType): string {
    return t === 1 ? "float" : `vec${t}`
}

/**
 * A canonical, machine independent hash of a program.
 *
 * This is the link between a program and its compiled shader. If it differs
 * between the machine that generated the shader and the machine that runs it,
 * a native player finds no shader for the program and draws nothing.
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
    //
    // NORMALISED, so two ways of writing one computation agree (hash version 2).
    // A commutative op's operands are digested in sorted order, so `a + b` is
    // `b + a`; and a swizzle of a constant is digested as the constant it picks,
    // so `8 * uv` (8 broadcast by a swizzle) is `uv * 8` (a float2 constant).
    // Only where every backend computes the same bits either way: min and max
    // are left out, since which of -0 and +0 they return depends on the order.
    const digest = new Map<NodeRef, string>()
    const depth = loopDepths(nodes, result)

    const of = (ref: NodeRef): string => {
        const seen = digest.get(ref)
        if (seen !== undefined) return seen
        const n = nodes[ref]!
        let body: string
        switch (n.k) {
            // Control nodes have no type of their own: their projs carry it.
            case "if": {
                body = `?:${of(n.cond)}:${n.then.map(of).join(",")}:${n.else.map(of).join(",")}`
                const d = fnv1a(body)
                digest.set(ref, d)
                return d
            }
            case "loop": {
                body = `L:${n.max}:${n.init.map(of).join(",")}:${of(n.cond)}:${n.next.map(of).join(",")}`
                const d = fnv1a(body)
                digest.set(ref, d)
                return d
            }
            // By nesting depth, not by id: two programs that nest the same
            // loops the same way agree however their ids were handed out, and
            // two loops nested in one another never share a digest for a param.
            case "param": body = `p:${depth.get(n.loop) ?? 1}:${n.index}`; break
            case "proj": body = `j:${of(n.src)}:${n.index}`; break
            case "const": body = `c:${n.type}:${n.v.map((v) => constText(v, n.kind)).join(",")}`; break
            case "input": body = `i:${n.name}`; break
            // By slot rather than by name: the slot is what the generated shader
            // lays out, so two programs whose uniforms differ only in name still
            // produce different shaders and must not share a hash. The names go
            // in separately below.
            case "uniform": body = `u:${n.slot}:${n.type}`; break
            case "swizzle": {
                const src = nodes[n.src]!
                body = src.k === "const" && src.kind === n.kind
                    ? `c:${n.type}:${n.chans.map((c) => constText(src.v[c]!, src.kind)).join(",")}`
                    : `s:${of(n.src)}:${n.chans.join("")}`
                break
            }
            case "call": {
                const args = n.args.map(of)
                if (COMMUTATIVE.has(n.op)) args.sort()
                body = `f:${n.op}:${args.join(",")}:${(n.imm ?? []).map(fixed).join(",")}`
                break
            }
        }
        const d = fnv1a(body + "|" + n.type + (n.kind === undefined ? "" : n.kind))
        digest.set(ref, d)
        return d
    }

    // The IR version is in the hash, so a change to what an opcode means in the
    // IR changes the hash of every program using it, and every cache keyed by
    // one recompiles rather than serving the old maths. It is the PROGRAM's
    // version, the lowest that has its nodes, so a version that adds a node
    // leaves every program without one on the hash it had. A change to the
    // helper library alone (a noise's arithmetic, say) is not one: every host
    // includes the library's text when it compiles, and none caches a compiled
    // program by hash across a library update, so the new text reaches every
    // shader without a bump.
    const parts: string[] = [`v${SL_HASH_VERSION}:${programVersion(nodes, result)}`, of(result)]
    for (const u of uniforms) parts.push(`U:${u.name}:${u.type}:${u.value.map(fixed).join(",")}`)
    for (const t of textures) parts.push(`T:${t.name}:${t.slot}`)
    return fnv1a(parts.join("|"))
}

/**
 * Each reachable loop's nesting depth, 1 for a loop inside no other: 1 more than
 * the deepest loop whose params it reads. Read from the graph, so it does not
 * depend on the order anything was built or walked in.
 */
function loopDepths(nodes: readonly SLNode[], result: NodeRef): Map<number, number> {
    const free = new Map<NodeRef, Set<number>>()
    const loops = new Map<number, Extract<SLNode, { k: "loop" }>>()
    const freeOf = (ref: NodeRef): Set<number> => free.get(ref) ?? new Set()
    for (const ref of reachable(nodes as SLNode[], result)) {
        const n = nodes[ref]!
        const out = new Set<number>()
        if (n.k === "param") out.add(n.loop)
        for (const a of operands(n)) for (const l of freeOf(a)) out.add(l)
        if (n.k === "loop") { out.delete(n.id); loops.set(n.id, n) }
        free.set(ref, out)
    }
    const loopFree = new Map<number, Set<number>>()
    for (const [ref, n] of nodes.entries()) if (n.k === "loop" && free.has(ref)) loopFree.set(n.id, free.get(ref)!)
    const depth = new Map<number, number>()
    const of = (id: number): number => {
        const seen = depth.get(id)
        if (seen !== undefined) return seen
        let d = 1
        for (const outer of loopFree.get(id) ?? []) d = Math.max(d, of(outer) + 1)
        depth.set(id, d)
        return d
    }
    for (const id of loops.keys()) of(id)
    return depth
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

/**
 * The lowest `SL_IR_VERSION` that has every node here, and never below 2.
 *
 * A version that adds a node, or a form of one, raises only the programs that
 * hold it. Everything else keeps the version, the hash and the JSON it had, so
 * a program recorded before the bump still finds its shader, and a reader that
 * predates the bump still reads it. Every node counts, used or not: the JSON
 * carries them all, and an older reader has to refuse by the version rather
 * than halfway through the nodes.
 *
 * Only the nodes the result reads count: lowering leaves dead nodes behind (an
 * int constant a fold used up, say), and they draw nothing. `toJSON` writes
 * only the live ones, so an older reader never meets a dead newer node.
 */
export function programVersion(nodes: readonly SLNode[], result: NodeRef): number {
    let v = 2
    for (const ref of reachable(nodes as SLNode[], result)) v = Math.max(v, nodeVersion(nodes[ref]!))
    return v
}

/** The ops IR 4 added. */
const IR4_OPS = new Set<number>([
    SLOP.CAST, SLOP.LT, SLOP.LE, SLOP.GT, SLOP.GE, SLOP.EQ, SLOP.NE, SLOP.AND, SLOP.OR, SLOP.NOT,
    SLOP.BIT_AND, SLOP.BIT_OR, SLOP.BIT_XOR, SLOP.BIT_NOT, SLOP.SHL, SLOP.SHR, SLOP.CHOOSE,
])

/** The version that added this node's form. */
function nodeVersion(n: SLNode): number {
    if (n.k === "if" || n.k === "loop" || n.k === "param" || n.k === "proj" || n.kind !== undefined) return 4
    if (n.k !== "call") return 2
    if (IR4_OPS.has(n.op)) return 4
    switch (n.op) {
        case SLOP.SAMPLE_LOD: return 3
        case SLOP.SDF:
        case SLOP.FBM:
        case SLOP.TURBULENCE:
        case SLOP.RIDGED:
            return n.args.length > 1 ? 3 : 2
        default: return 2
    }
}

/**
 * What is wrong with a call's form, for the ops that have more than one, or
 * null. The builder only makes the right ones; this is for a program read from
 * JSON, which an emitter would otherwise print as something else.
 *
 *   SDF  the point, its shape parameters immediates after the shape id; or the
 *        point, a float4 and a float2 holding them, the id the one immediate
 *   FBM, TURBULENCE, RIDGED  the point, the octave count the first immediate
 *        (FBM's kind the second); or the point and the count, FBM's kind the
 *        one immediate
 */
export function formProblem(n: Extract<SLNode, { k: "call" }>, nodes: readonly SLNode[]): string | null {
    const widths = n.args.map((a) => { const v = nodes[a]!; return v.k === "if" || v.k === "loop" ? "control" : v.type }).join(",")
    switch (n.op) {
        case SLOP.SDF:
            if (widths === "2" && (n.imm?.length ?? 0) >= 5) return null
            if (widths === "2,4,2" && n.imm?.length === 1) return null
            return "an sdf takes a float2 and its parameters as immediates, or a float2, a float4 and a float2 and the shape alone"
        case SLOP.FBM:
        case SLOP.TURBULENCE:
        case SLOP.RIDGED: {
            const rest = n.op === SLOP.FBM ? 1 : 0
            if (widths === "2" && n.imm?.length === rest + 1) return null
            if (widths === "2,1" && (n.imm?.length ?? 0) === rest) return null
            return `${SL_NAME[n.op]} takes a float2 and its octave count as an immediate, or a float2 and a float`
        }
        default:
            return null
    }
}

/** The ops whose two operands the hash takes in either order: exact in IEEE arithmetic on every backend. */
const COMMUTATIVE = new Set<number>([SLOP.ADD, SLOP.MUL, SLOP.DOT, SLOP.DISTANCE])

/**
 * Bumped when the hashing scheme changes, which invalidates generated shaders.
 *
 *   1  the Merkle hash over the reachable graph
 *   2  normalised: commutative operands in either order, a swizzle of a constant as the constant
 */
export const SL_HASH_VERSION = 2

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
 * message naming both, the rule the particle wire and fx follow. A program's
 * version is the lowest that has its nodes (`programVersion`), and that is what
 * its hash carries, so a bump rehashes only the programs using what it added.
 *
 *   1  the first versioned IR
 *   2  an SDF call carries up to six shape parameters, not four (#129)
 *   3  SAMPLE_LOD; an SDF's shape parameters and a noise's octave count as operands
 *   4  control flow (if, loop, their params and projs), ints, uints and bools
 */
export const SL_IR_VERSION = 4

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
