/**
 * The authoring surface: a TypeScript EDSL that records a shader graph.
 *
 * Phase 1 of `Specs/SHADER_LANG.md` section 3. Calling a program function does
 * not execute per pixel; it records a DAG once, at module load.
 *
 * Why an EDSL and not a text language: completion on every function, type errors
 * at the call site, jump to definition, rename, and the author's existing editor,
 * all for free. Monaco in the Play editor already has these types. A text syntax
 * remains possible later and costs only a parser, because the parser would emit
 * this same IR.
 *
 * It also gives common subexpression elimination for nothing, which is the most
 * valuable optimisation here: a `const` in the host language IS the shared node.
 *
 *     const plasma = sl.program(({ uv, time }) => {
 *         const p = uv.mul(8).add(time.mul(0.4))
 *         const v = sl.sin(p.x).add(sl.sin(p.y))
 *         return sl.vec4(v.mul(0.5).add(0.5), 0, 0, 1)
 *     })
 *
 * `p` is written once and used twice, so it is one node with two references.
 */

import { parseColor as parseHex } from "./color"
import {
    Builder, INPUTS, RAMP_STOP_COMPUTED, SLError, TYPE, hashProgram, programVersion, truncateHeld, widthName, writtenColour,
    type InputName, type NodeRef, type Program, type SLKind, type SLNode, type SLType, type UniformControl,
} from "./ir"
import { SLOP, SL_HLSL, SL_NAME, type SLOpCode } from "./ops"
import { SL_SDF_PARAMS, SL_SDF_SHAPES, type SlSdfKind } from "./shapes"

// MARK: values

type Swz = "x" | "y" | "z" | "w" | "r" | "g" | "b" | "a"
const CHAN: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }

/** Width of a swizzle string, at the type level, so `swz("wzyx")` is a Vec4. */
type Widen<S extends string> =
    S extends `${Swz}${Swz}${Swz}${Swz}` ? Vec4 :
    S extends `${Swz}${Swz}${Swz}` ? Vec3 :
    S extends `${Swz}${Swz}` ? Vec2 :
    S extends `${Swz}` ? Float : never

/** Anything acceptable where a value is expected. Plain numbers broadcast. */
export type Num = Val | number

/**
 * A recorded value. One runtime class; the four exported types are TypeScript's
 * view of it, which is where mixing a Vec2 with a Vec3 becomes an error at the
 * call site rather than a black rectangle.
 */
// The `interface Val` further down declares the swizzle getters that the PAIRS
// loop installs on this prototype. They exist at runtime, so the merge is the
// point rather than a hazard; see the comment above that loop.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Val {
    /** `kind` is what the value holds beside its width: an int, a uint or a bool. None means floats. */
    constructor(readonly owner: Builder, readonly ref: NodeRef, readonly width: SLType, readonly kind?: SLKind) {}

    // Arithmetic. Mixing a vector with a Float broadcasts, as in HLSL.
    add(o: Num): this { return bin(SLOP.ADD, this, o) as this }
    sub(o: Num): this { return bin(SLOP.SUB, this, o) as this }
    mul(o: Num): this { return bin(SLOP.MUL, this, o) as this }
    div(o: Num): this { return bin(SLOP.DIV, this, o) as this }
    mod(o: Num): this { return bin(SLOP.MOD, this, o) as this }
    pow(o: Num): this { return bin(SLOP.POW, this, o) as this }
    neg(): this { return un(SLOP.NEG, this) as this }
    recip(): this { return un(SLOP.RECIP, this) as this }
    abs(): this { return un(SLOP.ABS, this) as this }
    saturate(): this { return un(SLOP.SATURATE, this) as this }
    fract(): this { return un(SLOP.FRACT, this) as this }
    floor(): this { return un(SLOP.FLOOR, this) as this }
    min(o: Num): this { return bin(SLOP.MIN, this, o) as this }
    max(o: Num): this { return bin(SLOP.MAX, this, o) as this }
    clamp(lo: Num, hi: Num): this {
        if ([this, lo, hi].some((v) => typeof v !== "number" && v.kind !== undefined)) {
            const u = unify([this, lo, hi])
            if (u.kind !== undefined) return mk(u.owner, u.owner.call(SLOP.CLAMP, u.width, u.refs, undefined, u.kind), u.width, u.kind) as this
            return (mk(u.owner, u.refs[0]!, u.width) as Val).clamp(mk(u.owner, u.refs[1]!, u.width) as Val, mk(u.owner, u.refs[2]!, u.width) as Val) as this
        }
        const { refs, width } = alignN([this, lo, hi])
        return mk(this.owner, this.owner.call(SLOP.CLAMP, width, refs), width) as this
    }

    /** Length, distance and dot collapse to a Float whatever the input width. */
    length(): Float { return mk(this.owner, this.owner.call(SLOP.LENGTH, TYPE.FLOAT, [this.ref]), TYPE.FLOAT) }
    distance(o: Num): Float {
        const [a, c] = align2(this, o)
        return mk(this.owner, this.owner.call(SLOP.DISTANCE, TYPE.FLOAT, [a, c]), TYPE.FLOAT)
    }
    dot(o: Num): Float {
        const [a, c] = align2(this, o)
        return mk(this.owner, this.owner.call(SLOP.DOT, TYPE.FLOAT, [a, c]), TYPE.FLOAT)
    }
    normalize(): this { return un(SLOP.NORMALIZE, this) as this }

    // Comparisons give a bool per component; an int meeting a float is compared as a float.
    lt(o: Num): Bool { return compare(SLOP.LT, this, o) }
    le(o: Num): Bool { return compare(SLOP.LE, this, o) }
    gt(o: Num): Bool { return compare(SLOP.GT, this, o) }
    ge(o: Num): Bool { return compare(SLOP.GE, this, o) }
    eq(o: Num): Bool { return compare(SLOP.EQ, this, o) }
    ne(o: Num): Bool { return compare(SLOP.NE, this, o) }

    // Logic, on bools.
    and(o: Val | boolean): Bool { return logic(SLOP.AND, this, o) }
    or(o: Val | boolean): Bool { return logic(SLOP.OR, this, o) }
    not(): Bool { return logic(SLOP.NOT, this) }

    // Bits, on ints and uints. A shift takes its count modulo 32 on every backend.
    band(o: Num): this { return bits(SLOP.BIT_AND, this, o) as this }
    bor(o: Num): this { return bits(SLOP.BIT_OR, this, o) as this }
    bxor(o: Num): this { return bits(SLOP.BIT_XOR, this, o) as this }
    shl(o: Num): this { return bits(SLOP.SHL, this, o) as this }
    shr(o: Num): this { return bits(SLOP.SHR, this, o) as this }
    bnot(): this { return bits(SLOP.BIT_NOT, this) as this }

    /**
     * Arbitrary swizzle. The common single and full width ones are also getters
     * (`p.x`, `c.rgb`); this covers everything else and is typed by its argument,
     * so `c.swz("wzyx")` is a Vec4 and `c.swz("yx")` is a Vec2.
     */
    swz<S extends string>(s: S): Widen<S> {
        if (s.length < 1 || s.length > 4) throw new SLError(`a swizzle takes 1 to 4 components, got "${s}"`)
        const chans: number[] = []
        for (const ch of s) {
            const c = CHAN[ch]
            if (c === undefined) throw new SLError(`"${ch}" is not a component; use xyzw or rgba`)
            if (c >= this.width) {
                throw new SLError(`"${ch}" is component ${c + 1} of a ${widthName(this.width)}, which has ${this.width}`)
            }
            chans.push(c)
        }
        const t = chans.length as SLType
        return mk(this.owner, this.owner.add(withKind({ k: "swizzle", type: t, src: this.ref, chans }, this.kind)), t, this.kind) as Widen<S>
    }

    get x(): Float { return this.swz("x") }
    get y(): Float { return this.swz("y") }
    get z(): Float { return this.swz("z") }
    get w(): Float { return this.swz("w") }
    get r(): Float { return this.swz("r") }
    get g(): Float { return this.swz("g") }
    get b(): Float { return this.swz("b") }
    get a(): Float { return this.swz("a") }
    get xyz(): Vec3 { return this.swz("xyz") }
    get xyzw(): Vec4 { return this.swz("xyzw") }
    get rgb(): Vec3 { return this.swz("rgb") }
    get rgba(): Vec4 { return this.swz("rgba") }
}

