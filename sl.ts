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

import {
    Builder, INPUTS, SLError, TYPE, hashProgram, widthName,
    type InputName, type NodeRef, type Program, type SLNode, type SLType,
} from "./ir"
import { SLOP, type SLOpCode } from "./ops"

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
export class Val {
    constructor(readonly owner: Builder, readonly ref: NodeRef, readonly width: SLType) {}

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
        const [a, l, h] = align3(this, lo, hi)
        return mk(this.owner, this.owner.call(SLOP.CLAMP, this.width, [a, l, h]), this.width) as this
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
        return mk(this.owner, this.owner.add({ k: "swizzle", type: t, src: this.ref, chans }), t) as Widen<S>
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
export interface Val extends Pair<"x" | "y" | "z" | "w">, Pair<"r" | "g" | "b" | "a"> {}

/** TypeScript's view of a recorded value. One runtime class, four static types. */
export interface Float extends Val { readonly width: 1 }
export interface Vec2 extends Val { readonly width: 2 }
export interface Vec3 extends Val { readonly width: 3 }
export interface Vec4 extends Val { readonly width: 4 }

function mk(b: Builder, ref: NodeRef, width: SLType): any {
    return new Val(b, ref, width)
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

function align3(a: Val, x: Num, y: Num): [NodeRef, NodeRef, NodeRef] {
    const [ra, rx] = align2(a, x)
    const [, ry] = align2(a, y)
    return [ra, rx, ry]
}

/** float -> vecN by repeating the component. */
function broadcast(v: Val, width: SLType): NodeRef {
    return v.owner.add({ k: "swizzle", type: width, src: v.ref, chans: new Array(width).fill(0) })
}

function bin(op: SLOpCode, a: Val, o: Num): Val {
    const [x, y] = align2(a, o)
    const width = typeof o === "number" ? a.width : (Math.max(a.width, o.width) as SLType)
    return mk(a.owner, a.owner.call(op, width, [x, y]), width)
}

function un(op: SLOpCode, a: Val): Val {
    return mk(a.owner, a.owner.call(op, a.width, [a.ref]), a.width)
}

// MARK: the public surface

export interface ProgramInputs {
    uv: Vec2
    fragCoord: Vec2
    resolution: Vec2
    time: Float
    aspect: Float
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
        const out = fn(inputs)
        if (!(out instanceof Val)) throw new SLError("a program must return an sl value, not " + typeof out)
        if (out.width !== TYPE.VEC4) {
            throw new SLError(`a program must return a vec4, got a ${widthName(out.width)}. Wrap it: sl.vec4(value, 1)`)
        }
        const nodes: SLNode[] = b.nodes.slice()
        return {
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
    return typeof v === "number" ? mk(b, b.constant([v]), TYPE.FLOAT) : (v as Float)
}

/** Builds a wider value from narrower parts, which must add up exactly. */
function compose(width: SLType, parts: Num[]): Val {
    const b = ctx()
    // Wide parts are SPLIT into their components here, so COMPOSE only ever
    // sees scalars.
    //
    // The VM keeps every value in a float4 register and took the x of each
    // operand, which silently dropped everything after the first component:
    // vec4(uv, 0, 1) rendered (uv.x, 0, 1, 0) instead of (uv.x, uv.y, 0, 1).
    // Teaching the shader each part's width would need widths in an encoding
    // that has no room for them, and would put the complexity in the half that
    // is hardest to test. Splitting at record time costs a few extra swizzle
    // nodes, which the register allocator reclaims immediately, and leaves the
    // VM's COMPOSE trivially correct.
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
export function luminance(c: Num): Float {
    const v = typeof c === "number" ? float(c) : c
    return mk(v.owner, v.owner.call(SLOP.LUMINANCE, TYPE.FLOAT, [v.ref]), TYPE.FLOAT)
}

export function atan2(y: Num, x: Num): Float {
    const b = ctx()
    const yy = typeof y === "number" ? float(y) : y
    const [a, c] = align2(yy as Val, x)
    return mk(b, b.call(SLOP.ATAN2, TYPE.FLOAT, [a, c]), TYPE.FLOAT)
}

/**
 * Branchless selection. Both sides are evaluated, which is why v1 has this
 * rather than an `if`: a real branch would have to survive both backends
 * identically, and this does not.
 */
export function select(cond: Num, whenTrue: Num, whenFalse: Num): Val {
    const b = ctx()
    const c = typeof cond === "number" ? float(cond) : cond
    const t = typeof whenTrue === "number" ? float(whenTrue) : whenTrue
    const f = typeof whenFalse === "number" ? float(whenFalse) : whenFalse
    const [tr, fr] = align2(t as Val, f)
    return mk(b, b.call(SLOP.SELECT, (t as Val).width, [(c as Val).ref, tr, fr]), (t as Val).width)
}

/**
 * The interpolant is broadcast to the operand width before it crosses.
 *
 * A register is a float4 whatever it holds, so a scalar `t` sits there as
 * (t, 0, 0, 0) and the shader's lerp ran per component against those zeros:
 * a black to white ramp at its midpoint rendered (0.5, 0, 0, 1) instead of
 * grey. Broadcasting here rather than in the shader keeps `t` free to be a
 * genuine per component vector when an author wants one.
 */
export function mix(a: Num, bv: Num, t: Num): Val {
    const av = typeof a === "number" ? float(a) : a
    const [x, y] = align2(av as Val, bv)
    const [, tr] = align2(av as Val, t)
    return mk(av.owner, av.owner.call(SLOP.MIX, (av as Val).width, [x, y, tr]), (av as Val).width)
}

export function step(edge: Num, x: Num): Val {
    const xv = typeof x === "number" ? float(x) : x
    const [a, e] = align2(xv as Val, edge)
    return mk(xv.owner, xv.owner.call(SLOP.STEP, (xv as Val).width, [e, a]), (xv as Val).width)
}

export function smoothstep(e0: Num, e1: Num, x: Num): Val {
    const xv = typeof x === "number" ? float(x) : x
    const [a, r0] = align2(xv as Val, e0)
    const [, r1] = align2(xv as Val, e1)
    return mk(xv.owner, xv.owner.call(SLOP.SMOOTHSTEP, (xv as Val).width, [r0, r1, a]), (xv as Val).width)
}

/** Uniform defaults, in slot order, for a host that has to seed them. */
export function uniformDefaults(p: Program): number[] {
    const out: number[] = []
    for (const u of p.uniforms) {
        for (let i = 0; i < 4; i++) out.push(u.value[i] ?? (i === 3 ? 1 : 0))
    }
    return out
}

/** fBm and friends, as superinstructions rather than as graphs of primitives. */
export function noise(p: Vec2): Float {
    return mk(p.owner, p.owner.call(SLOP.NOISE, TYPE.FLOAT, [p.ref]), TYPE.FLOAT)
}
export function simplex(p: Vec2): Float {
    return mk(p.owner, p.owner.call(SLOP.SIMPLEX, TYPE.FLOAT, [p.ref]), TYPE.FLOAT)
}
export function fbm(p: Vec2, octaves = 3): Float {
    if (!Number.isInteger(octaves) || octaves < 1 || octaves > 8) {
        throw new SLError(`fbm octaves must be a whole number from 1 to 8, got ${octaves}`)
    }
    return mk(p.owner, p.owner.call(SLOP.FBM, TYPE.FLOAT, [p.ref], [octaves]), TYPE.FLOAT)
}

/** "#rgb", "#rrggbb" or "#rrggbbaa" to 0..1 components. */
export function parseColor(hex: string): [number, number, number, number] {
    const m = /^#([0-9a-fA-F]{3,8})$/.exec(hex.trim())
    if (m === null) throw new SLError(`"${hex}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`)
    const h = m[1]
    const grab = (i: number, n: number) => parseInt(n === 1 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16) / 255
    if (h.length === 3) return [grab(0, 1), grab(1, 1), grab(2, 1), 1]
    if (h.length === 6) return [grab(0, 2), grab(1, 2), grab(2, 2), 1]
    if (h.length === 8) return [grab(0, 2), grab(1, 2), grab(2, 2), grab(3, 2)]
    throw new SLError(`"${hex}" is not a colour; use #rgb, #rrggbb or #rrggbbaa`)
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
 */
export function ramp(t: Num, stops: Array<string | [number, number, number, number]>): Vec4 {
    if (stops.length < 2) throw new SLError(`a ramp needs at least 2 stops, got ${stops.length}`)
    const tv = (typeof t === "number" ? float(t) : t).saturate()
    const cols = stops.map((c) => {
        const v = typeof c === "string" ? parseColor(c) : c
        return vec4(v[0], v[1], v[2], v[3])
    })
    const spans = stops.length - 1
    let out = cols[0]
    for (let i = 0; i < spans; i++) {
        // Local 0..1 across this span, clamped, so stops outside it contribute
        // nothing and the chain reads as "each span paints over the last".
        const local = (tv.mul(spans).sub(i) as Float).saturate()
        out = mix(out, cols[i + 1], local) as Vec4
    }
    return out
}

export const uniform = {
    float(name: string, value = 0): Float {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.FLOAT, [value]), TYPE.FLOAT)
    },
    vec2(name: string, value: [number, number] = [0, 0]): Vec2 {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.VEC2, value), TYPE.VEC2)
    },
    vec3(name: string, value: [number, number, number] = [0, 0, 0]): Vec3 {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.VEC3, value), TYPE.VEC3)
    },
    vec4(name: string, value: [number, number, number, number] = [0, 0, 0, 1]): Vec4 {
        const b = ctx()
        return mk(b, b.uniform(name, TYPE.VEC4, value), TYPE.VEC4)
    },
}

export interface Texture {
    sample(uv: Vec2): Vec4
}

export function texture(name: string): Texture {
    const b = ctx()
    const slot = b.texture(name)
    return {
        sample(uv: Vec2): Vec4 {
            if (uv.owner !== b) throw new SLError("a value from another program cannot be used in this one")
            return mk(b, b.call(SLOP.SAMPLE, TYPE.VEC4, [uv.ref], [slot]), TYPE.VEC4)
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
 * data dependent loop is out of scope, because in the VM it would need a nested
 * bounded loop with a dynamic trip count while codegen would handle it fine, and
 * the two backends agreeing is the property this whole design protects.
 */
export function repeat<T extends Val>(n: number, body: (i: number, acc: T) => T, seed: T): T {
    if (!Number.isInteger(n) || n < 0 || n > 64) {
        throw new SLError(`repeat count must be a whole number from 0 to 64, got ${n}`)
    }
    let acc = seed
    for (let i = 0; i < n; i++) acc = body(i, acc)
    return acc
}
