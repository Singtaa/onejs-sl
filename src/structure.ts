/**
 * Where each node of a program is computed: the region tree an emitter prints.
 *
 * The IR is a graph, and an `if` or a `loop` (IR 4) is a node whose regions are
 * the parts of the graph it runs (`ir.ts`, `ControlNode`). A node belongs to no
 * region by itself; this places it in the innermost one that every use of it is
 * inside. So a value only a branch needs is computed only when that branch
 * runs, one a loop's body needs is computed each turn, and one that is also
 * needed outside is computed once, before either. Nothing is hoisted out of the
 * region it is used in, which is what an author who wrote it there expects.
 *
 * It also says which regions run in control flow that differs from one pixel
 * to the next. A texture sample there has no neighbours to take its mip level
 * from (WGSL refuses one outright), so every emitter samples at level 0 in such
 * a region, and every backend draws the same picture.
 */

import { INPUTS, operands, reachable, type NodeRef, type Program, type SLNode } from "./ir"
import { isSampling } from "./ops"

export interface Region {
    id: number
    /** The region this one is inside; null for the root, the whole function. */
    parent: number | null
    /** The `if` or `loop` whose region this is; null for the root. */
    owner: NodeRef | null
    role: "root" | "then" | "else" | "cond" | "body"
    depth: number
    /** Runs in control flow that differs between pixels. */
    varying: boolean
    /**
     * The nodes placed here, each after what it reads: depth first from the
     * result, operands in order, which is the order a program with no control
     * flow has always been printed in.
     */
    nodes: NodeRef[]
}

export interface Structure {
    regions: Region[]
    /** The region each reachable node is placed in. */
    placed: Map<NodeRef, number>
    /** An `if`'s then and else regions; a `loop`'s cond and body regions (the body inside the cond). */
    children: Map<NodeRef, [number, number]>
    /** The values that can differ from one pixel to the next. */
    varying: Set<NodeRef>
}

/** Inputs that differ per pixel. The others are one value for the whole draw. */
const PER_PIXEL = new Set<string>(["uv", "fragCoord"] satisfies Array<keyof typeof INPUTS>)

export function structure(p: Program): Structure {
    const nodes = p.nodes
    const reach = reachable(nodes, p.result)
    const regions: Region[] = []
    const placed = new Map<NodeRef, number>()
    const children = new Map<NodeRef, [number, number]>()
    const uses = new Map<NodeRef, number[]>()

    const region = (parent: number | null, owner: NodeRef | null, role: Region["role"]): number => {
        const id = regions.length
        regions.push({ id, parent, owner, role, depth: parent === null ? 0 : regions[parent]!.depth + 1, varying: false, nodes: [] })
        return id
    }
    const use = (ref: NodeRef, at: number) => {
        const list = uses.get(ref)
        if (list === undefined) uses.set(ref, [at])
        else list.push(at)
    }
    const lca = (a: number, b: number): number => {
        let x = a, y = b
        while (regions[x]!.depth > regions[y]!.depth) x = regions[x]!.parent!
        while (regions[y]!.depth > regions[x]!.depth) y = regions[y]!.parent!
        while (x !== y) { x = regions[x]!.parent!; y = regions[y]!.parent! }
        return x
    }
    const inside = (inner: number, outer: number): boolean => {
        let r: number | null = inner
        while (r !== null) { if (r === outer) return true; r = regions[r]!.parent }
        return false
    }

    const root = region(null, null, "root")
    use(p.result, root)
    const loopRegion = new Map<number, number>()

    // Latest first: every use of a node is a later node, so it is placed by then.
    for (let i = reach.length - 1; i >= 0; i--) {
        const ref = reach[i]!
        const n = nodes[ref]!
        let at: number
        if (n.k === "param") {
            const cond = loopRegion.get(n.loop)
            if (cond === undefined) throw new Error(`node ${ref} is a param of loop ${n.loop}, which nothing reaches`)
            at = cond
            for (const u of uses.get(ref) ?? []) {
                if (!inside(u, cond)) throw new Error(`node ${ref}, a param of loop ${n.loop}, is read outside that loop`)
            }
        } else {
            const list = uses.get(ref)
            if (list === undefined) throw new Error(`node ${ref} is reachable and has no use`)
            at = list.reduce(lca)
        }
        placed.set(ref, at)
        regions[at]!.nodes.push(ref)
        if (n.k === "if") {
            const then = region(at, ref, "then")
            const otherwise = region(at, ref, "else")
            children.set(ref, [then, otherwise])
            use(n.cond, at)
            for (const r of n.then) use(r, then)
            for (const r of n.else) use(r, otherwise)
        } else if (n.k === "loop") {
            const cond = region(at, ref, "cond")
            const body = region(cond, ref, "body")
            children.set(ref, [cond, body])
            loopRegion.set(n.id, cond)
            for (const r of n.init) use(r, at)
            use(n.cond, cond)
            for (const r of n.next) use(r, body)
        } else {
            for (const a of operands(n)) use(a, at)
        }
    }
    const order = postOrder(nodes, p.result)
    for (const r of regions) r.nodes.sort((x, y) => order.get(x)! - order.get(y)!)

    const varying = varyingValues(nodes, reach)
    // A region varies if the one it is in does, or if its own condition does.
    for (const r of regions) {
        if (r.parent === null) continue
        const owner = nodes[r.owner!]!
        const cond = owner.k === "if" || owner.k === "loop" ? owner.cond : -1
        r.varying = regions[r.parent]!.varying || varying.has(cond)
    }
    return { regions, placed, children, varying }
}