/**
 * Every two component swizzle, as a real getter.
 *
 * These are defined rather than listed because `uv.yx` is an ordinary thing to
 * write and JavaScript answers an undeclared property with `undefined` rather
 * than an error. That `undefined` then travels into `vec4(...)` and fails
 * somewhere else entirely, about a value the author never wrote. Anything
 * reachable at runtime should be reachable in the types too, so the interfaces
 * below declare the same set.
 *
 * Three and four component permutations stay on `swz()`, which is typed by its
 * argument. There are 320 of them and almost nobody writes `.zwyx`.
 */
const PAIRS: string[] = []
for (const set of ["xyzw", "rgba"]) {
    for (const a of set) for (const b of set) PAIRS.push(a + b)
}
for (const p of PAIRS) {
    if (p in Val.prototype) continue
    Object.defineProperty(Val.prototype, p, {
        get(this: Val) { return this.swz(p) },
        enumerable: false,
        configurable: true,
    })
}

/** The two component swizzles defined above, so the types match the runtime. */
type Pair<S extends string> = { readonly [K in `${S}${S}` & string]: Vec2 }
// Deliberate: the type half of the getters defined on Val.prototype directly above.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Val extends Pair<"x" | "y" | "z" | "w">, Pair<"r" | "g" | "b" | "a"> {}

/** TypeScript's view of a recorded value. One runtime class, four static types. */
export interface Float extends Val { readonly width: 1 }
export interface Vec2 extends Val { readonly width: 2 }
export interface Vec3 extends Val { readonly width: 3 }
export interface Vec4 extends Val { readonly width: 4 }
/** A value holding a bool, an int or a uint rather than floats. */
export interface Bool extends Val { readonly width: 1; readonly kind: "bool" }
export interface Int extends Val { readonly width: 1; readonly kind: "int" }
export interface UInt extends Val { readonly width: 1; readonly kind: "uint" }

function mk(b: Builder, ref: NodeRef, width: SLType, kind?: SLKind): any {
    return new Val(b, ref, width, kind)
}

/** A node with its kind, which a float node leaves out so it keys and hashes as it always did. */
function withKind<T extends SLNode>(n: T, kind: SLKind | undefined): T {
    return kind === undefined ? n : { ...n, kind }
}

// MARK: recording context

let current: Builder | null = null

function ctx(): Builder {
    if (current === null) {
        throw new SLError(
            "sl values can only be built inside sl.program(). A value recorded outside one has no " +
            "graph to belong to, and a value from a different program cannot be mixed into this one.",
        )
    }
    return current
}

/** Lifts a plain number to a node of the given width. */
function lift(b: Builder, v: Num, width: SLType): NodeRef {
    if (typeof v === "number") return b.constant(new Array(width).fill(v))
    if (v.owner !== b) throw new SLError("a value from another program cannot be used in this one")
    return v.ref
}

/**
 * Aligns two operands. A Float broadcasts against a vector, as in HLSL; two
 * vectors of different widths are a type error, which TypeScript already catches
 * at the call site for typed code and this catches for everything else.
 */
function align2(a: Val, o: Num): [NodeRef, NodeRef] {
    if (typeof o === "number") return [a.ref, lift(a.owner, o, a.width)]
    if (o.owner !== a.owner) throw new SLError("a value from another program cannot be used in this one")
    if (o.width === a.width) return [a.ref, o.ref]
    if (o.width === 1) return [a.ref, broadcast(o, a.width)]
    if (a.width === 1) return [broadcast(a, o.width), o.ref]
    throw new SLError(`cannot combine a ${widthName(a.width)} with a ${widthName(o.width)}`)
}

/**
 * Aligns any number of operands of a component wise op to their widest.
 *
 * THE RESULT WIDTH IS THE WIDEST OPERAND, not the first one. `align2` gets that
 * right for two operands because `bin` takes the max itself; the three and four
 * operand ops used to take the width from one chosen operand, so
 * `mix(0, aVec3, t)` produced a node typed float that held three components.
 * The VM, which kept every value in a float4 register, never noticed, while the
 * HLSL emitter declared `float` and truncated, so the two backends rendered
 * different pictures from one program. Anything component wise with more than
 * two operands goes through here.
 */
function alignN(vs: Num[]): { refs: NodeRef[]; width: SLType } {
    let width: SLType = 1
    let owner: Builder | null = null
    for (const v of vs) {
        if (typeof v === "number") continue
        if (owner === null) owner = v.owner
        else if (v.owner !== owner) throw new SLError("a value from another program cannot be used in this one")
        if (v.width > width) width = v.width
    }
    const b = owner ?? ctx()
    const refs = vs.map((v) => {
        if (typeof v === "number") return lift(b, v, width)
        if (v.width === width) return v.ref
        if (v.width === 1) return broadcast(v, width)
        throw new SLError(`cannot combine a ${widthName(v.width)} with a ${widthName(width)}`)
    })
    return { refs, width }
}

