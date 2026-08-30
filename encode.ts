/**
 * Turns a recorded program into the buffer the VM shader evaluates.
 *
 * Phase 2 of `Specs/SHADER_LANG.md`, and the first consumer of the Phase 1 IR.
 * Three passes, all here, all pure TypeScript:
 *
 *   1. reachable  drop anything the result does not depend on
 *   2. live ranges  the last instruction that reads each value
 *   3. linear scan  assign a register, free it when its range ends
 *
 * WHY EIGHT REGISTERS. Phase 0 measured a dynamically indexed register file in a
 * fragment shader on three stacks. On ANGLE D3D11 and on NVIDIA's GL driver,
 * shrinking the file from 16 entries to 8 costs 3.0x to 4.0x less, which is what
 * a spill to per thread local memory looks like. Eight is not a guess, it is the
 * number the hardware asked for.
 *
 * WHY AN INDEXED STORE AND NOT AN UNROLLED CHAIN. At 8 registers the two Windows
 * backends want opposite things: D3D11 is 1.38x to 1.44x FASTER with the indexed
 * store, GL is about 0.84x faster with the unrolled chain, and both reach the
 * same best case on their preferred one. Branching on the renderer would take
 * the best of both and ship a code path that can only ever be tested on one of
 * the two machines that disagree. One shape everywhere has the better worst
 * case, 0.199 against 0.237, and no untestable branch.
 */

import {
    MAX_TEXTURES, SLError, type NodeRef, type Program, type SLNode, type SLType,
} from "./ir"
import { SLOP } from "./ops"

/**
 * Registers in the VM's file. Phase 0's answer, not a preference.
 *
 * A program that needs more is refused rather than spilled. A spill slot is a
 * second dynamic index into a second array, and any program that needs one is
 * already past the budget this design is honest about.
 */
export const REGISTERS = 8

/** Instructions in one program. The VM's loop is bounded and must be. */
export const MAX_INSTRUCTIONS = 256

/**
 * Two texels per instruction, fixed width, so instruction `i` sits at texels
 * `2i` and `2i+1` and the shader needs no cursor to advance.
 *
 * Fixed width wastes a texel on instructions with no immediate. That is the
 * right trade: variable width means decoding a length and advancing a cursor,
 * which is a dependent read per instruction and defeats the point of storing the
 * program in a texture at all.
 *
 *   texel 2i     [ op, dst, a, b ]
 *   texel 2i+1   depends on the op:
 *                  SWIZZLE   [ c0, c1, c2, c3 ], unused channels are -1
 *                  COMPOSE   [ c, d, argCount, 0 ], the third and fourth args
 *                  SAMPLE    [ slot, 0, 0, 0 ]
 *                  FBM       [ octaves, 0, 0, 0 ]
 *                  CONST     [ x, y, z, w ]
 *                  otherwise unused, and zero
 *
 * Every value is a float. Integers ride in floats exactly up to 2^24, which is
 * far above any field here, and the encoder asserts each one is in range rather
 * than trusting it.
 */
export const TEXELS_PER_INSTRUCTION = 2

export interface Encoded {
    /** Flat RGBA float data, `TEXELS_PER_INSTRUCTION * 4` numbers per instruction. */
    data: Float32Array
    instructions: number
    /** Register holding the result when the program halts. */
    resultRegister: number
    /** Registers actually used, for the shader to size nothing and for reporting. */
    registersUsed: number
    hash: string
}

