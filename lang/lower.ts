/**
 * AST to IR, through the EDSL.
 *
 * Phase A of `Specs/SL_TEXT.md` section 4, and the file the parity test is
 * about. Nothing here touches the Builder: `sin(x)` in a file becomes the same
 * `sl.sin(x)` call a TypeScript author would have written, so the two surfaces
 * cannot produce different graphs. That is why a `.sl` file and its EDSL twin
 * hash the same, and why the existing GPU and codegen golden tests cover the
 * text form without being told about it.
 *
 * Four things happen here that the file's author does not see:
 *
 * **Locals become SSA.** A local is a JavaScript binding holding a recorded
 * value, so `p = p * 2;` rebinds and the IR never learns that a variable
 * existed. Reassignment is free; it is not a store.
 *
 * **`for` unrolls.** The bounds are constants, so the body is lowered once per
 * iteration with the counter substituted as a number. `sl.unrolled` records the
 * span so the instruction ceiling error can name the loop that spent it.
 *
 * **`if` becomes `select`.** Both sides are lowered and every local assigned in
 * either is selected at the join. A constant condition folds instead, which is
 * the one case where a branch really does disappear.
 *
 * **Functions inline.** A call lowers the callee's body against its arguments
 * in a fresh scope. `ring(p, 0.3, 0.01)` costs exactly what writing the body
 * out would.
 *
 * A NUMBER STAYS A NUMBER as long as it can. `uv * 8` reaches the EDSL as
 * `uv.mul(8)`, not as `uv.mul(sl.float(8))`, because the first broadcasts to a
 * float2 constant and the second builds a float plus a swizzle. Same picture,
 * different graph, different hash, so the distinction is load bearing rather
 * than an optimisation.
 */

import { INPUTS, type Program, type SLType } from "../ir"
import type { SlSdfKind } from "../shapes"
import * as sl from "../sl"
import type { Num, Val } from "../sl"
import { TYPE_WIDTH, type Expr, type FuncDecl, type Stmt, type TypeName } from "./ast"
import { BUILTINS } from "./builtins"
import type { Checked } from "./check"
import { SLParseError, type Pos } from "./lexer"

/** A lowered value. A plain number is one that has not had to become a node yet. */
type LV = Val | number

interface Binding {
    /** The declared width. A reassignment has to match it. */
    width: SLType
    value: LV
}

/** How many iterations a `for` may unroll to. `sl.repeat`'s ceiling, for the same reason. */
const MAX_UNROLL = 64

class Scope {
    private readonly vars = new Map<string, Binding>()

    constructor(readonly parent: Scope | null, readonly isGlobal = false) {}

    declare(name: string, binding: Binding): void { this.vars.set(name, binding) }

    lookup(name: string): Binding | undefined {
        const own = this.vars.get(name)
        if (own !== undefined) return own
        return this.parent?.lookup(name)
    }

    /**
     * Every binding an `if` could reassign: the locals, never the globals.
     *
     * Uniforms, textures, consts and inputs live in the global scope and the
     * checker refuses assigning to any of them, so the join never has to
     * consider one.
     */
    locals(): Binding[] {
        if (this.isGlobal) return []
        const out = this.parent === null ? [] : this.parent.locals()
        for (const b of this.vars.values()) out.push(b)
        return out
    }
}