/** float -> vecN by repeating the component. */
function broadcast(v: Val, width: SLType): NodeRef {
    return v.owner.add(withKind({ k: "swizzle", type: width, src: v.ref, chans: new Array(width).fill(0) }, v.kind))
}

function bin(op: SLOpCode, a: Val, o: Num): Val {
    if (a.kind !== undefined || (typeof o !== "number" && o.kind !== undefined)) return kindedBin(op, a, o)
    const [x, y] = align2(a, o)
    const width = typeof o === "number" ? a.width : (Math.max(a.width, o.width) as SLType)
    return mk(a.owner, a.owner.call(op, width, [x, y]), width)
}

function un(op: SLOpCode, a: Val): Val {
    if (a.kind !== undefined) {
        if ((op === SLOP.NEG || op === SLOP.ABS) && a.kind === "int") return mk(a.owner, a.owner.call(op, a.width, [a.ref], undefined, a.kind), a.width, a.kind)
        a = toFloat(a)
    }
    return mk(a.owner, a.owner.call(op, a.width, [a.ref]), a.width)
}

// MARK: kinds (IR 4)

/** The ops an int or a uint keeps its kind through. Anything else takes it as a float. */
const INT_OPS = new Set<number>([SLOP.ADD, SLOP.SUB, SLOP.MUL, SLOP.DIV, SLOP.MOD, SLOP.MIN, SLOP.MAX, SLOP.CLAMP])

/** A value as floats: itself when it already is, a conversion otherwise (a bool is 0 or 1). */
export function toFloat(v: Val): Val {
    if (v.kind === undefined) return v
    return mk(v.owner, v.owner.call(SLOP.CAST, v.width, [v.ref]), v.width)
}

/**
 * The operands of an op brought to one kind and one width.
 *
 * Two ints stay ints, and a whole number beside one is an int too. Anything
 * else meeting a float, a bool among them, becomes a float, as HLSL converts
 * it. An int and a uint are refused, since which one wins is a guess.
 */
function unify(vs: Num[]): { refs: NodeRef[]; width: SLType; kind: SLKind | undefined; owner: Builder } {
    let owner: Builder | null = null
    const kinds = new Set<SLKind | undefined>()
    let width: SLType = 1
    for (const v of vs) {
        if (typeof v === "number") continue
        if (owner === null) owner = v.owner
        else if (v.owner !== owner) throw new SLError("a value from another program cannot be used in this one")
        kinds.add(v.kind)
        if (v.width > width) width = v.width
    }
    const b = owner ?? ctx()
    if (kinds.has("int") && kinds.has("uint")) {
        throw new SLError("cannot combine an int with a uint; convert one with int(...) or uint(...)")
    }
    let kind = kinds.size === 1 ? [...kinds][0] : undefined
    if (kind === "bool") kind = undefined
    if (kind !== undefined && vs.some((v) => typeof v === "number" && !Number.isInteger(v))) kind = undefined
    const refs = vs.map((v) => {
        if (typeof v === "number") return b.constant(new Array(width).fill(v), kind)
        const x = kind === undefined ? toFloat(v) : v
        if (x.width === width) return x.ref
        if (x.width === 1) return broadcast(x, width)
        throw new SLError(`cannot combine a ${widthName(x.width)} with a ${widthName(width)}`)
    })
    return { refs, width, kind, owner: b }
}

function kindedBin(op: SLOpCode, a: Val, o: Num): Val {
    const { refs, width, kind, owner } = unify([a, o])
    if (kind === undefined || !INT_OPS.has(op)) {
        const x = mk(owner, refs[0]!, width) as Val
        return bin(op, x, mk(owner, refs[1]!, width) as Val)
    }
    return mk(owner, owner.call(op, width, refs, undefined, kind), width, kind)
}

function compare(op: SLOpCode, a: Val, o: Num): Bool {
    const { refs, width, kind, owner } = unify([a, o])
    void kind
    return mk(owner, owner.call(op, width, refs, undefined, "bool"), width, "bool")
}

/** A bool operand, a JS boolean made a constant. */
function asBool(b: Builder, v: Val | boolean, what: string): Val {
    if (typeof v === "boolean") return mk(b, b.constant([v ? 1 : 0], "bool"), 1, "bool")
    if (v.kind !== "bool") throw new SLError(`${what} takes bools, and this is ${v.kind === undefined ? `a ${widthName(v.width)}` : `an ${v.kind}`}; compare it, as in x > 0`)
    return v
}

function logic(op: SLOpCode, a: Val, o?: Val | boolean): Bool {
    const name = op === SLOP.AND ? "&&" : op === SLOP.OR ? "||" : "!"
    const x = asBool(a.owner, a, name)
    if (o === undefined) return mk(a.owner, a.owner.call(op, x.width, [x.ref], undefined, "bool"), x.width, "bool")
    const y = asBool(a.owner, o, name)
    if (x.width !== y.width) throw new SLError(`cannot combine a bool${x.width} with a bool${y.width}`)
    return mk(a.owner, a.owner.call(op, x.width, [x.ref, y.ref], undefined, "bool"), x.width, "bool")
}

function bits(op: SLOpCode, a: Val, o?: Num): Val {
    const word = SL_HLSL[op]?.syntax ?? SL_NAME[op]
    const intOnly = (v: Num) => {
        if (typeof v === "number" ? !Number.isInteger(v) : v.kind !== "int" && v.kind !== "uint") {
            throw new SLError(`${word} works on the bits of an int or a uint, and this is ${typeof v === "number" ? "a fraction" : v.kind === "bool" ? "a bool; use && or ||" : `a ${widthName(v.width)}`}`)
        }
    }
    intOnly(a)
    if (o === undefined) return mk(a.owner, a.owner.call(op, a.width, [a.ref], undefined, a.kind), a.width, a.kind)
    intOnly(o)
    // A shift's count is its own kind; the value shifted keeps its own.
    if (op === SLOP.SHL || op === SLOP.SHR) {
        const count = typeof o === "number" ? a.owner.constant([o], a.kind) : o.ref
        return mk(a.owner, a.owner.call(op, a.width, [a.ref, count], undefined, a.kind), a.width, a.kind)
    }
    const { refs, width, kind, owner } = unify([a, o])
    return mk(owner, owner.call(op, width, refs, undefined, kind), width, kind)
}