/** Each reachable node's place in a depth first walk from the result, operands in order, each after its operands. */
function postOrder(nodes: readonly SLNode[], result: NodeRef): Map<NodeRef, number> {
    const order = new Map<NodeRef, number>()
    let next = 0
    const walk = (ref: NodeRef): void => {
        if (order.has(ref)) return
        order.set(ref, -1)
        for (const a of operands(nodes[ref]!)) walk(a)
        order.set(ref, next++)
    }
    walk(result)
    return order
}

/**
 * The values that can differ between pixels: the per pixel inputs, texture
 * samples, and anything computed from one. A loop's params differ when their
 * start, their next value or the loop's condition does, which depends on the
 * params, so it is found by going round until nothing changes.
 */
function varyingValues(nodes: readonly SLNode[], reach: NodeRef[]): Set<NodeRef> {
    const out = new Set<NodeRef>()
    const params = new Map<number, NodeRef[]>()
    for (const ref of reach) {
        const n = nodes[ref]!
        if (n.k === "param") params.set(n.loop, [...(params.get(n.loop) ?? []), ref])
    }
    for (let changed = true; changed;) {
        changed = false
        const mark = (ref: NodeRef) => { if (!out.has(ref)) { out.add(ref); changed = true } }
        for (const ref of reach) {
            const n = nodes[ref]!
            switch (n.k) {
                case "input": if (PER_PIXEL.has(n.name)) mark(ref); break
                case "call":
                    if (isSampling(n.op) || n.args.some((a) => out.has(a))) mark(ref)
                    break
                case "swizzle": if (out.has(n.src)) mark(ref); break
                case "proj": {
                    const src = nodes[n.src]!
                    if (src.k === "if" && (out.has(src.cond) || out.has(src.then[n.index]!) || out.has(src.else[n.index]!))) mark(ref)
                    if (src.k === "loop") {
                        const param = (params.get(src.id) ?? []).find((q) => (nodes[q] as { index: number }).index === n.index)
                        if (out.has(src.cond) || out.has(src.init[n.index]!) || out.has(src.next[n.index]!) || (param !== undefined && out.has(param))) mark(ref)
                    }
                    break
                }
                case "loop":
                    for (const q of params.get(n.id) ?? []) {
                        const i = (nodes[q] as { index: number }).index
                        if (out.has(n.cond) || out.has(n.init[i]!) || out.has(n.next[i]!)) mark(q)
                    }
                    break
                default: break
            }
        }
    }
    return out
}