interface Instr {
    op: number
    dst: number
    a: number
    b: number
    imm: [number, number, number, number]
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
 * The last position in `order` that reads each node.
 *
 * A register is free the instant its value's last reader has run, which is what
 * lets an eight entry file hold a program with far more than eight values in it.
 */
export function liveRanges(nodes: SLNode[], order: NodeRef[], result: NodeRef): Map<NodeRef, number> {
    const pos = new Map<NodeRef, number>()
    order.forEach((ref, i) => pos.set(ref, i))
    const last = new Map<NodeRef, number>()
    order.forEach((ref, i) => {
        const n = nodes[ref]
        const reads: NodeRef[] = n.k === "swizzle" ? [n.src] : n.k === "call" ? n.args : []
        for (const r of reads) last.set(r, i)
    })
    // The result outlives every instruction, or it could be freed and overwritten
    // before anybody reads it.
    last.set(result, order.length)
    for (const ref of order) if (!last.has(ref)) last.set(ref, pos.get(ref)!)
    return last
}

export function encode(program: Program): Encoded {
    const order = reachable(program.nodes, program.result)
    if (order.length > MAX_INSTRUCTIONS) {
        throw new SLError(
            `this program is ${order.length} operations and the VM runs at most ${MAX_INSTRUCTIONS}. ` +
            `The loop in the shader is bounded and has to be.`,
        )
    }
    for (const t of program.textures) {
        if (t.slot >= MAX_TEXTURES) throw new SLError(`texture "${t.name}" is past the sampler budget`)
    }

    const last = liveRanges(program.nodes, order, program.result)
    const reg = new Map<NodeRef, number>()
    const free: number[] = []
    for (let r = REGISTERS - 1; r >= 0; r--) free.push(r)
    /** Which node currently owns each register, for freeing. */
    const owner = new Array<NodeRef | null>(REGISTERS).fill(null)

    const out: Instr[] = []
    let peak = 0

    order.forEach((ref, i) => {
        // Free first, so a value whose last reader is THIS instruction can hand
        // its register straight to this instruction's result. Without that an
        // eight register file would behave like a seven register one on every
        // chained expression, which is most of them.
        for (let r = 0; r < REGISTERS; r++) {
            const o = owner[r]
            if (o !== null && last.get(o)! < i) { owner[r] = null; free.push(r) }
        }

        const n = program.nodes[ref]
        const reads: NodeRef[] = n.k === "swizzle" ? [n.src] : n.k === "call" ? n.args : []
        const args = reads.map((r) => {
            const rr = reg.get(r)
            if (rr === undefined) throw new SLError(`internal: node ${r} has no register when ${ref} needs it`)
            return rr
        })

        // Operands are read before the destination is written, so a register
        // whose last use is this instruction can also be the destination.
        for (let r = 0; r < REGISTERS; r++) {
            const o = owner[r]
            if (o !== null && last.get(o)! === i && !reg.has(ref)) {
                // Only reclaim a register this instruction is actually reading;
                // anything else is still live for a later instruction.
                if (args.includes(r)) { owner[r] = null; free.push(r) }
            }
        }

        const dst = free.pop()
        if (dst === undefined) {
            throw new SLError(
                `this program needs more than ${REGISTERS} registers at once. The VM has ${REGISTERS} ` +
                `because that is what the hardware measured fastest, and spilling is deliberately not ` +
                `implemented: a spill slot is a second dynamic index into a second array. Split the ` +
                `program, or reuse fewer intermediate values at the same time.`,
            )
        }
        owner[dst] = ref
        reg.set(ref, dst)
        peak = Math.max(peak, REGISTERS - free.length)
        out.push(emit(n, dst, args))
    })

    const data = new Float32Array(out.length * TEXELS_PER_INSTRUCTION * 4)
    out.forEach((ins, i) => {
        const o = i * 8
        data[o] = ins.op; data[o + 1] = ins.dst; data[o + 2] = ins.a; data[o + 3] = ins.b
        data[o + 4] = ins.imm[0]; data[o + 5] = ins.imm[1]
        data[o + 6] = ins.imm[2]; data[o + 7] = ins.imm[3]
    })

    return {
        data,
        instructions: out.length,
        resultRegister: reg.get(program.result)!,
        registersUsed: peak,
        hash: program.hash,
    }
}

const NONE: [number, number, number, number] = [0, 0, 0, 0]

function emit(n: SLNode, dst: number, args: number[]): Instr {
    switch (n.k) {
        case "const": {
            const v = n.v
            return { op: SLOP.CONST, dst, a: 0, b: n.type, imm: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0] }
        }
        case "input":
            return { op: SLOP.INPUT, dst, a: INPUT_ID[n.name], b: n.type, imm: [...NONE] }
        case "uniform":
            return { op: SLOP.UNIFORM, dst, a: n.slot, b: n.type, imm: [...NONE] }
        case "swizzle": {
            const c = n.chans
            return {
                op: SLOP.SWIZZLE, dst, a: args[0], b: n.type,
                imm: [c[0] ?? -1, c[1] ?? -1, c[2] ?? -1, c[3] ?? -1],
            }
        }
        case "call": {
            if (n.op === SLOP.COMPOSE) {
                if (args.length > 4) throw new SLError(`compose takes at most 4 parts, got ${args.length}`)
                return {
                    op: SLOP.COMPOSE, dst, a: args[0] ?? 0, b: args[1] ?? 0,
                    imm: [args[2] ?? 0, args[3] ?? 0, args.length, n.type],
                }
            }
            if (args.length > 3) {
                throw new SLError(`internal: ${n.op} has ${args.length} operands and the encoding holds 3`)
            }
            // A third operand rides in the immediate, which is free for every op
            // that has one (clamp, mix, smoothstep, select) because none of them
            // carries a literal.
            const imm: [number, number, number, number] = n.imm !== undefined
                ? [n.imm[0] ?? 0, n.imm[1] ?? 0, n.imm[2] ?? 0, n.imm[3] ?? 0]
                : [args[2] ?? 0, 0, 0, 0]
            return { op: n.op, dst, a: args[0] ?? 0, b: args[1] ?? 0, imm }
        }
    }
}

/** Input ids, fixed here because the shader switches on them. */
export const INPUT_ID: Record<string, number> = {
    uv: 0, fragCoord: 1, resolution: 2, time: 3, aspect: 4,
}

/**
 * Every field must survive a float32 round trip exactly, or an instruction
 * decodes as a different instruction. Cheap to check and impossible to debug
 * from the wrong picture it would otherwise produce.
 */
export function checkEncodable(v: number, what: string): void {
    if (!Number.isFinite(v)) throw new SLError(`${what} is ${v}, which cannot be encoded`)
    if (Number.isInteger(v) && Math.abs(v) > 0x1000000) {
        throw new SLError(`${what} is ${v}, past the 2^24 an integer survives in a float`)
    }
}