/** A conversion to `kind`, or to floats when it is undefined. A float to an int truncates toward zero, held to the int's range. */
function convert(v: Num | boolean, kind: SLKind | undefined): Val {
    const b = typeof v === "object" ? v.owner : ctx()
    if (typeof v === "boolean") v = mk(b, b.constant([v ? 1 : 0], "bool"), 1, "bool") as Val
    if (typeof v === "number") {
        if (kind === undefined) return mk(b, b.constant([v]), 1)
        if (kind === "bool") return mk(b, b.constant([v !== 0 ? 1 : 0], "bool"), 1, "bool")
        // A whole number the kind holds is that number exactly (`747796405u`);
        // anything else is a float converted, as the GPU would.
        const exact = Number.isInteger(v) && (kind === "int" ? v >= -2147483648 && v <= 2147483647 : v >= 0 && v <= 4294967295)
        return mk(b, b.constant([exact ? v : truncateHeld(v, kind)], kind), 1, kind)
    }
    if (v.kind === kind) return v
    return mk(b, b.call(SLOP.CAST, v.width, [v.ref], undefined, kind), v.width, kind)
}

/** An int: a whole number, or a value converted, a float truncating toward zero. */
export function int(v: Num | boolean): Int { return convert(v, "int") as Int }
export function uint(v: Num | boolean): UInt { return convert(v, "uint") as UInt }
/** A bool: true or false, or a value converted, where anything but zero is true. */
export function bool(v: Num | boolean): Bool { return convert(v, "bool") as Bool }

function choose(b: Builder, cond: Num | boolean, whenTrue: Num, whenFalse: Num): Val {
    if (typeof cond === "boolean") return convertTo(cond ? whenTrue : whenFalse, whenTrue, whenFalse)
    // What SELECT reads a float condition as, so the two agree.
    const c = typeof cond === "number" ? asBool(b, cond >= 0.5, "a choice")
        : cond.kind === "bool" ? cond : cond.kind === undefined ? cond.ge(0.5) : cond.ne(0)
    if (c.width !== 1) throw new SLError("a choice takes one bool, and this is several; combine them with && or ||")
    const { refs, width, kind, owner } = unify([whenTrue, whenFalse])
    return mk(owner, owner.call(SLOP.CHOOSE, width, [c.ref, ...refs], undefined, kind), width, kind)
}

/** `v` as the type the two would unify to, for a choice whose condition is known. */
function convertTo(v: Num, a: Num, c: Num): Val {
    const { refs, width, kind, owner } = unify([a, c])
    return mk(owner, v === a ? refs[0]! : refs[1]!, width, kind)
}

/**
 * A real branch: only the side `cond` picks runs, and its results come back.
 * Both sides give the same number of results, pairwise of one type; a plain
 * number takes its partner's. A value only one side needs is computed only when
 * that side runs.
 */
export function branch(cond: Val | boolean, whenTrue: () => Num[], whenFalse: () => Num[]): Val[] {
    const b = ctx()
    if (typeof cond === "boolean") return (cond ? whenTrue() : whenFalse()).map((v) => (typeof v === "number" ? float(v) : v))
    const c = asBool(b, cond, "a branch")
    if (c.width !== 1) throw new SLError("a branch takes one bool, and this is several; combine them with && or ||")
    const t = whenTrue()
    const f = whenFalse()
    if (t.length !== f.length) throw new SLError(`a branch's sides give ${t.length} and ${f.length} results; they must give the same`)
    const types = t.map((x, i) => pairType(x, f[i]!, i))
    if (types.length === 0) return []
    const node = b.add({ k: "if", cond: c.ref, then: t.map((v, i) => typed(b, v, types[i]!)), else: f.map((v, i) => typed(b, v, types[i]!)) })
    return types.map((ty, i) => mk(b, b.add(withKind({ k: "proj", type: ty.width, src: node, index: i }, ty.kind)), ty.width, ty.kind))
}

/**
 * A real loop. The values start as `init`; while `cond` of them holds, and
 * fewer than `max` turns have run, they become `body` of them. What comes back
 * is the values when it stops. `max` is what guarantees it stops: a loop that
 * reaches it leaves as if its condition had failed.
 */
export function loop(init: Num[], cond: (v: Val[]) => Val | boolean, body: (v: Val[]) => Num[], max = 1024): Val[] {
    const b = ctx()
    if (!Number.isInteger(max) || max < 1) throw new SLError(`a loop's turn limit is a whole number from 1, got ${max}`)
    const start = init.map((v) => (typeof v === "number" ? (float(v) as Val) : v))
    const id = b.newLoop()
    const params = start.map((v, i) => mk(b, b.add(withKind({ k: "param", type: v.width, loop: id, index: i }, v.kind)), v.width, v.kind) as Val)
    const c = asBool(b, cond(params), "a loop's condition")
    if (c.width !== 1) throw new SLError("a loop's condition is one bool, and this is several; combine them with && or ||")
    const next = body(params)
    if (next.length !== params.length) throw new SLError(`a loop carries ${params.length} values and its body gave ${next.length}`)
    const ty = params.map((p) => ({ width: p.width, kind: p.kind }))
    const node = b.add({
        k: "loop", id, init: start.map((v) => v.ref), cond: c.ref,
        next: next.map((v, i) => { pairType(params[i]!, v, i); return typed(b, v, ty[i]!) }), max,
    })
    return ty.map((t, i) => mk(b, b.add(withKind({ k: "proj", type: t.width, src: node, index: i }, t.kind)), t.width, t.kind))
}

interface ValType { width: SLType; kind: SLKind | undefined }

/** The one type two results share, or why they do not. */
function pairType(a: Num, c: Num, i: number): ValType {
    if (typeof a === "number" && typeof c === "number") return { width: 1, kind: undefined }
    if (typeof a === "number") return { width: (c as Val).width, kind: (c as Val).kind }
    if (typeof c === "number") return { width: a.width, kind: a.kind }
    if (a.width !== c.width || a.kind !== c.kind) {
        const name = (v: Val) => (v.kind === undefined ? widthName(v.width) : v.width === 1 ? v.kind : `${v.kind}${v.width}`)
        throw new SLError(`result ${i} is a ${name(a)} one way and a ${name(c)} the other`)
    }
    return { width: a.width, kind: a.kind }
}

/** A result as a node of its type, a plain number becoming a constant. */
function typed(b: Builder, v: Num, t: ValType): NodeRef {
    if (typeof v === "number") return b.constant(new Array(t.width).fill(v), t.kind)
    return v.ref
}