/**
 * How a language spells the statements a structured body is printed with. The
 * expressions are the emitter's own; this is only the frame around them.
 */
export interface Syntax {
    /** A value node's local, initialised: `float n3 = expr;` */
    value(ref: NodeRef, expr: string): string
    /** A local that is assigned later, typed as `like` is: an if's or a loop's result. */
    mutable(name: string, like: NodeRef, init?: string): string
    /** A loop's turn counter, from 0. */
    counter(name: string): string
    assign(name: string, value: string): string
    increment(name: string): string
    ifOpen(cond: string): string
    elseOpen: string
    close: string
    loopOpen: string
    /** Leaves the loop unless `cond` holds and `turns` is under `max`. */
    breakUnless(cond: string, turns: string, max: number): string
}

/** A node's local. */
export const local = (ref: NodeRef): string => `n${ref}`

/**
 * Prints the body: every placed node in its region, each `if` and `loop` with
 * its regions inside it. `expr` prints a value node's expression; the result is
 * `local(p.result)` for the caller to return.
 */
export function printBody(p: Program, s: Structure, syntax: Syntax, expr: (ref: NodeRef) => string, indent: string): string[] {
    const lines: string[] = []
    const loopRef = new Map<number, NodeRef>()
    for (const [ref, n] of p.nodes.entries()) if (n.k === "loop") loopRef.set(n.id, ref)
    const result = (ref: NodeRef, i: number) => `r${ref}_${i}`
    const carried = (ref: NodeRef, i: number) => `l${ref}_${i}`

    const region = (id: number, ind: string): void => {
        for (const ref of s.regions[id]!.nodes) {
            const n = p.nodes[ref]!
            switch (n.k) {
                case "if": {
                    const [then, otherwise] = s.children.get(ref)!
                    n.then.forEach((r, i) => lines.push(ind + syntax.mutable(result(ref, i), r)))
                    lines.push(ind + syntax.ifOpen(local(n.cond)))
                    region(then, ind + "    ")
                    n.then.forEach((r, i) => lines.push(ind + "    " + syntax.assign(result(ref, i), local(r))))
                    lines.push(ind + syntax.elseOpen)
                    region(otherwise, ind + "    ")
                    n.else.forEach((r, i) => lines.push(ind + "    " + syntax.assign(result(ref, i), local(r))))
                    lines.push(ind + syntax.close)
                    break
                }
                case "loop": {
                    const [cond, body] = s.children.get(ref)!
                    const turns = `l${ref}_turns`
                    n.init.forEach((r, i) => lines.push(ind + syntax.mutable(carried(ref, i), r, local(r))))
                    lines.push(ind + syntax.counter(turns))
                    lines.push(ind + syntax.loopOpen)
                    region(cond, ind + "    ")
                    lines.push(ind + "    " + syntax.breakUnless(local(n.cond), turns, n.max))
                    lines.push(ind + "    " + syntax.increment(turns))
                    region(body, ind + "    ")
                    n.next.forEach((r, i) => lines.push(ind + "    " + syntax.assign(carried(ref, i), local(r))))
                    lines.push(ind + syntax.close)
                    break
                }
                case "param":
                    lines.push(ind + syntax.value(ref, carried(loopRef.get(n.loop)!, n.index)))
                    break
                case "proj": {
                    const src = p.nodes[n.src]!
                    lines.push(ind + syntax.value(ref, src.k === "loop" ? carried(n.src, n.index) : result(n.src, n.index)))
                    break
                }
                default:
                    lines.push(ind + syntax.value(ref, expr(ref)))
            }
        }
    }
    region(0, indent)
    return lines
}

/** Whether a node is computed where a sample has no neighbours to take a mip level from. */
export function inVaryingFlow(s: Structure, ref: NodeRef): boolean {
    return s.regions[s.placed.get(ref)!]!.varying
}