export function lower(checked: Checked): Program {
    const { unit, funcs } = checked
    const file = unit.file
    const main = unit.main!

    /**
     * Runs an EDSL call and gives its error a place in the file.
     *
     * The EDSL's messages are already the right words ("z is component 3 of a
     * vec2, which has 2"); what they lack is a line. Rethrowing here rather
     * than writing a second set of messages is what keeps the two surfaces
     * saying the same thing about the same mistake.
     */
    const at = <T,>(pos: Pos, fn: () => T): T => {
        try {
            return fn()
        } catch (e) {
            throw located(e, pos)
        }
    }

    const located = (e: unknown, pos: Pos): unknown => {
        if (e instanceof SLParseError) return e
        const raw = e instanceof Error ? e.message : String(e)
        return new SLParseError(raw.replace(/^\[onejs sl] /, ""), file, pos)
    }

    const fail: (message: string, pos: Pos, length?: number) => never =
        (message, pos, length = 1) => {
            throw new SLParseError(message, file, pos, length)
        }

    // The globals every helper below reads, built inside the recording callback
    // and held out here so a function being inlined can see them and nothing
    // else the caller had in scope.
    const global = new Scope(null, true)
    const samplers = new Map<string, sl.Texture>()
    /** Where the last `return` lowered was, so an error about it points at it. */
    let returnedAt: Pos = main.pos

    try {
        return record()
    } catch (e) {
        // Nothing should reach here with a position already: every EDSL call
        // below is wrapped. This is the net, so that a program level refusal
        // still names the file rather than arriving as a bare SLError.
        throw located(e, main.pos)
    }

    function record(): Program {
        return sl.program((inputs) => {
            for (const [name, width] of Object.entries(INPUTS)) {
                global.declare(name, { width: width as SLType, value: (inputs as never)[name] })
            }

            // Uniforms and textures take their slots in DECLARATION order, before
            // anything is lowered, so a slot is a property of the file rather than
            // of which uniform the program happens to read first. An unused
            // declaration still takes its slot and still reaches the host.
            for (const u of unit.uniforms) {
                const width = TYPE_WIDTH[u.type]
                const { components, colour } = uniformDefault(u.type, u.init)
                const raw = at(u.pos, () => declareUniform(u.name, u.type, components))
                // A hex default says the uniform IS a colour, so every read of it
                // converts, exactly as a hex literal in an expression does. Without
                // that, `#ff8040` and a uniform defaulting to `#ff8040` would be two
                // different colours in one file.
                global.declare(u.name, { width, value: colour ? at(u.pos, () => sl.toLinear(raw)) : raw })
            }

            for (const t of unit.textures) samplers.set(t.name, at(t.pos, () => sl.texture(t.name)))

            for (const c of unit.consts) {
                const v = lowerExpr(c.init, global)
                assertWidth(v, TYPE_WIDTH[c.type], c.name, c.type, c.pos)
                global.declare(c.name, { width: TYPE_WIDTH[c.type], value: v })
            }

            const out = exec(main.body, new Scope(global))
            // Checked here rather than left to `sl.program`, which would refuse it
            // in the EDSL's words ("a vec4") about a file whose types are spelled
            // float4, and from outside the reach of a position.
            if (out === undefined || typeof out === "number" || out.width !== 4) {
                const got = out === undefined ? "nothing"
                    : typeof out === "number" ? "a single number"
                    : `a ${widthType(out.width)}`
                fail(
                    `main returns a float4, a colour with alpha, and this returns ${got}. ` +
                    `Wrap it: float4(value, 1)`,
                    returnedAt, 6,
                )
            }
            return out as never
        })
    }

    // MARK: declarations

    function declareUniform(name: string, type: TypeName, c: number[]): Val {
        switch (type) {
            case "float": return sl.uniform.float(name, c[0]!) as unknown as Val
            case "float2": return sl.uniform.vec2(name, [c[0]!, c[1]!]) as unknown as Val
            case "float3": return sl.uniform.vec3(name, [c[0]!, c[1]!, c[2]!]) as unknown as Val
            case "float4": return sl.uniform.vec4(name, [c[0]!, c[1]!, c[2]!, c[3]!]) as unknown as Val
        }
    }

    /**
     * A uniform's default, folded to numbers.
     *
     * LITERALS ONLY, deliberately. The default is baked into the program before
     * anything runs and it is what the generated shader writes into its
     * Properties block, so it cannot depend on a value. Refusing identifiers
     * outright also side steps an ordering puzzle nobody would enjoy: a const
     * may read a uniform, so letting a uniform read a const would make the two
     * tables depend on each other.
     */
    function uniformDefault(type: TypeName, init: Expr | null): { components: number[]; colour: boolean } {
        const width = TYPE_WIDTH[type]
        if (init === null) {
            const zeros = new Array<number>(width).fill(0)
            if (width === 4) zeros[3] = 1
            return { components: zeros, colour: false }
        }
        if (init.k === "hex") {
            if (width < 3) {
                fail(
                    `a colour has three or four components, so ${type} cannot default to ${init.hex}`,
                    init.pos, init.hex.length,
                )
            }
            const c = at(init.pos, () => sl.parseColor(init.hex))
            return { components: c.slice(0, width), colour: true }
        }
        const c = constantComponents(init)
        if (c === null) {
            fail(
                "a uniform's default is baked into the program before anything runs, so it has to be " +
                "written out: a number, a float2, float3 or float4 of numbers, or a colour like #ff8040",
                init.pos,
            )
        }
        if (c.length !== width) {
            fail(
                `this default has ${c.length} component${c.length === 1 ? "" : "s"} and the uniform is ` +
                `declared ${type}`,
                init.pos,
            )
        }
        return { components: c, colour: false }
    }

    /** The literal arithmetic a uniform default is allowed to be, or nothing. */
    function constantComponents(e: Expr): number[] | null {
        switch (e.k) {
            case "num": return [e.value]
            case "unary": {
                const v = constantComponents(e.arg)
                if (v === null) return null
                if (e.op === "+") return v
                if (e.op === "-") return v.map((n) => -n)
                return v.map((n) => 1 - n)
            }
            case "binary": {
                const a = constantComponents(e.a)
                const b = constantComponents(e.b)
                if (a === null || b === null) return null
                if (!isArith(e.op)) return null
                const fold = ARITH[e.op]
                const n = Math.max(a.length, b.length)
                if (a.length !== b.length && a.length !== 1 && b.length !== 1) return null
                const out: number[] = []
                for (let i = 0; i < n; i++) out.push(fold(a[a.length === 1 ? 0 : i]!, b[b.length === 1 ? 0 : i]!))
                return out
            }
            case "call": {
                if (e.callee.k !== "ident" || !(e.callee.name in TYPE_WIDTH)) return null
                const width = TYPE_WIDTH[e.callee.name as TypeName]
                const parts: number[] = []
                for (const a of e.args) {
                    const v = constantComponents(a)
                    if (v === null) return null
                    parts.push(...v)
                }
                if (parts.length === 1 && width > 1) return new Array<number>(width).fill(parts[0]!)
                return parts.length === width ? parts : null
            }
            default: return null
        }
    }

    // MARK: statements

    /** Runs a body. The value of its `return`, or nothing when it has none. */
    function exec(body: Stmt[], scope: Scope): LV | undefined {
        for (const s of body) {
            switch (s.k) {
                case "var":
                case "const": {
                    const v = lowerExpr(s.init, scope)
                    assertWidth(v, TYPE_WIDTH[s.type], s.name, s.type, s.pos)
                    scope.declare(s.name, { width: TYPE_WIDTH[s.type], value: v })
                    break
                }
                case "assign": {
                    const name = (s.target as Extract<Expr, { k: "ident" }>).name
                    const b = scope.lookup(name)!
                    let v = lowerExpr(s.value, scope)
                    if (s.op !== "=") {
                        const op = s.op[0] as ArithOp
                        v = at(s.pos, () => arithmetic(op, b.value, v, s.pos))
                    }
                    assertWidth(v, b.width, name, widthType(b.width), s.pos)
                    b.value = v
                    break
                }
                case "if": {
                    const cond = lowerExpr(s.cond, scope)
                    if (typeof cond === "number") {
                        // The one case where a branch really does vanish: the
                        // other side is never lowered, so it costs nothing.
                        exec(cond >= 0.5 ? s.then : s.else, new Scope(scope))
                        break
                    }
                    const locals = scope.locals()
                    const before = locals.map((b) => b.value)
                    exec(s.then, new Scope(scope))
                    const whenTrue = locals.map((b) => b.value)
                    locals.forEach((b, i) => { b.value = before[i]! })
                    exec(s.else, new Scope(scope))
                    const whenFalse = locals.map((b) => b.value)
                    locals.forEach((b, i) => {
                        const t = whenTrue[i]!
                        const f = whenFalse[i]!
                        b.value = same(t, f) ? t : at(s.pos, () => sl.select(cond, t, f))
                    })
                    break
                }
                case "for": {
                    const from = constantBound(s.from, "start", scope)
                    const to = constantBound(s.to, "bound", scope)
                    const step = constantBound(s.step, "step", scope)
                    if (!(step > 0)) {
                        fail(
                            `this loop steps by ${step}, so it never ends. A for loop unrolls, which ` +
                            `means its count has to be known and finite`,
                            s.pos,
                        )
                    }
                    let count = 0
                    for (let i = from; s.inclusive ? i <= to : i < to; i += step) {
                        count++
                        if (count > MAX_UNROLL) {
                            fail(
                                `this loop would unroll to more than ${MAX_UNROLL} iterations. There is ` +
                                `no loop on either backend, so every iteration is emitted in full and ` +
                                `the VM runs at most 256 instructions`,
                                s.pos,
                            )
                        }
                    }
                    at(s.pos, () => sl.unrolled(count, () => {
                        for (let i = from; s.inclusive ? i <= to : i < to; i += step) {
                            const inner = new Scope(scope)
                            inner.declare(s.counter, { width: 1, value: i })
                            exec(s.body, inner)
                        }
                    }))
                    break
                }
                case "return":
                    returnedAt = s.pos
                    return lowerExpr(s.value, scope)
            }
        }
        return undefined
    }

    function constantBound(e: Expr, what: string, scope: Scope): number {
        const v = lowerExpr(e, scope)
        if (typeof v !== "number") {
            fail(
                `a for loop unrolls at build time, so its ${what} has to be a constant. This one is ` +
                `computed while the shader runs, and neither backend has a loop to run it in`,
                e.pos,
            )
        }
        return v
    }

    /** Two lowered values that are certainly the same node, so a join can skip the select. */
    function same(a: LV, b: LV): boolean {
        if (a === b) return true
        return typeof a !== "number" && typeof b !== "number" && a.ref === b.ref && a.width === b.width
    }

    function assertWidth(v: LV, want: SLType, name: string, type: TypeName, pos: Pos): void {
        const got = typeof v === "number" ? 1 : v.width
        if (got === want) return
        // A declaration is an assertion, not an input to inference
        // (`Specs/SL_TEXT.md` 3.2), so this says which half is wrong rather
        // than quietly promoting one to the other.
        const hint = got === 1 ? ` Wrap it in ${type}(...) to broadcast the value across ${want} components.` : ""
        fail(`${name} is declared ${type} and this is a ${widthType(got as SLType)}.${hint}`, pos)
    }

    // MARK: expressions

    function lowerExpr(e: Expr, scope: Scope): LV {
        switch (e.k) {
            case "num": return e.value
            case "hex": return at(e.pos, () => sl.color(e.hex) as unknown as Val)
            case "ident": {
                const b = scope.lookup(e.name)
                if (b === undefined) fail(`"${e.name}" is not declared`, e.pos, e.name.length)
                return b.value
            }
            case "member": {
                const obj = lowerExpr(e.obj, scope)
                return at(e.pos, () => asVal(obj).swz(e.name) as unknown as Val)
            }
            case "unary": {
                const v = lowerExpr(e.arg, scope)
                if (e.op === "+") return v
                if (e.op === "-") return typeof v === "number" ? -v : at(e.pos, () => v.neg())
                return oneMinus(v, e.pos)
            }
            case "binary": return lowerBinary(e, scope)
            case "cond": {
                const cond = lowerExpr(e.cond, scope)
                if (typeof cond === "number") {
                    return lowerExpr(cond >= 0.5 ? e.then : e.else, scope)
                }
                const t = lowerExpr(e.then, scope)
                const f = lowerExpr(e.else, scope)
                return at(e.pos, () => sl.select(cond, t, f))
            }
            case "call": return lowerCall(e, scope)
        }
    }

    function lowerBinary(e: Extract<Expr, { k: "binary" }>, scope: Scope): LV {
        const a = lowerExpr(e.a, scope)
        const b = lowerExpr(e.b, scope)
        const pos = e.pos
        return at(pos, () => {
            switch (e.op) {
                case "+": case "-": case "*": case "/": case "%":
                    return arithmetic(e.op, a, b, pos)
                // Comparisons and logic are arithmetic the IR already has, as
                // `Specs/SL_TEXT.md` 3.5 lays out. Nothing here branches, and
                // every result is a float that is 0 or 1.
                case "<=": return sl.step(a, b)
                case ">=": return sl.step(b, a)
                case "<": return oneMinus(sl.step(b, a), pos)
                case ">": return oneMinus(sl.step(a, b), pos)
                case "==": return oneMinus(notEqual(a, b, pos), pos)
                case "!=": return notEqual(a, b, pos)
                case "&&": return typeof a === "number" && typeof b === "number"
                    ? Math.min(a, b) : asVal(a).min(b)
                case "||": return typeof a === "number" && typeof b === "number"
                    ? Math.max(a, b) : asVal(a).max(b)
            }
        })
    }

    /** `abs(sign(a - b))`: 0 when equal, 1 otherwise, component wise. */
    function notEqual(a: LV, b: LV, pos: Pos): LV {
        const d = arithmetic("-", a, b, pos)
        if (typeof d === "number") return Math.abs(Math.sign(d))
        return sl.sign(d).abs()
    }

    function oneMinus(v: LV, pos: Pos): LV {
        if (typeof v === "number") return 1 - v
        return at(pos, () => sl.float(1).sub(v))
    }

    function arithmetic(op: ArithOp, a: LV, b: LV, pos: Pos): LV {
        if (typeof a === "number" && typeof b === "number") {
            if ((op === "/" || op === "%") && b === 0) {
                fail(`this divides ${a} by zero, and the result would not be a number`, pos)
            }
            return ARITH[op](a, b)
        }
        const m = METHOD[op]
        // A scalar on the LEFT has to become a value first, so it broadcasts
        // through a swizzle rather than as a wide constant. That is what
        // `sl.float(n).sub(v)` does too, and the two forms have to agree.
        return asVal(a)[m](b)
    }

    function lowerCall(e: Extract<Expr, { k: "call" }>, scope: Scope): LV {
        const callee = e.callee

        if (callee.k === "member") {
            const shape = callee.name as SlSdfKind
            const p = lowerExpr(e.args[0]!, scope)
            if (typeof p === "number" || p.width !== 2) {
                fail(`sdf.${shape} measures the distance to a point, so it takes a float2`, e.args[0]!.pos)
            }
            const params: number[] = []
            for (const a of e.args.slice(1)) {
                const v = lowerExpr(a, scope)
                if (typeof v !== "number") {
                    fail(
                        `sdf.${shape}'s shape parameters ride inside the instruction, so they have to ` +
                        `be constants. A size that changes belongs on the point: scale or offset it ` +
                        `before the call`,
                        a.pos,
                    )
                }
                params.push(v)
            }
            return at(e.pos, () => sl.sdf(shape, p as never, params))
        }

        const n = (callee as Extract<Expr, { k: "ident" }>).name

        if (n in TYPE_WIDTH) {
            return construct(n as TypeName, e.args.map((a) => lowerExpr(a, scope)), e.pos)
        }

        if (n === "tex2D") {
            const texName = (e.args[0] as Extract<Expr, { k: "ident" }>).name
            const tex = samplers.get(texName)!
            const uv = lowerExpr(e.args[1]!, scope)
            if (typeof uv === "number" || uv.width !== 2) {
                fail("tex2D samples at a float2", e.args[1]!.pos)
            }
            return at(e.pos, () => tex.sample(uv as never) as unknown as Val)
        }

        if (n === "ramp") {
            const t = lowerExpr(e.args[0]!, scope)
            const stops: string[] = []
            for (const a of e.args.slice(1)) {
                if (a.k !== "hex") {
                    fail(
                        "a ramp's stops are constants, written as colours: `ramp(t, #000018, #0080ff, " +
                        "#ffffff)`. A stop that changes wants lerp between two uniforms instead",
                        a.pos,
                    )
                }
                stops.push(a.hex)
            }
            return at(e.pos, () => sl.ramp(t, stops) as unknown as Val)
        }

        const builtin = BUILTINS[n]
        if (builtin !== undefined) {
            const args = e.args.map((a) => lowerExpr(a, scope))
            return at(e.pos, () => builtin.lower!(args as Num[]))
        }

        const fn = funcs.get(n)!
        return inline(fn, e.args.map((a) => lowerExpr(a, scope)), e)
    }

    /**
     * Inlines a call: the body, lowered against these arguments, in a fresh
     * scope that can see the globals and nothing else the caller had.
     */
    function inline(fn: FuncDecl, args: LV[], e: Extract<Expr, { k: "call" }>): LV {
        const scope = new Scope(global)
        fn.params.forEach((p, i) => {
            const v = args[i]!
            const got = typeof v === "number" ? 1 : v.width
            if (got !== TYPE_WIDTH[p.type]) {
                fail(
                    `${fn.name}'s parameter ${p.name} is a ${p.type} and this argument is a ` +
                    `${widthType(got as SLType)}`,
                    e.args[i]!.pos,
                )
            }
            scope.declare(p.name, { width: TYPE_WIDTH[p.type], value: v })
        })
        const out = exec(fn.body, scope)
        if (out === undefined) fail(`${fn.name} never returns a value`, e.pos)
        const got = typeof out === "number" ? 1 : out.width
        if (got !== TYPE_WIDTH[fn.ret]) {
            fail(`${fn.name} is declared to return a ${fn.ret} and returns a ${widthType(got as SLType)}`, fn.pos)
        }
        return out
    }

    function construct(type: TypeName, args: LV[], pos: Pos): LV {
        const width = TYPE_WIDTH[type]
        if (width === 1) {
            const v = args[0]!
            const got = typeof v === "number" ? 1 : v.width
            if (args.length !== 1 || got !== 1) {
                fail("float(x) takes one float; use a swizzle to narrow a wider value", pos)
            }
            return v
        }
        if (args.length === 1) {
            const v = args[0]!
            const got = typeof v === "number" ? 1 : v.width
            // HLSL's scalar broadcast, and the identity for a value that is
            // already this wide. `float4(v4)` is `v4`, not four swizzles.
            if (got === width) return v
            if (got === 1) return at(pos, () => compose(width, new Array<LV>(width).fill(v)))
            fail(`${type}(v) broadcasts a float; a ${widthType(got as SLType)} needs its components spelled out`, pos)
        }
        return at(pos, () => compose(width, args))
    }

    function compose(width: SLType, parts: LV[]): Val {
        const ps = parts as Num[]
        if (width === 2) return sl.vec2(...ps) as unknown as Val
        if (width === 3) return sl.vec3(...ps) as unknown as Val
        return sl.vec4(...ps) as unknown as Val
    }

    function asVal(v: LV): Val {
        return typeof v === "number" ? (sl.float(v) as unknown as Val) : v
    }
}

type ArithOp = "+" | "-" | "*" | "/" | "%"

const ARITH: Record<ArithOp, (a: number, b: number) => number> = {
    "+": (a, b) => a + b,
    "-": (a, b) => a - b,
    "*": (a, b) => a * b,
    "/": (a, b) => a / b,
    // JavaScript's % is the truncated remainder, which is what HLSL's fmod is
    // and what the VM's OP_MOD implements. Folding it in JS is the same answer.
    "%": (a, b) => a % b,
}

const METHOD: Record<ArithOp, "add" | "sub" | "mul" | "div" | "mod"> = {
    "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
}

function isArith(op: string): op is ArithOp {
    return op in ARITH
}

function widthType(w: SLType): TypeName {
    return (["float", "float2", "float3", "float4"] as const)[w - 1]!
}