// MARK: the public surface

export interface ProgramInputs {
    uv: Vec2
    fragCoord: Vec2
    resolution: Vec2
    time: Float
    aspect: Float
    /** One pixel, in uv: `1 / resolution`. Recorded only if read. */
    texel: Vec2
    /** `(uv - 0.5) * vec2(aspect, 1)`: 0 at the centre, and a circle stays round. Recorded only if read. */
    centered: Vec2
}

/**
 * Records a program. The function runs ONCE, here, not per pixel.
 *
 * It must return a Vec4: a program produces a colour.
 */
export function program(fn: (inputs: ProgramInputs) => Vec4): Program {
    if (current !== null) throw new SLError("sl.program() cannot be nested")
    const b = new Builder()
    current = b
    try {
        const inputs = {} as ProgramInputs
        for (const [name, width] of Object.entries(INPUTS)) {
            const ref = b.add({ k: "input", type: width as SLType, name: name as InputName })
            ;(inputs as any)[name] = mk(b, ref, width as SLType)
        }
        // Getters, so a program that never reads one records nothing for it
        // (DERIVED_INPUTS in ir.ts). A second read is hash consed to the first.
        Object.defineProperties(inputs, {
            texel: { enumerable: true, get: () => vec2(1, 1).div(inputs.resolution) },
            centered: { enumerable: true, get: () => inputs.uv.sub(0.5).mul(vec2(inputs.aspect, 1)) },
        })
        const out = fn(inputs)
        if (!(out instanceof Val)) throw new SLError("a program must return an sl value, not " + typeof out)
        if (out.width !== TYPE.VEC4) {
            throw new SLError(`a program must return a vec4, got a ${widthName(out.width)}. Wrap it: sl.vec4(value, 1)`)
        }
        const nodes: SLNode[] = b.nodes.slice()
        return {
            version: programVersion(nodes, out.ref),
            nodes,
            result: out.ref,
            uniforms: b.uniforms.slice(),
            textures: b.textures.slice(),
            hash: hashProgram(nodes, out.ref, b.uniforms, b.textures),
        }
    } finally {
        current = null
    }
}

export function float(v: Num): Float {
    const b = ctx()
    if (typeof v !== "number") return (v.kind === undefined ? v : toFloat(v)) as Float
    return mk(b, b.constant([v]), TYPE.FLOAT)
}

/** Builds a wider value from narrower parts, which must add up exactly. */
function compose(width: SLType, parts: Num[]): Val {
    const b = ctx()
    // Wide parts are SPLIT into their components here, so COMPOSE only ever
    // sees scalars.
    //
    // The VM (removed in 0.3.0) took the x of each operand, which dropped
    // everything after the first component: vec4(uv, 0, 1) rendered
    // (uv.x, 0, 1, 0). Splitting at record time costs a few extra swizzle
    // nodes and keeps every emitter's COMPOSE trivial.
    // A constructor of literals is ONE constant, not a COMPOSE of four.
    //
    // Every part as its own CONST, joined by a COMPOSE, is five nodes where the
    // IR can say it in one: a const carries up to four components.
    if (parts.length === width && parts.every((p) => typeof p === "number")) {
        return mk(b, b.constant(parts as number[]), width)
    }

    const refs: NodeRef[] = []
    let total = 0
    for (const p of parts) {
        if (typeof p === "number") { refs.push(b.constant([p])); total += 1; continue }
        if (p.owner !== b) throw new SLError("a value from another program cannot be used in this one")
        if (p.width === 1) { refs.push(p.ref); total += 1; continue }
        for (let c = 0; c < p.width; c++) {
            refs.push(b.add({ k: "swizzle", type: TYPE.FLOAT, src: p.ref, chans: [c] }))
            total += 1
        }
    }
    if (total !== width) {
        throw new SLError(`vec${width} needs ${width} components, got ${total}`)
    }
    return mk(b, b.call(SLOP.COMPOSE, width, refs), width)
}

export function vec2(...parts: Num[]): Vec2 { return compose(TYPE.VEC2, parts) as Vec2 }
export function vec3(...parts: Num[]): Vec3 { return compose(TYPE.VEC3, parts) as Vec3 }
export function vec4(...parts: Num[]): Vec4 { return compose(TYPE.VEC4, parts) as Vec4 }

/**
 * A one argument op, typed so the width survives.
 *
 * Overloads rather than a conditional return type: the conditional form widened
 * `sl.sin(aFloat)` to `Float | Val`, so `let v = uv.x; v = sl.sin(v)` failed to
 * typecheck. An author hitting that would reasonably conclude the types were
 * decorative.
 */
function unary(op: SLOpCode) {
    function f(v: number): Float
    function f<T extends Val>(v: T): T
    function f(v: Num): Val {
        return un(op, typeof v === "number" ? (float(v) as Val) : v)
    }
    return f
}

export const sin = unary(SLOP.SIN)
export const cos = unary(SLOP.COS)
export const tan = unary(SLOP.TAN)
export const asin = unary(SLOP.ASIN)
export const acos = unary(SLOP.ACOS)
export const exp = unary(SLOP.EXP)
export const log = unary(SLOP.LOG)
export const sqrt = unary(SLOP.SQRT)
export const sign = unary(SLOP.SIGN)
export const ceil = unary(SLOP.CEIL)
export const round = unary(SLOP.ROUND)

/**
 * Collapses a colour to a single brightness.
 *
 * NOT declared through `unary`, which preserves width. Luminance is one of the
 * few ops whose result is narrower than its input, and having it return a Vec4
 * meant `sl.vec4(sl.mix(lum, c.x, 0.5), c.y, c.z, c.w)` silently became seven
 * components. The error surfaced two calls away from the cause, which is what
 * width preserving by default costs when it is wrong.
 */
/**
 * A colour as written (sRGB, the way CSS reads a hex) to the working space the
 * target holds. `ramp` and `color` already apply it; call it yourself on a
 * vec4 built from raw components that mean a colour. Alpha is left alone.
 */
export const toLinear = unary(SLOP.TO_LINEAR)

/** A hex colour as a vec4 in the working space: `parseColor` plus `toLinear`. */
export function color(hex: string): Vec4 {
    const v = parseColor(hex)
    return toLinear(vec4(v[0], v[1], v[2], v[3]))
}

export function luminance(c: Num): Float {
    const v = typeof c === "number" ? float(c) : c
    return mk(v.owner, v.owner.call(SLOP.LUMINANCE, TYPE.FLOAT, [v.ref]), TYPE.FLOAT)
}

/**
 * Hue, saturation and value to RGB.
 *
 * The opcode was already implemented in both backends and simply had no name
 * out here, which is the kind of gap only writing something real finds: a demo
 * wanted a hue uniform, and a ramp cannot have one because its stops are
 * constants.
 */
export function hsv2rgb(c: Vec3): Vec3 {
    return mk(c.owner, c.owner.call(SLOP.HSV2RGB, TYPE.VEC3, [c.ref]), TYPE.VEC3)
}

/**
 * Cross and reflect, both vec3 only.
 *
 * Refusing the other widths here keeps every backend drawing the same thing,
 * rather than each deciding what a vec2 or vec4 cross product means.
 */
export function cross(a: Vec3, b: Vec3): Vec3 {
    if (a.width !== TYPE.VEC3 || b.width !== TYPE.VEC3) {
        throw new SLError(`cross takes two vec3s, got a ${widthName(a.width)} and a ${widthName(b.width)}`)
    }
    const [x, y] = align2(a, b)
    return mk(a.owner, a.owner.call(SLOP.CROSS, TYPE.VEC3, [x, y]), TYPE.VEC3)
}

export function reflect(incident: Vec3, normal: Vec3): Vec3 {
    if (incident.width !== TYPE.VEC3 || normal.width !== TYPE.VEC3) {
        throw new SLError(
            `reflect takes two vec3s, got a ${widthName(incident.width)} and a ${widthName(normal.width)}`,
        )
    }
    const [i, n] = align2(incident, normal)
    return mk(incident.owner, incident.owner.call(SLOP.REFLECT, TYPE.VEC3, [i, n]), TYPE.VEC3)
}

/**
 * One range to another, linearly and without clamping.
 *
 * A MACRO, like `ramp`, and for the same reason: it expands into arithmetic
 * both backends already have, so it needs no opcode, no second implementation
 * in the emitters. `SLOP.REMAP` stays a reserved number.
 *
 * Unclamped on purpose, which is what HLSL authors expect of the one liner they
 * would otherwise write; wrap it in `saturate` when the ends matter.
 */
export function remap(v: Num, fromMin: Num, fromMax: Num, toMin: Num, toMax: Num): Val {
    const x = typeof v === "number" ? float(v) : v
    const t = x.sub(fromMin).div(difference(fromMax, fromMin))
    return mix(toMin, toMax, t)
}

/** `a - b` where either side may still be a plain number, so a constant stays one. */
function difference(a: Num, b: Num): Num {
    if (typeof a === "number" && typeof b === "number") return a - b
    return (typeof a === "number" ? float(a) : a).sub(b)
}

export function atan2(y: Num, x: Num): Float {
    const b = ctx()
    // An angle is one number. Given vectors, the node would still be a float
    // and every backend would disagree about which lane it kept: HLSL takes
    // .x silently, GLSL and WGSL refuse to compile.
    for (const v of [y, x]) {
        if (typeof v !== "number" && v.width !== 1) {
            throw new SLError(`atan2 takes two floats, and this is a ${v.width === 2 ? "float2" : v.width === 3 ? "float3" : "float4"}: call it per component`)
        }
    }
    const yy = typeof y === "number" ? float(y) : y
    const [a, c] = align2(yy as Val, x)
    return mk(b, b.call(SLOP.ATAN2, TYPE.FLOAT, [a, c]), TYPE.FLOAT)
}

/**
 * Branchless selection. Both sides are evaluated, which is why v1 has this
 * rather than an `if`: a real branch would have to survive both backends
 * identically, and this does not.
 */
export function select(cond: Num | boolean, whenTrue: Num, whenFalse: Num): Val {
    const b = ctx()
    const kinded = (v: Num | boolean) => typeof v === "object" && v.kind !== undefined
    // A bool condition, or results that are not floats: a choice, which carries
    // any kind, where SELECT's arithmetic carries only floats (IR 4).
    if (typeof cond === "boolean" || kinded(cond) || kinded(whenTrue) || kinded(whenFalse)) return choose(b, cond, whenTrue, whenFalse)
    const c = typeof cond === "number" ? float(cond) : cond
    const t = typeof whenTrue === "number" ? float(whenTrue) : whenTrue
    const f = typeof whenFalse === "number" ? float(whenFalse) : whenFalse
    // The condition is widened with the branches, not left at its own width.
    // The VM (removed in 0.3.0) held a scalar condition as (c, 0, 0, 0) and
    // answered 0 for components y, z and w, while HLSL broadcasts a scalar
    // itself; the two disagreed on every vector valued select. Widening here
    // keeps every emitter's SELECT the same simple form.
    const { refs, width } = alignN([c, t, f])
    return mk(b, b.call(SLOP.SELECT, width, refs), width)
}

/**
 * The interpolant is broadcast to the operand width before it crosses.
 *
 * The VM (removed in 0.3.0) held a scalar `t` as (t, 0, 0, 0) and its lerp
 * ran per component against those zeros:
 * a black to white ramp at its midpoint rendered (0.5, 0, 0, 1) instead of
 * grey. Broadcasting here rather than in the shader keeps `t` free to be a
 * genuine per component vector when an author wants one.
 */
export function mix(a: Num, bv: Num, t: Num): Val {
    const { refs, width } = alignN([a, bv, t])
    const b = ctx()
    return mk(b, b.call(SLOP.MIX, width, refs), width)
}

export function step(edge: Num, x: Num): Val {
    const { refs, width } = alignN([edge, x])
    const b = ctx()
    return mk(b, b.call(SLOP.STEP, width, refs), width)
}

export function smoothstep(e0: Num, e1: Num, x: Num): Val {
    const { refs, width } = alignN([e0, e1, x])
    const b = ctx()
    return mk(b, b.call(SLOP.SMOOTHSTEP, width, refs), width)
}

/** Uniform defaults, in slot order, for a host that has to seed them. */
export function uniformDefaults(p: Program): number[] {
    const out: number[] = []
    for (const u of p.uniforms) {
        for (let i = 0; i < 4; i++) out.push(u.value[i] ?? (i === 3 ? 1 : 0))
    }
    return out
}

/**
 * Noise, as superinstructions rather than graphs of primitives, and the same
 * fields `fx.noise` draws: a value or simplex base, layered as fBm, or the
 * turbulence and ridged variants built on simplex. A program has no seed;
 * offset the input for a different field. Octaves are 1 to 4, as in fx.
 *
 * The octave count may be a value, a uniform say, rounded to the nearest whole
 * number and held to 1 to 4 where it is read. It is an operand either way
 * (IR 3); a constant one is checked here, and prints as the number it is.
 */
export function noise(p: Vec2): Float {
    return mk(p.owner, p.owner.call(SLOP.NOISE, TYPE.FLOAT, [p.ref]), TYPE.FLOAT)
}
export function simplex(p: Vec2): Float {
    return mk(p.owner, p.owner.call(SLOP.SIMPLEX, TYPE.FLOAT, [p.ref]), TYPE.FLOAT)
}
/**
 * An octave op: the point and the count as operands, with `rest` (fbm's kind)
 * the immediates. A constant count is checked here.
 */
function octaves(op: SLOpCode, name: string, p: Vec2, count: Num, rest: number[]): Float {
    const c = components(p.owner, count)
    if (c.length !== 1) throw new SLError(`${name}'s octave count is one number, and this is a ${widthName(c.length as SLType)}`)
    const n = c[0]!
    if (typeof n === "number" && (!Number.isInteger(n) || n < 1 || n > 4)) {
        throw new SLError(`${name} octaves must be a whole number from 1 to 4, got ${n}`)
    }
    const v = typeof n === "number" ? float(n) : n
    return mk(p.owner, p.owner.call(op, TYPE.FLOAT, [p.ref, v.ref], rest), TYPE.FLOAT)
}
/** Layered noise. `base` picks the grid ("value", the default) or triangles ("simplex"). */
export function fbm(p: Vec2, octaveCount: Num = 3, base: "value" | "simplex" = "value"): Float {
    return octaves(SLOP.FBM, "fbm", p, octaveCount, [base === "simplex" ? 1 : 0])
}
/** Sum of |simplex| octaves: creases that stack into veins and licks. Fire, smoke, marble. */
export function turbulence(p: Vec2, octaveCount: Num = 3): Float {
    return octaves(SLOP.TURBULENCE, "turbulence", p, octaveCount, [])
}
/** The turbulence crease made bright and squared: ridges, lightning, cracks. */
export function ridged(p: Vec2, octaveCount: Num = 3): Float {
    return octaves(SLOP.RIDGED, "ridged", p, octaveCount, [])
}

/** "#rgb", "#rrggbb" or "#rrggbbaa" to 0..1 components. Shared with fx. */
export function parseColor(hex: string): [number, number, number, number] {
    try {
        return parseHex(hex)
    } catch (e) {
        throw new SLError((e as Error).message)
    }
}

/**
 * Maps 0..1 through evenly spaced colour stops.
 *
 * A MACRO, not an opcode. It expands into the mixes and smoothsteps already in
 * the table, which is worth more than a dedicated instruction would be: it needs
 * no new encoding, no ramp uniforms competing for space with the program, and no
 * second implementation in the HLSL emitter. Both backends get it right by
 * getting `mix` right, and a ramp of any length works rather than however many
 * stops an instruction could carry.
 *
 * This is the argument for the EDSL in miniature. A library function that
 * composes from primitives costs one function here and nothing anywhere else.
 *
 * A stop is a colour as written: a hex, four numbers, or a value that is a
 * colour as written, which is one `color`, `sl.uniform.colour` or a hex
 * literal made (a colour uniform, say). The ramp blends the colours as
 * written, so a value computed any other way, already in the working space,
 * has nothing it could blend, and is refused.
 */
export function ramp(t: Num, stops: Array<string | [number, number, number, number] | Vec3 | Vec4>): Vec4 {
    if (stops.length < 2) throw new SLError(`a ramp needs at least 2 stops, got ${stops.length}`)
    const tv = (typeof t === "number" ? float(t) : t).saturate()
    const written = stops.map((s) => (s instanceof Val ? asWritten(s) : null))
    // Each stop is built immediately before the mix that consumes it. The graph
    // and the hash are the same either way (the hash is over the shape, not the
    // storage order); the order only mattered to the VM's register allocator.
    const colourAt = (i: number) => {
        const w = written[i]
        if (w !== null && w !== undefined) return w
        const v = typeof stops[i] === "string" ? parseColor(stops[i] as string) : (stops[i] as number[])
        return vec4(v[0], v[1], v[2], v[3])
    }
    const spans = stops.length - 1
    let out = colourAt(0)
    for (let i = 0; i < spans; i++) {
        // Local 0..1 across this span, clamped, so stops outside it contribute
        // nothing and the chain reads as "each span paints over the last".
        const local = (tv.mul(spans).sub(i) as Float).saturate()
        out = mix(out, colourAt(i + 1), local) as Vec4
    }
    // The stops are sRGB as written and the mixes ran in that space, which is
    // what reads as an even ramp; one conversion at the end puts the result in
    // the target's working space. Same rule as fx's gradient and ramp.
    return toLinear(out)
}

/**
 * A colour value as it was written, a float4: the operand of the `toLinear`
 * that reading it as a colour applied, with alpha 1 when it has three
 * components. Anything else was computed in the working space.
 */
function asWritten(v: Vec3 | Vec4): Vec4 {
    const ref = writtenColour(v.owner.nodes, v.ref)
    if (ref === null) throw new SLError(RAMP_STOP_COMPUTED)
    const raw = mk(v.owner, ref, v.width) as Val
    return v.width === TYPE.VEC4 ? (raw as Vec4) : vec4(raw, 1)
}

/**
 * Signed distance to a shape, positive outside and negative inside.
 *
 * The 42 shapes are the same ones `fx` draws, from the same HLSL, so a hexagon
 * means one thing across the whole library rather than two.
 *
 *     const d = sl.sdf("hexagon", uv.sub(0.5), [0.3])
 *     return sl.vec4(sl.smoothstep(0.01, 0, d), 0, 0, 1)
 *
 * POSITION AND ROTATION ARE NOT PARAMETERS, deliberately. Transform the point
 * before calling, as `uv.sub(centre)` above does. That is how signed distance
 * code is normally written and it composes with everything else in the language.
 *
 * A shape takes up to `SL_SDF_PARAMS[kind]` parameters, six at most. Fewer
 * fills zeros, which is all a program could pass before six shapes grew their
 * fifth and sixth. A vector parameter counts as its components, so a box's
 * half extents can be one float2.
 *
 * Which parameters a shape takes is the shape's own business; `circle` wants a
 * radius, `roundedBox` wants half extents and a corner. See `lib/sdf2d.hlsl`.
 *
 * A parameter may be any value, a uniform or one computed per pixel. The six
 * are operands either way (IR 3), a float4 and a float2, and constant ones
 * print as the numbers they are.
 */
export function sdf(kind: SlSdfKind, p: Vec2, params: Num[] = []): Float {
    const id = SL_SDF_SHAPES[kind]
    if (id === undefined) throw new SLError(`"${kind}" is not a shape; see SL_SDF_SHAPES for the 42 names`)
    const c = params.flatMap((v) => components(p.owner, v))
    // At least four, so a program that passed a shape more than it reads, which
    // was harmless when every shape took four, still builds.
    const most = Math.max(4, SL_SDF_PARAMS[kind])
    if (c.length > most) {
        throw new SLError(`sl.sdf("${kind}") takes at most ${most} parameters and was given ${c.length}`)
    }
    for (const v of c) {
        if (typeof v === "number" && !Number.isFinite(v)) throw new SLError(`sl.sdf parameters must be finite, got ${v}`)
    }
    const q = vec4(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0)
    const r = vec2(c[4] ?? 0, c[5] ?? 0)
    return mk(p.owner, p.owner.call(SLOP.SDF, TYPE.FLOAT, [p.ref, q.ref, r.ref], [id]), TYPE.FLOAT)
}

/**
 * A value as its components: numbers for a constant, which is what it would
 * have been written as, and a float per component otherwise.
 */
function components(b: Builder, v: Num): Num[] {
    if (typeof v === "number") return [v]
    if (v.owner !== b) throw new SLError("a value from another program cannot be used in this one")
    const n = b.nodes[v.ref]!
    if (n.k === "const") return n.v.slice()
    if (v.width === 1) return [v]
    return Array.from({ length: v.width }, (_, i) => v.swz("xyzw"[i] as "x"))
}

/** Distance to the nearest point of a jittered lattice. Cells, cracks, scales. */
export function voronoi(p: Vec2): Float {
    return mk(p.owner, p.owner.call(SLOP.VORONOI, TYPE.FLOAT, [p.ref]), TYPE.FLOAT)
}

/**
 * A uniform: a value the host sets by name, with the default the program
 * starts from. The last argument says how a host presents it, a slider, a
 * checkbox, a dropdown, a heading or a label, and is what `[Range(0, 2)]` and
 * the other attributes write in a `.sl` file. It never changes the hash.
 *
 *     sl.uniform.float("warp", 1, { range: { min: 0, max: 2 } })
 */
export const uniform = {
    float(name: string, value = 0, control: UniformControl = {}): Float {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.FLOAT, [value], false, control), TYPE.FLOAT)
    },
    vec2(name: string, value: [number, number] = [0, 0], control: UniformControl = {}): Vec2 {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.VEC2, value, false, control), TYPE.VEC2)
    },
    vec3(name: string, value: [number, number, number] = [0, 0, 0], control: UniformControl = {}): Vec3 {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.VEC3, value, false, control), TYPE.VEC3)
    },
    vec4(name: string, value: [number, number, number, number] = [0, 0, 0, 1], control: UniformControl = {}): Vec4 {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.VEC4, value, false, control), TYPE.VEC4)
    },
    /**
     * A colour, defaulting to `hex` as written (sRGB, the way CSS reads it), or
     * to components written the same way. Returns it converted to linear, as a
     * hex literal is, and marks the declaration `colour` so a host can offer a
     * colour picker for it. Three components when `width` is 3, dropping the
     * alpha.
     */
    colour: ((name: string, hex: string | readonly number[], width: 3 | 4 = 4, control: UniformControl = {}): Vec3 | Vec4 => {
        const b = ctx()
        const c = typeof hex === "string" ? parseHex(hex) : [hex[0] ?? 0, hex[1] ?? 0, hex[2] ?? 0, hex[3] ?? 1]
        const type = width === 3 ? TYPE.VEC3 : TYPE.VEC4
        const raw = mk(b, b.uniform(name, type, c.slice(0, width), true, control), type)
        return toLinear(raw) as Vec3 | Vec4
    }) as {
        (name: string, hex: string | readonly number[]): Vec4
        (name: string, hex: string | readonly number[], width: 3, control?: UniformControl): Vec3
        (name: string, hex: string | readonly number[], width: 4, control?: UniformControl): Vec4
        (name: string, hex: string | readonly number[], width: 3 | 4, control?: UniformControl): Vec3 | Vec4
    },
}

export interface Texture {
    /** The colour at `uv`, filtered as the texture's own settings say. */
    sample(uv: Vec2): Vec4
    /**
     * The colour at `uv` from mip level `lod`: 0 is the full size texture, 1
     * half, and a fraction blends two levels where the texture's filter does.
     * A texture with no mips has only level 0.
     */
    sampleLevel(uv: Vec2, lod: Num): Vec4
}

export function texture(name: string): Texture {
    const b = ctx()
    const slot = b.texture(name)
    return {
        sample(uv: Vec2): Vec4 {
            if (uv.owner !== b) throw new SLError("a value from another program cannot be used in this one")
            return mk(b, b.call(SLOP.SAMPLE, TYPE.VEC4, [uv.ref], [slot]), TYPE.VEC4)
        },
        sampleLevel(uv: Vec2, lod: Num): Vec4 {
            if (uv.owner !== b) throw new SLError("a value from another program cannot be used in this one")
            const level = typeof lod === "number" ? b.constant([lod]) : lod
            if (typeof level !== "number") {
                if (level.owner !== b) throw new SLError("a value from another program cannot be used in this one")
                if (level.width !== 1) throw new SLError(`a mip level is one number, and this is a ${widthName(level.width)}`)
            }
            return mk(b, b.call(SLOP.SAMPLE_LOD, TYPE.VEC4, [uv.ref, typeof level === "number" ? level : level.ref], [slot]), TYPE.VEC4)
        },
    }
}

/**
 * A loop that UNROLLS at record time. `n` is a JavaScript number, so the count
 * is known while the graph is being built and both backends see straight line
 * code.
 *
 * Honest about what it is: a macro, not a loop. It covers fbm, layered noise and
 * small iterated distance fields, which is most of what 2D shaders loop for. A
 * loop with a runtime count is `Specs/SL_NEXT.md` proposal 3b.
 */
export function repeat<T extends Val>(n: number, body: (i: number, acc: T) => T, seed: T): T {
    if (!Number.isInteger(n) || n < 0 || n > 64) {
        throw new SLError(`repeat count must be a whole number from 0 to 64, got ${n}`)
    }
    let acc = seed
    for (let i = 0; i < n; i++) acc = body(i, acc)
    return acc
}
