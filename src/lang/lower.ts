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
 * Five things happen here that the file's author does not see:
 *
 * **Locals become SSA.** A local is a JavaScript binding holding a recorded
 * value, so `p = p * 2;` rebinds and the IR never learns that a variable
 * existed. Reassignment is free; it is not a store.
 *
 * **`if` is a real branch** (`sl.branch`). Both sides are lowered, and every
 * local either side changes comes out of the branch, which runs only the side
 * its condition picks. A constant condition folds instead, and the other side
 * is never lowered. What follows an if whose one side always returns goes into
 * the other side, so `if (far) return clear;` skips the rest of the function.
 *
 * **Leaving early is carried as flags.** A return, a break or a continue that
 * only some ways through reach sets a flag, and everything after it runs under
 * a branch on that flag. So no statement is ever printed that returns or
 * breaks, and every emitter prints the same structured body.
 *
 * **A `for` unrolls when it can**: when its turns are known at build time, are
 * 64 or fewer, and nothing in it leaves early. Otherwise it is a real loop
 * (`sl.loop`) carrying the locals its body changes, with a turn limit that
 * guarantees it stops: the count its constant bound gives, or its uniform
 * bound's Range, or 1024.
 *
 * **Functions inline.** A call lowers the callee's body against its arguments
 * in a fresh scope. `ring(p, 0.3, 0.01)` costs exactly what writing the body
 * out would.
 *
 * A NUMBER STAYS A NUMBER as long as it can. `uv * 8` reaches the EDSL as
 * `uv.mul(8)`, not as `uv.mul(sl.float(8))`, because the first broadcasts to a
 * float2 constant and the second builds a float plus a swizzle. Same picture,
 * different graph, different hash, so the distinction is load bearing rather
 * than an optimisation. An int constant is a bigint, a uint constant a `Uint`
 * and a bool constant a boolean for the same reason: folded until something
 * needs a node.
 *
 * A COMPARISON WAITS to be used (`Test`). Where arithmetic or a `?:` reads it,
 * it is the float that is 0 or 1 it always was, built the way it always was,
 * so a program that uses no new construct keeps its graph and its hash. Where
 * an if, a loop or a bool local reads it, it is a bool.
 */

import {
    controlProblem, DERIVED_INPUTS, INPUTS, RAMP_STOP_COMPUTED, truncateHeld, writtenColour,
    type Program, type SLKind, type SLType, type UniformControl,
} from "../ir"
import { SLOP } from "../ops"
import type { SlSdfKind } from "../shapes"
import * as sl from "../sl"
import { Val, type Num } from "../sl"
import { TYPE_KIND, TYPE_WIDTH, type BinaryOp, type Expr, type FuncDecl, type Stmt, type TypeName } from "./ast"
import { readAttributes } from "./attributes"
import { BUILTINS } from "./builtins"
import { terminates, type Checked } from "./check"
import { SLParseError, type Pos } from "./lexer"

/**
 * A comparison, or logic over comparisons, held until its use says which form
 * it takes: `float`, the 0 or 1 every program built before bools existed, or
 * `bool`, for an if, a loop and a bool local. Each is built once, when first read.
 */
class Test {
    private f: number | Val | undefined
    private b: boolean | Val | undefined
    constructor(
        readonly width: SLType,
        private readonly makeFloat: () => number | Val,
        private readonly makeBool: () => boolean | Val,
    ) {}
    get float(): number | Val { return this.f ??= this.makeFloat() }
    get bool(): boolean | Val { return this.b ??= this.makeBool() }
}

/**
 * A uint constant, 0 to 2^32 - 1, not yet a node. A bigint is already an int,
 * so a uint needs a form of its own to fold the way an int does.
 */
class Uint {
    readonly v: bigint
    /**
     * Any whole number, wrapped to 32 bits as a uint wraps. By a mask, not
     * `BigInt.asUintN`, which QuickJS-ng answers with a negative from 2^31 up.
     */
    constructor(v: bigint) { this.v = v & 0xffffffffn }
}

/**
 * A lowered value. A number is a float, a bigint an int, a Uint a uint and a
 * boolean a bool, none of which has had to become a node yet; a Test is a
 * comparison not yet either of its forms.
 */
type LV = Val | number | bigint | Uint | boolean | Test

/** A declared type: its width, and its kind when it is not floats. */
interface VType { width: SLType; kind: SLKind | undefined }

interface Binding extends VType {
    /** Always of the declared type: a Test is resolved and an int is a bigint or an int node, a uint a Uint or a uint node. */
    value: LV
}

/**
 * Where a function body is: its return type, and whether, on the ways through
 * so far, it has returned (and with what), broken out of the innermost loop, or
 * continued it. Each flag is a constant until only some ways through set it.
 */
interface Frame {
    fn: FuncDecl
    ret: VType
    returned: boolean | Val
    retval: LV | null
    broke: boolean | Val
    continued: boolean | Val
}

/** How many iterations a `for` may unroll to. `sl.repeat`'s ceiling, for the same reason. */
const MAX_UNROLL = 64

/** The turn limit of a loop whose bound says nothing about how many turns it takes. */
const DEFAULT_TURNS = 1024

class Scope {
    private readonly vars = new Map<string, Binding>()

    constructor(readonly parent: Scope | null, readonly isGlobal = false) {}

    declare(name: string, binding: Binding): void { this.vars.set(name, binding) }

    lookup(name: string): Binding | undefined {
        const own = this.vars.get(name)
        if (own !== undefined) return own
        return this.parent?.lookup(name)
    }

    /** Whether `name` is a local here, rather than a global or nothing. */
    isLocal(name: string): boolean {
        if (this.isGlobal) return false
        return this.vars.has(name) || (this.parent?.isLocal(name) ?? false)
    }

    /**
     * Every binding a branch or a loop could change: the locals, never the globals.
     *
     * Uniforms, textures, consts and inputs live in the global scope and the
     * checker refuses assigning to any of them, so a join never has to
     * consider one.
     */
    locals(): Binding[] {
        if (this.isGlobal) return []
        const out = this.parent === null ? [] : this.parent.locals()
        for (const b of this.vars.values()) out.push(b)
        return out
    }
}

/**
 * `errors`, when given, collects every error lowering finds and carries on past
 * each, one statement or declaration at a time, for `diagnose`. The program it
 * returns then is not one to draw.
 */
export function lower(checked: Checked, errors?: SLParseError[]): Program {
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
        return new SLParseError(inFileWords(raw.replace(/^\[onejs sl] /, "")), file, pos)
    }

    const fail: (message: string, pos: Pos, length?: number) => never =
        (message, pos, length = 1) => {
            throw new SLParseError(message, file, pos, length)
        }

    /**
     * Collecting, runs one statement or declaration, recording its error and
     * returning `fallback()` instead of throwing. The fallback declares what the
     * broken line would have, so a later use of that name is not a second error.
     */
    const recover = <T,>(step: () => T, fallback: () => T): T => {
        if (errors === undefined) return step()
        try {
            return step()
        } catch (e) {
            if (!(e instanceof SLParseError)) throw e
            errors.push(e)
            return fallback()
        }
    }

    /** A zero of a type, standing in for a value whose line was refused, and for a return not yet made. */
    const blank = (t: VType, pos: Pos): LV => {
        if (t.kind === "int") return 0n
        if (t.kind === "bool") return false
        if (t.kind === "uint") return new Uint(0n)
        return t.width === 1 ? 0 : at(pos, () => compose(t.width, new Array<LV>(t.width).fill(0)))
    }

    // The globals every helper below reads, built inside the recording callback
    // and held out here so a function being inlined can see them and nothing
    // else the caller had in scope.
    const global = new Scope(null, true)
    const samplers = new Map<string, sl.Texture>()

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
                global.declare(name, { width: width as SLType, kind: undefined, value: (inputs as never)[name] })
            }
            // Read through, so a program that never names one records nothing
            // for it. The setter only serves a refused assignment, which the
            // checker has already reported and lowering carries on past.
            for (const [name, width] of Object.entries(DERIVED_INPUTS)) {
                let value: LV | undefined
                global.declare(name, {
                    width: width as SLType,
                    kind: undefined,
                    get value() { return value ??= (inputs as never)[name] },
                    set value(v: LV) { value = v },
                })
            }

            // Uniforms and textures take their slots in DECLARATION order, before
            // anything is lowered, so a slot is a property of the file rather than
            // of which uniform the program happens to read first. An unused
            // declaration still takes its slot and still reaches the host.
            for (const u of unit.uniforms) {
                const width = TYPE_WIDTH[u.type]
                const { components, colour } = recover(
                    () => uniformDefault(u.type, u.init, u.pos),
                    () => ({ ...uniformDefault("float", null, u.pos), colour: false }),
                )
                // A hex default says the uniform IS a colour, so every read of it
                // converts, exactly as a hex literal in an expression does. Without
                // that, `#ff8040` and a uniform defaulting to `#ff8040` would be two
                // different colours in one file. `sl.uniform.colour` also marks
                // the declaration, for a host's colour picker.
                // What the attributes say the control is, and whether the default
                // fits it, marked on the attribute that does not fit.
                const read = readAttributes(u)
                const problem = recover(() => {
                    const p = controlProblem(width as SLType, components, read.control)
                    const attr = p === null ? undefined : read.from[p.field]
                    if (p !== null) fail(inFileWords(p.message), attr?.pos ?? u.pos, attr?.length ?? 1)
                    return false
                }, () => true)
                const control = problem ? {} : read.control
                // `[Color]` says the same as a hex default, for a default written as numbers.
                const value = (colour && u.init?.k === "hex") || read.colour
                    ? at(u.pos, () => sl.uniform.colour(u.name, components, width as 3 | 4, control) as unknown as Val)
                    : at(u.pos, () => declareUniform(u.name, u.type, components, control))
                global.declare(u.name, { width, kind: TYPE_KIND[u.type], value })
            }

            for (const t of unit.textures) samplers.set(t.name, at(t.pos, () => sl.texture(t.name)))

            for (const c of unit.consts) {
                const t = typeOf(c.type)
                const v = recover(() => fit(lowerExpr(c.init, global, want(t)), t, c.name, c.pos), () => blank(t, c.pos))
                global.declare(c.name, { ...t, value: v })
            }

            const out = callBody(main, new Scope(global))
            // What a refused line left behind is not the program's colour.
            if (errors !== undefined && errors.length > 0) return blank({ width: 4, kind: undefined }, main.pos) as never
            return out as never
        })
    }

    // MARK: declarations

    function declareUniform(name: string, type: TypeName, c: number[], control: UniformControl): Val {
        switch (type) {
            case "float": return sl.uniform.float(name, c[0]!, control) as unknown as Val
            case "float2": return sl.uniform.vec2(name, [c[0]!, c[1]!], control) as unknown as Val
            case "float3": return sl.uniform.vec3(name, [c[0]!, c[1]!, c[2]!], control) as unknown as Val
            case "float4": return sl.uniform.vec4(name, [c[0]!, c[1]!, c[2]!, c[3]!], control) as unknown as Val
            // A float slot, as every host binds, read as the whole number it holds.
            case "int": return sl.uniform.int(name, c[0]!, control) as unknown as Val
            case "uint":
            case "bool": throw new Error(`the checker let a ${type} uniform through`)
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
    function uniformDefault(type: TypeName, init: Expr | null, pos: Pos): { components: number[]; colour: boolean } {
        if (type === "uint" || type === "bool") {
            fail(
                `a uniform is a float, a float vector or an int, so not a ${type}. ` +
                (type === "bool" ? "For an on and off switch, write [Toggle] uniform float" : "Write uniform int"),
                pos, 7,
            )
        }
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
        if (type === "int" && (c.length !== 1 || !Number.isInteger(c[0]))) {
            fail("an int uniform's default is one whole number", init.pos)
        }
        if (c.length === 1 && width > 1) return { components: new Array<number>(width).fill(c[0]!), colour: false }
        if (c.length === 4 && width === 3) return { components: c.slice(0, 3), colour: false }
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
                if (e.op === "!") return v.map((n) => 1 - n)
                return null
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

    // MARK: functions

    /** A function's body run to its return, in `scope`, which holds its parameters. */
    function callBody(fn: FuncDecl, scope: Scope): LV {
        const frame: Frame = { fn, ret: typeOf(fn.ret), returned: false, retval: null, broke: false, continued: false }
        exec(fn.body, scope, frame)
        if (errors !== undefined && errors.length > 0) return frame.retval ?? blank(frame.ret, fn.pos)
        // The checker proved every way through returns, and the flags carry
        // that through to a constant; anything else is this file's mistake.
        if (frame.returned !== true || frame.retval === null) throw new Error(`${fn.name} lowered to a body that does not always return`)
        return frame.retval
    }

    // MARK: statements

    /**
     * Runs a body. What it does to the locals is in their bindings and what it
     * does to the flow (a return, a break) is in `frame`.
     */
    function exec(body: Stmt[], scope: Scope, frame: Frame): void {
        for (let i = 0; i < body.length; i++) {
            const stop = stopped(frame)
            if (stop === true) return
            if (stop !== false) {
                // Some ways through what came before left early and some did
                // not: the rest runs only on the ones that did not.
                const rest = body.slice(i)
                fork(stop, scope, frame, () => knownStopped(frame), () => {
                    frame.returned = false
                    frame.broke = false
                    frame.continued = false
                    exec(rest, new Scope(scope), frame)
                })
                return
            }
            const s = body[i]!
            if (s.k === "if") {
                if (recover(() => runIf(s, body.slice(i + 1), scope, frame), () => false)) return
                continue
            }
            if (s.k === "var" || s.k === "const") {
                const t = typeOf(s.type)
                const v = recover(() => fit(lowerExpr(s.init, scope, want(t)), t, s.name, s.pos), () => blank(t, s.pos))
                scope.declare(s.name, { ...t, value: v })
                continue
            }
            recover(() => run(s, scope, frame), () => undefined)
        }
    }

    /** Whether the ways through so far have left: a constant when they agree, a bool when they part. */
    function stopped(frame: Frame): boolean | Val {
        return orBool(orBool(frame.returned, frame.broke), frame.continued)
    }

    /**
     * On the side of a join where the flow is known to have left: when only one
     * flag could have done it, that flag is true there, which is what lets a
     * body whose every way returns end with `returned` the constant true.
     */
    function knownStopped(frame: Frame): void {
        const live = (["returned", "broke", "continued"] as const).filter((f) => frame[f] !== false)
        if (live.length === 1) frame[live[0]!] = true
    }

    /**
     * An if. Returns whether it also ran `rest`, the statements after it, which
     * it does when exactly one side always leaves: the rest then belongs to the
     * other side, and runs only there.
     */
    function runIf(s: Extract<Stmt, { k: "if" }>, rest: Stmt[], scope: Scope, frame: Frame): boolean {
        const cond = control(lowerExpr(s.cond, scope), "an if", s.cond.pos)
        if (typeof cond === "boolean") {
            // The one case where a side really does vanish: it is never lowered.
            exec(cond ? s.then : s.else, new Scope(scope), frame)
            return false
        }
        const thenEnds = terminates(s.then)
        const elseEnds = terminates(s.else)
        const side = (body: Stmt[], withRest: boolean) => () => {
            exec(body, new Scope(scope), frame)
            if (withRest) exec(rest, new Scope(scope), frame)
        }
        fork(cond, scope, frame, side(s.then, elseEnds && !thenEnds), side(s.else, thenEnds && !elseEnds), s.pos)
        return thenEnds || elseEnds
    }

    /**
     * Runs both sides of a branch on `cond` and joins them: every local and
     * flag the two leave different comes out of one `sl.branch`.
     */
    function fork(cond: Val, scope: Scope, frame: Frame, whenTrue: () => void, whenFalse: () => void, pos: Pos = frame.fn.pos): void {
        const locals = scope.locals()
        const snap = () => ({
            values: locals.map((b) => b.value),
            returned: frame.returned, retval: frame.retval, broke: frame.broke, continued: frame.continued,
        })
        const restore = (st: ReturnType<typeof snap>) => {
            locals.forEach((b, i) => { b.value = st.values[i]! })
            frame.returned = st.returned
            frame.retval = st.retval
            frame.broke = st.broke
            frame.continued = st.continued
        }
        const before = snap()
        whenTrue()
        const t = snap()
        restore(before)
        whenFalse()
        const f = snap()

        interface Slot { type: VType; t: LV; f: LV; set: (v: LV) => void }
        const slots: Slot[] = []
        locals.forEach((b, i) => slots.push({ type: b, t: t.values[i]!, f: f.values[i]!, set: (v) => { b.value = v } }))
        const flag = (name: "returned" | "broke" | "continued") =>
            slots.push({ type: BOOL, t: t[name], f: f[name], set: (v) => { frame[name] = v as boolean | Val } })
        flag("returned")
        flag("broke")
        flag("continued")
        if (t.retval !== null || f.retval !== null) {
            slots.push({
                type: frame.ret, t: t.retval ?? blank(frame.ret, pos), f: f.retval ?? blank(frame.ret, pos),
                set: (v) => { frame.retval = v },
            })
        }
        const differ = slots.filter((x) => !same(x.t, x.f))
        for (const x of slots) if (!differ.includes(x)) x.set(x.t)
        if (differ.length === 0) return
        const out = at(pos, () => sl.branch(cond, () => differ.map((x) => node(x.t, x.type)), () => differ.map((x) => node(x.f, x.type))))
        differ.forEach((x, i) => x.set(out[i]!))
    }

    /** An assignment, a loop, a switch, a block, a return, a break or a continue. */
    function run(s: Stmt, scope: Scope, frame: Frame): void {
        switch (s.k) {
            case "assign": assign(s, scope); break
            case "for":
            case "while": runLoop(s, scope, frame); break
            case "switch": exec([switchAsIf(s, scope)], scope, frame); break
            case "block": exec(s.body, new Scope(scope), frame); break
            case "return": {
                const v = lowerExpr(s.value, scope, want(frame.ret))
                frame.retval = returned(v, frame, s.pos)
                frame.returned = true
                break
            }
            case "break": frame.broke = true; break
            case "continue": frame.continued = true; break
            default: break
        }
    }

    function assign(s: Extract<Stmt, { k: "assign" }>, scope: Scope): void {
        // The checker allowed exactly two shapes: a local, or a swizzle of one
        // with no component named twice.
        const member = s.target.k === "member" ? s.target : null
        const name = ((member?.obj ?? s.target) as Extract<Expr, { k: "ident" }>).name
        const b = scope.lookup(name)!
        // `x op= v` is `x = x op v`, so a whole number beside an int local is an
        // int. The value is lowered before the local is read, as it always was.
        let v: LV
        if (s.op === "=") {
            v = lowerExpr(s.value, scope, want(b))
        } else {
            const op = s.op.slice(0, -1) as BinaryOp
            const inner = operandWant(op, want(b))
            const value = lowerExpr(s.value, scope, inner)
            const old = lowerExpr(member ?? s.target, scope, inner)
            v = combine(op, old, value, member ?? s.target, s.value, scope, s.pos)
        }
        if (member !== null) {
            if (b.kind !== undefined) fail(`${name} is ${article(b)} ${typeName(b)}, which has no components to write`, member.pos)
            v = writeComponents(b, member, toFloat(v, s.pos), s.pos)
        }
        b.value = fit(v, b, name, s.pos)
    }

    /** A return's value as the function's type. Only the kind converts; a width has to match. */
    function returned(v: LV, frame: Frame, pos: Pos): LV {
        const fn = frame.fn
        const t = frame.ret
        const got = widthOf(v)
        if (got !== t.width) {
            if (fn === main) {
                const what = isConstant(v) ? "a single number" : `a ${widthType(got)}`
                fail(`main returns a float4, a colour with alpha, and this returns ${what}. Wrap it: float4(value, 1)`, pos, 6)
            }
            fail(`${fn.name} is declared to return a ${fn.ret} and returns a ${widthType(got)}`, fn.pos)
        }
        return fit(v, t, `${fn.name}'s result`, pos)
    }

    // MARK: loops

    function runLoop(s: Extract<Stmt, { k: "for" | "while" }>, scope: Scope, frame: Frame): void {
        const loopScope = new Scope(scope)
        let counter: Binding | null = null
        if (s.k === "for") {
            const t = typeOf(s.type)
            if (t.width !== 1 || t.kind === "bool") fail(`a loop counts with an int, a uint or a float, and this is ${article(t)} ${s.type}`, s.pos)
            counter = { ...t, value: fit(lowerExpr(s.from, scope, want(t)), t, s.counter, s.pos) }
            loopScope.declare(s.counter, counter)
            const turns = leavesEarly(s.body) || readsAny([s.cond, s.update.value], assignedIn(s.body)) ? null : countTurns(s, loopScope, counter, MAX_UNROLL)
            if (turns !== null && turns.length <= MAX_UNROLL) {
                at(s.pos, () => {
                    for (const v of turns) {
                        const inner = new Scope(loopScope)
                        inner.declare(s.counter, { ...t, value: v })
                        exec(s.body, inner, frame)
                    }
                })
                return
            }
        }

        // A real loop, carrying the locals its body changes and whichever
        // flags its body can set.
        const names = assignedIn(s.body)
        const carried = [...names].filter((n) => scope.isLocal(n)).map((n) => scope.lookup(n)!)
        const hasBreak = breaksOut(s.body)
        const hasReturn = returnsIn(s.body)
        const outer = frame.retval
        const init: Array<{ v: LV; t: VType }> = []
        if (counter !== null) init.push({ v: counter.value, t: counter })
        for (const b of carried) init.push({ v: b.value, t: b })
        if (hasBreak) init.push({ v: false, t: BOOL })
        if (hasReturn) init.push({ v: false, t: BOOL }, { v: outer ?? blank(frame.ret, s.pos), t: frame.ret })
        const max = s.k === "for" ? turnLimit(s, loopScope, counter!) : DEFAULT_TURNS

        const out = at(s.pos, () => sl.loop(init.map((x) => node(x.v, x.t)), (params) => {
            let k = 0
            if (counter !== null) counter.value = params[k++]!
            for (const b of carried) b.value = params[k++]!
            let cond = control(lowerExpr(s.cond, loopScope), "a loop", s.cond.pos)
            if (hasBreak) cond = andBool(notBool(params[k++]!), cond)
            if (hasReturn) cond = andBool(notBool(params[k]!), cond)
            return cond
        }, (params) => {
            frame.returned = false
            frame.broke = false
            frame.continued = false
            if (hasReturn) frame.retval = params[params.length - 1]!
            exec(s.body, new Scope(loopScope), frame)
            // The update runs on every turn that goes on, one that continued
            // included. It also runs on the turn that breaks, which nothing
            // sees: the counter is not in scope after the loop.
            if (s.k === "for") assign(s.update, loopScope)
            const next: Num[] = []
            if (counter !== null) next.push(node(counter.value, counter))
            for (const b of carried) next.push(node(b.value, b))
            if (hasBreak) next.push(node(frame.broke, BOOL))
            if (hasReturn) next.push(node(frame.returned, BOOL), node(frame.retval ?? blank(frame.ret, s.pos), frame.ret))
            return next
        }, max))

        let k = counter === null ? 0 : 1
        for (const b of carried) b.value = out[k++]!
        if (hasBreak) k++
        frame.broke = false
        frame.continued = false
        if (hasReturn) {
            frame.returned = out[k]!
            frame.retval = out[k + 1]!
        } else {
            frame.returned = false
            frame.retval = outer
        }
    }

    /**
     * The counter's value on each turn of a for loop whose turns are known at
     * build time, or null when they are not (a bound read from a uniform), or
     * when there are more than `limit`, which then holds one more.
     */
    function countTurns(s: Extract<Stmt, { k: "for" }>, loopScope: Scope, counter: Binding, limit: number): LV[] | null {
        const start = counter.value
        const values: LV[] = []
        try {
            for (;;) {
                if (!isConstant(counter.value)) return null
                const c = control(lowerExpr(s.cond, loopScope), "a loop", s.cond.pos)
                if (typeof c !== "boolean") return null
                if (!c) return values
                values.push(counter.value)
                if (values.length > limit) return values
                assign(s.update, loopScope)
            }
        } finally {
            counter.value = start
        }
    }

    /**
     * How many turns a real for loop may take: what its constant bound gives,
     * or its uniform bound's Range, or `DEFAULT_TURNS` when the bound says
     * nothing. A float counter gets one more, since the GPU's float may land a
     * hair either side of the bound the count was made with.
     */
    function turnLimit(s: Extract<Stmt, { k: "for" }>, loopScope: Scope, counter: Binding): number {
        const known = countTurns(s, loopScope, counter, 1 << 16)
        const slack = counter.kind === undefined ? 1 : 0
        if (known !== null) return Math.max(1, known.length + slack)
        // `i < n`, `i <= n`, `i > n`, `i >= n`, with `n` a uniform (or a
        // conversion of one) and the counter stepping by a constant.
        const c = s.cond
        if (c.k !== "binary" || !["<", "<=", ">", ">="].includes(c.op)) return DEFAULT_TURNS
        const flip = c.b.k === "ident" && c.b.name === s.counter
        if (!flip && !(c.a.k === "ident" && c.a.name === s.counter)) return DEFAULT_TURNS
        const op = flip ? ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as Record<string, string>)[c.op]! : c.op
        const from = counter.value
        if (!isConstant(from)) return DEFAULT_TURNS
        assign(s.update, loopScope)
        const after = counter.value
        counter.value = from
        if (!isConstant(after)) return DEFAULT_TURNS
        const step = num(after) - num(from)
        const range = uniformRange(lowerExpr(flip ? c.a : c.b, loopScope))
        if (range === null) return DEFAULT_TURNS
        const up = op === "<" || op === "<="
        if (up !== step > 0) return DEFAULT_TURNS
        const bound = up ? range.max : range.min
        const span = up ? bound - num(from) : num(from) - bound
        const turns = op === "<" || op === ">" ? Math.ceil(span / Math.abs(step)) : Math.floor(span / Math.abs(step)) + 1
        return Math.max(1, Math.min(1 << 16, turns + slack))
    }

    /** The Range of the uniform a bound reads, directly or through a conversion. */
    function uniformRange(v: LV): { min: number; max: number } | null {
        if (!(v instanceof Val)) return null
        let n = v.owner.nodes[v.ref]!
        if (n.k === "call" && n.op === SLOP.CAST) n = v.owner.nodes[n.args[0]!]!
        if (n.k !== "uniform") return null
        const r = v.owner.uniforms[n.slot]?.range
        return r === undefined ? null : { min: r.min, max: r.max }
    }

    // MARK: switch

    /**
     * A switch as the if chain it means: `x == 1 || x == 2` per case, in order,
     * and the default last. Cases never fall through, so nothing is lost.
     */
    function switchAsIf(s: Extract<Stmt, { k: "switch" }>, scope: Scope): Stmt {
        const v = lowerExpr(s.value, scope)
        if (!isIntLike(v)) {
            fail(`a switch picks by an int, and this is ${describeLV(v)}. Convert it: switch (int(x))`, s.value.pos)
        }
        const seen = new Set<bigint | number>()
        let otherwise: Stmt[] = []
        const arms: Array<{ cond: Expr; body: Stmt[]; pos: Pos }> = []
        for (const c of s.cases) {
            if (c.labels.includes(null)) { otherwise = c.body; continue }
            let cond: Expr | null = null
            for (const l of c.labels as Expr[]) {
                const k = lowerExpr(l, scope, kindWant(v))
                const key = typeof k === "bigint" ? k : k instanceof Uint ? k.v : k instanceof Val ? constValue(k) : null
                if (key === null) fail("a case label is a whole number, or a const int", l.pos)
                if (seen.has(key)) fail(`this switch already has a case ${key}`, l.pos)
                seen.add(key)
                const eq: Expr = { k: "binary", op: "==", a: s.value, b: l, pos: l.pos }
                cond = cond === null ? eq : { k: "binary", op: "||", a: cond, b: eq, pos: l.pos }
            }
            arms.push({ cond: cond!, body: c.body, pos: c.pos })
        }
        let out: Stmt[] = otherwise
        for (let i = arms.length - 1; i >= 0; i--) {
            const a = arms[i]!
            out = [{ k: "if", cond: a.cond, then: a.body, else: out, pos: a.pos }]
        }
        return out[0] ?? { k: "if", cond: { k: "bool", value: true, pos: s.pos }, then: [], else: [], pos: s.pos }
    }

    // MARK: conversions

    /**
     * A value as a declared type, as a declaration, an assignment and a
     * return make it. Into a float anything numeric converts (an int, a bool,
     * a comparison), a single number fills every component, and a float4 goes
     * into a float3 by dropping its fourth (`Specs/SL_NEXT.md` 2b, 2c). Into an
     * int only an int goes: a float is refused with the conversion that says
     * how, since which rounding was meant is the author's to say.
     */
    function fit(v: LV, t: VType, name: string, pos: Pos): LV {
        switch (t.kind) {
            case undefined: {
                let x = toFloat(v, pos)
                const got = widthOf(x)
                if (got === 1 && t.width > 1) x = at(pos, () => compose(t.width, new Array<LV>(t.width).fill(x)))
                else if (got === 4 && t.width === 3) x = at(pos, () => asVal(x).swz("xyz") as unknown as Val)
                assertWidth(x, t.width, name, widthType(t.width), pos)
                return x
            }
            case "int":
                if (isInt(v)) return v
                if (isUint(v)) fail(`${name} is an int and this is a uint; convert it with int(...)`, pos)
                if (isBoolish(v)) fail(`${name} is an int and this is a bool; convert it with int(...)`, pos)
                fail(`${name} is an int and this is a ${widthType(widthOf(v))}; convert it with int(...), which truncates toward zero`, pos)
                break
            case "uint":
                if (isUint(v)) return v
                if (typeof v === "bigint" && v >= 0n) return new Uint(v)
                fail(`${name} is a uint and this is ${describeLV(v)}; convert it with uint(...)`, pos)
                break
            case "bool": {
                const b = v instanceof Test ? v.bool : v
                if (typeof b === "boolean" || (b instanceof Val && b.kind === "bool")) {
                    if (widthOf(b) !== 1) fail(`${name} is one bool and this compares ${widthOf(b)} components; combine them with && or ||`, pos)
                    return b
                }
                fail(`${name} is a bool, and this is ${describeLV(v)}. A bool holds a comparison, as in x > 0`, pos)
            }
        }
        return v
    }

    /** A value as floats: an int converts, a bool is 0 or 1, and a comparison is the float it always was. */
    function toFloat(v: LV, pos: Pos): number | Val {
        if (typeof v === "number") return v
        if (typeof v === "bigint") return Number(v)
        if (v instanceof Uint) return Number(v.v)
        if (typeof v === "boolean") return v ? 1 : 0
        if (v instanceof Test) return v.float
        return v.kind === undefined ? v : at(pos, () => sl.float(v) as unknown as Val)
    }

    /**
     * A condition for an if or a loop: one bool. A float is true from 0.5, as
     * a `?:` has always read one, and an int when it is not zero.
     */
    function control(v: LV, what: string, pos: Pos): boolean | Val {
        const b = boolOf(v, pos)
        if (widthOf(b) !== 1) fail(`${what} takes one condition, and this compares ${widthOf(b)} components; combine them with && or ||`, pos)
        return b
    }

    function boolOf(v: LV, pos: Pos): boolean | Val {
        if (typeof v === "boolean") return v
        if (typeof v === "number") return v >= 0.5
        if (typeof v === "bigint") return v !== 0n
        if (v instanceof Uint) return v.v !== 0n
        if (v instanceof Test) return v.bool
        if (v.kind === "bool") return v
        return at(pos, () => (v.kind === undefined ? v.ge(0.5) : v.ne(0)) as unknown as Val)
    }

    /** A value as a node of its type, for a branch's or a loop's results. */
    function node(v: LV, t: VType): Val {
        if (v instanceof Val) return v
        if (t.kind === "int") return sl.int(num(v)) as unknown as Val
        if (t.kind === "uint") return sl.uint(num(v)) as unknown as Val
        if (t.kind === "bool") return sl.bool(v instanceof Test ? (v.bool as boolean) : v !== false && v !== 0 && v !== 0n) as unknown as Val
        const f = v instanceof Test ? v.float : toFloat(v, main.pos)
        return (typeof f === "number" ? t.width === 1 ? sl.float(f) : compose(t.width, new Array<LV>(t.width).fill(f)) : f) as Val
    }

    function assertWidth(v: LV, want: SLType, name: string, type: TypeName, pos: Pos): void {
        const got = widthOf(v)
        if (got === want) return
        // A declaration is an assertion, not an input to inference
        // (`Specs/SL_TEXT.md` 3.2), so this says which half is wrong rather
        // than quietly promoting one to the other.
        const hint = got > want ? ` Take the components you want with a swizzle, as in .${"xyzw".slice(0, want)}.` : ""
        fail(`${name} is declared ${type} and this is a ${widthType(got)}.${hint}`, pos)
    }

    /**
     * `p.x = v`, `c.rgb *= k`: the local rebuilt from the components the
     * swizzle names, taken from `v`, and the rest kept from what it held. A
     * single number fills every named component.
     */
    function writeComponents(b: Binding, member: Extract<Expr, { k: "member" }>, v: LV, pos: Pos): LV {
        const letters = member.name.replace(/[rgba]/g, (c) => "xyzw"["rgba".indexOf(c)]!)
        const names = "xyzw".slice(0, b.width)
        for (const c of letters) {
            if (!names.includes(c)) {
                fail(`${member.name} writes a component a ${widthType(b.width)} does not have`, member.pos)
            }
        }
        const got = widthOf(v)
        if (got !== 1 && got !== letters.length) {
            fail(`${member.name} is ${letters.length} components and this is a ${widthType(got)}`, pos)
        }
        const parts: LV[] = [...names].map((c) => {
            const j = letters.indexOf(c)
            if (j < 0) return b.width === 1 ? b.value : at(pos, () => asVal(b.value).swz(c) as unknown as Val)
            return got === 1 ? v : at(pos, () => asVal(v).swz("xyzw"[j]!) as unknown as Val)
        })
        return b.width === 1 ? parts[0]! : at(pos, () => compose(b.width, parts))
    }

    // MARK: expressions

    /**
     * `want` is the kind the value is going into, an int or a uint, which makes
     * a whole number written in it that kind: `int n = 3;`, `i += 1`.
     */
    function lowerExpr(e: Expr, scope: Scope, want?: "int" | "uint"): LV {
        switch (e.k) {
            case "num":
                if (e.unsigned === true || (e.whole && want === "uint")) return new Uint(BigInt(e.value))
                if (e.whole && want === "int") return BigInt.asIntN(32, BigInt(e.value))
                return e.value
            case "bool": return e.value
            case "hex": return at(e.pos, () => sl.color(e.hex) as unknown as Val)
            case "ident": {
                const b = scope.lookup(e.name)
                if (b === undefined) fail(`"${e.name}" is not declared`, e.pos, e.name.length)
                return b.value
            }
            case "member": {
                const obj = lowerExpr(e.obj, scope)
                return at(e.pos, () => asVal(obj instanceof Test ? obj.float : obj).swz(e.name) as unknown as Val)
            }
            case "unary": return lowerUnary(e, scope, want)
            case "binary": return lowerBinary(e, scope, want)
            case "cond": return lowerChoice(e, scope, want)
            case "call": return lowerCall(e, scope)
        }
    }

    function lowerUnary(e: Extract<Expr, { k: "unary" }>, scope: Scope, want?: "int" | "uint"): LV {
        const v = lowerExpr(e.arg, scope, want)
        switch (e.op) {
            case "+": return v
            case "-":
                if (typeof v === "number") return -v
                if (typeof v === "bigint") return BigInt.asIntN(32, -v)
                // As the node would: a uint negated is taken as a float.
                if (v instanceof Uint) return -Number(v.v)
                if (v instanceof Val && v.kind !== "bool") return at(e.pos, () => v.neg())
                return at(e.pos, () => asVal(toFloat(v, e.pos)).neg())
            case "!":
                if (typeof v === "boolean") return !v
                if (typeof v === "number") return 1 - v
                if (typeof v === "bigint") return v === 0n
                if (v instanceof Uint) return v.v === 0n
                if (v instanceof Test) return new Test(v.width, () => oneMinus(v.float, e.pos), () => notBool(v.bool))
                if (v.kind === "bool") return at(e.pos, () => v.not())
                if (v.kind === undefined) return oneMinus(v, e.pos)
                return at(e.pos, () => v.eq(0))
            case "~":
                if (typeof v === "bigint") return BigInt.asIntN(32, ~v)
                if (v instanceof Uint) return new Uint(~v.v)
                if (v instanceof Val && (v.kind === "int" || v.kind === "uint")) return at(e.pos, () => v.bnot())
                fail(`~ flips the bits of an int or a uint, and this is ${describeLV(v)}`, e.pos)
        }
    }

    function lowerBinary(e: Extract<Expr, { k: "binary" }>, scope: Scope, want?: "int" | "uint"): LV {
        const pos = e.pos
        if (e.op === "&&" || e.op === "||") return lowerLogic(e, scope)
        const inner = operandWant(e.op, want)
        const a = lowerExpr(e.a, scope, inner)
        const b = lowerExpr(e.b, scope, inner)
        return combine(e.op, a, b, e.a, e.b, scope, pos)
    }

    /** What an operator's operands are lowered as. Bits are an int's, so a whole number under one is an int: `h ^ 0x5bd1e995`. */
    function operandWant(op: BinaryOp, want?: "int" | "uint"): "int" | "uint" | undefined {
        return COMPARE.has(op) ? undefined : BITS.has(op) ? want ?? "int" : want
    }

    /** A binary op on operands already lowered from `ea` and `eb`. */
    function combine(op: BinaryOp, a: LV, b: LV, ea: Expr, eb: Expr, scope: Scope, pos: Pos): LV {
        // A whole number beside an int is an int: `i < 10`, `i % 3`.
        if (isIntLike(a) && typeof b === "number" && wholeExpr(eb)) b = lowerExpr(eb, scope, kindWant(a))
        if (isIntLike(b) && typeof a === "number" && wholeExpr(ea)) a = lowerExpr(ea, scope, kindWant(b))
        if (COMPARE.has(op)) return compare(op, a, b, pos)
        if (BITS.has(op)) return bitwise(op as BitOp, a, b, pos)
        return arithmetic(op as ArithOp, a, b, pos)
    }

    function arithmetic(op: ArithOp, a: LV, b: LV, pos: Pos): LV {
        if (isInt(a) && isInt(b)) {
            if (typeof a === "bigint" && typeof b === "bigint") {
                if ((op === "/" || op === "%") && b === 0n) return 0n
                return BigInt.asIntN(32, INT_ARITH[op](a, b))
            }
            return at(pos, () => intVal(a)[METHOD[op]](typeof b === "bigint" ? Number(b) : b))
        }
        if (isUint(a) || isUint(b)) {
            if (!isIntLike(a) || !isIntLike(b)) fail(`a uint only meets another uint here; convert with uint(...) or float(...)`, pos)
            if (a instanceof Uint && b instanceof Uint) {
                if ((op === "/" || op === "%") && b.v === 0n) return new Uint(0n)
                return new Uint(INT_ARITH[op](a.v, b.v))
            }
            return at(pos, () => intVal(a)[METHOD[op]](other(b)))
        }
        return floatArithmetic(op, toFloat(a, pos), toFloat(b, pos), pos)
    }

    /** Arithmetic on floats, exactly as it has always been built. */
    function floatArithmetic(op: ArithOp, a: number | Val, b: number | Val, pos: Pos): number | Val {
        if (typeof a === "number" && typeof b === "number") {
            if ((op === "/" || op === "%") && b === 0) {
                fail(`this divides ${a} by zero, and the result would not be a number`, pos)
            }
            return ARITH[op](a, b)
        }
        // A scalar on the LEFT has to become a value first, so it broadcasts
        // through a swizzle rather than as a wide constant. That is what
        // `sl.float(n).sub(v)` does too, and the two forms have to agree.
        return at(pos, () => asVal(a)[METHOD[op]](b))
    }

    function bitwise(op: BitOp, a: LV, b: LV, pos: Pos): LV {
        for (const v of [a, b]) {
            if (!isIntLike(v)) fail(`${op} works on the bits of an int or a uint, and this is ${describeLV(v)}${isBoolish(v) ? "; use && or ||" : ""}`, pos)
        }
        if (typeof a === "bigint" && typeof b === "bigint") return BigInt.asIntN(32, INT_BITS[op](a, b))
        // A shift's count may be either kind, and the value shifted keeps its own.
        const shift = op === "<<" || op === ">>"
        const count = typeof b === "bigint" ? b : b instanceof Uint ? b.v : null
        if (a instanceof Uint && count !== null && (shift || b instanceof Uint)) return new Uint(INT_BITS[op](a.v, count))
        if (typeof a === "bigint" && shift && b instanceof Uint) return BigInt.asIntN(32, INT_BITS[op](a, b.v))
        const x = intVal(a as bigint | Uint | Val)
        const y = other(b as bigint | Uint | Val)
        return at(pos, () => {
            switch (op) {
                case "&": return x.band(y)
                case "|": return x.bor(y)
                case "^": return x.bxor(y)
                case "<<": return x.shl(y)
                case ">>": return x.shr(y)
            }
        })
    }

    /**
     * A comparison. Two ints give a bool. Anything else is held as a Test: its
     * float form is the step the language always built, so a comparison read
     * as a number is the graph it always was, and its bool form a comparison node.
     */
    function compare(op: string, a: LV, b: LV, pos: Pos): LV {
        if (isInt(a) && isInt(b) && (a instanceof Val || b instanceof Val)) {
            return at(pos, () => intVal(a)[CMP_METHOD[op]!](typeof b === "bigint" ? Number(b) : b as Val) as unknown as Val)
        }
        if ((isUint(a) || isUint(b)) && isIntLike(a) && isIntLike(b)) {
            if (a instanceof Uint && b instanceof Uint) return INT_CMP[op]!(a.v, b.v)
            return at(pos, () => intVal(a)[CMP_METHOD[op]!](other(b)) as unknown as Val)
        }
        const fa = toFloat(a, pos)
        const fb = toFloat(b, pos)
        const width = Math.max(widthOf(fa), widthOf(fb)) as SLType
        return new Test(width, () => at(pos, () => stepForm(op, fa, fb, pos)), () => {
            if (typeof fa === "number" && typeof fb === "number") return FOLD_CMP[op]!(fa, fb)
            return at(pos, () => asVal(fa)[CMP_METHOD[op]!](fb) as unknown as Val)
        })
    }

    /** A comparison as the float that is 0 or 1 it was before bools. Nothing here branches. */
    function stepForm(op: string, a: number | Val, b: number | Val, pos: Pos): number | Val {
        switch (op) {
            case "<=": return sl.step(a, b)
            case ">=": return sl.step(b, a)
            case "<": return oneMinus(sl.step(b, a), pos)
            case ">": return oneMinus(sl.step(a, b), pos)
            case "==": return oneMinus(notEqual(a, b, pos), pos)
            default: return notEqual(a, b, pos)
        }
    }

    /** `abs(sign(a - b))`: 0 when equal, 1 otherwise, component wise. */
    function notEqual(a: number | Val, b: number | Val, pos: Pos): number | Val {
        const d = floatArithmetic("-", a, b, pos)
        if (typeof d === "number") return Math.abs(Math.sign(d))
        return sl.sign(d).abs()
    }

    function oneMinus(v: number | Val, pos: Pos): number | Val {
        if (typeof v === "number") return 1 - v
        return at(pos, () => sl.float(1).sub(v))
    }

    /** `&&` and `||`: min and max of floats, as they always were, until a branch reads them as bools. */
    function lowerLogic(e: Extract<Expr, { k: "binary" }>, scope: Scope): LV {
        const a = lowerExpr(e.a, scope)
        const b = lowerExpr(e.b, scope)
        const and = e.op === "&&"
        if (typeof a === "boolean" && typeof b === "boolean") return and ? a && b : a || b
        const width = Math.max(widthOf(a), widthOf(b)) as SLType
        return new Test(width, () => {
            const fa = toFloat(a, e.pos)
            const fb = toFloat(b, e.pos)
            if (typeof fa === "number" && typeof fb === "number") return and ? Math.min(fa, fb) : Math.max(fa, fb)
            return at(e.pos, () => (and ? asVal(fa).min(fb) : asVal(fa).max(fb)))
        }, () => {
            const x = boolOf(a, e.pos)
            const y = boolOf(b, e.pos)
            return and ? andBool(x, y) : orBool(x, y)
        })
    }

    /** `c ? a : b`: always a select, both sides computed. A float condition is the select it always was. */
    function lowerChoice(e: Extract<Expr, { k: "cond" }>, scope: Scope, want?: "int" | "uint"): LV {
        const cond = lowerExpr(e.cond, scope)
        if (typeof cond === "boolean" || typeof cond === "number" || typeof cond === "bigint" || cond instanceof Uint) {
            return lowerExpr(boolOf(cond, e.pos) ? e.then : e.else, scope, want)
        }
        // Built before the sides, as it always was, so a program's nodes keep
        // their order and its shader text is the text it was. A choice between
        // ints then leaves this float form unused.
        if (cond instanceof Test) void cond.float
        let t = lowerExpr(e.then, scope, want)
        let f = lowerExpr(e.else, scope, want)
        if (isIntLike(t) && typeof f === "number" && wholeExpr(e.else)) f = lowerExpr(e.else, scope, kindWant(t))
        if (isIntLike(f) && typeof t === "number" && wholeExpr(e.then)) t = lowerExpr(e.then, scope, kindWant(f))
        const kinded = [t, f].some((v) => typeof v === "bigint" || v instanceof Uint || typeof v === "boolean" || (v instanceof Val && v.kind !== undefined))
        if (!kinded) {
            const c = cond instanceof Test ? cond.float : cond
            return at(e.pos, () => sl.select(c, toFloat(t, e.pos), toFloat(f, e.pos)))
        }
        const c = boolOf(cond, e.pos)
        const side = (v: LV): Num => (isIntLike(v) ? intVal(v) : typeof v === "boolean" ? sl.bool(v) : v instanceof Test ? v.float : v) as Num
        return at(e.pos, () => sl.select(c, side(t), side(f)))
    }

    function lowerCall(e: Extract<Expr, { k: "call" }>, scope: Scope): LV {
        const callee = e.callee
        const floats = (args: Expr[]) => args.map((a) => toFloat(lowerExpr(a, scope), a.pos))

        if (callee.k === "member") {
            const shape = callee.name as SlSdfKind
            const p = toFloat(lowerExpr(e.args[0]!, scope), e.args[0]!.pos)
            if (typeof p === "number" || p.width !== 2) {
                fail(`sdf.${shape} measures the distance to a point, so it takes a float2`, e.args[0]!.pos)
            }
            const params = floats(e.args.slice(1))
            return at(e.pos, () => sl.sdf(shape, p as never, params))
        }

        const n = (callee as Extract<Expr, { k: "ident" }>).name

        if (n === "int" || n === "uint" || n === "bool") return convert(n, e, scope)
        if (n in TYPE_WIDTH) return construct(n as TypeName, floats(e.args), e.pos)

        if (n === "tex2D" || n === "tex2Dlod") {
            const texName = (e.args[0] as Extract<Expr, { k: "ident" }>).name
            const tex = samplers.get(texName)!
            const uv = toFloat(lowerExpr(e.args[1]!, scope), e.args[1]!.pos)
            if (typeof uv === "number" || uv.width !== 2) {
                fail(`${n} samples at a float2`, e.args[1]!.pos)
            }
            if (n === "tex2D") return at(e.pos, () => tex.sample(uv as never) as unknown as Val)
            const lod = toFloat(lowerExpr(e.args[2]!, scope), e.args[2]!.pos)
            if (typeof lod !== "number" && lod.width !== 1) {
                fail(`a mip level is one number, and this is a ${widthType(lod.width)}`, e.args[2]!.pos)
            }
            return at(e.pos, () => tex.sampleLevel(uv as never, lod) as unknown as Val)
        }

        if (n === "ramp") {
            const t = toFloat(lowerExpr(e.args[0]!, scope), e.args[0]!.pos)
            // A hex stays the string it was, so a ramp of hexes is the program
            // it always was. Anything else is a value, which has to be a colour
            // as written (`sl.ramp` says why), a colour uniform say.
            const stops = e.args.slice(1).map((a) => {
                if (a.k === "hex") return a.hex
                const v = toFloat(lowerExpr(a, scope), a.pos)
                if (typeof v === "number" || v.width < 3) {
                    fail(`a ramp's stop is a colour, a float3 or a float4, and this is a ${typeof v === "number" ? "float" : widthType(v.width)}`, a.pos)
                }
                if (writtenColour(v.owner.nodes, v.ref) === null) fail(RAMP_STOP_COMPUTED, a.pos)
                return v as never
            })
            return at(e.pos, () => sl.ramp(t, stops) as unknown as Val)
        }

        const builtin = BUILTINS[n]
        if (builtin !== undefined) {
            let args = e.args.map((a) => lowerExpr(a, scope))
            // min, max, abs and clamp keep ints ints; everything else takes floats.
            if (INT_BUILTINS.has(n) && args.some(isIntLike) && args.every((v, i) => isIntLike(v) || (typeof v === "number" && wholeExpr(e.args[i]!)))) {
                const k = kindWant(args.find(isIntLike)!)
                args = e.args.map((a) => lowerExpr(a, scope, k)).map((v) => (isIntLike(v) ? intVal(v) : v) as LV)
                return at(e.pos, () => builtin.lower!(args as Num[]))
            }
            const fs = args.map((v, i) => toFloat(v, e.args[i]!.pos))
            return at(e.pos, () => builtin.lower!(fs))
        }

        const fn = funcs.get(n)!
        return inline(fn, e, scope)
    }

    /** `int(x)`, `uint(x)`, `bool(x)`: a float truncates toward zero, held to the range; anything but zero is true. */
    function convert(n: "int" | "uint" | "bool", e: Extract<Expr, { k: "call" }>, scope: Scope): LV {
        if (e.args.length !== 1) fail(`${n}(x) takes one value`, e.pos)
        const v = lowerExpr(e.args[0]!, scope, n === "bool" ? undefined : n)
        if (widthOf(v) !== 1) fail(`${n}(x) takes one component, and this is a ${widthType(widthOf(v))}; convert each one`, e.pos)
        const x = v instanceof Test ? v.bool : v
        // Between an int and a uint the bits are kept, as the GPU keeps them.
        if (n === "int") {
            if (typeof x === "bigint") return x
            if (x instanceof Uint) return BigInt.asIntN(32, x.v)
            if (typeof x === "number") return BigInt(truncateHeld(x, "int"))
            if (typeof x === "boolean") return x ? 1n : 0n
        }
        if (n === "uint") {
            if (x instanceof Uint) return x
            if (typeof x === "bigint") return new Uint(x)
            if (typeof x === "number") return new Uint(BigInt(truncateHeld(x, "uint")))
            if (typeof x === "boolean") return new Uint(x ? 1n : 0n)
        }
        if (n === "bool") {
            if (typeof x === "boolean") return x
            if (typeof x === "number") return x !== 0
            if (typeof x === "bigint") return x !== 0n
            if (x instanceof Uint) return x.v !== 0n
        }
        const c = isIntLike(x) ? intVal(x) : x
        return at(e.pos, () => (n === "int" ? sl.int(c) : n === "uint" ? sl.uint(c) : sl.bool(c)) as unknown as Val)
    }

    /**
     * Inlines a call: the body, lowered against these arguments, in a fresh
     * scope that can see the globals and nothing else the caller had.
     */
    function inline(fn: FuncDecl, e: Extract<Expr, { k: "call" }>, caller: Scope): LV {
        const scope = new Scope(global)
        fn.params.forEach((p, i) => {
            const t = typeOf(p.type)
            const arg = e.args[i]!
            // In the caller's scope, where the argument is written; as the
            // parameter's kind, so a whole number passed to an int is one.
            const v = lowerExpr(arg, caller, want(t))
            const got = widthOf(v)
            if (got !== t.width) {
                fail(
                    `${fn.name}'s parameter ${p.name} is a ${p.type} and this argument is a ` +
                    `${widthType(got)}`,
                    arg.pos,
                )
            }
            scope.declare(p.name, { ...t, value: fit(v, t, `${fn.name}'s parameter ${p.name}`, arg.pos) })
        })
        return callBody(fn, scope)
    }

    function construct(type: TypeName, args: Array<number | Val>, pos: Pos): LV {
        const width = TYPE_WIDTH[type]
        if (width === 1) {
            const v = args[0]!
            if (args.length !== 1 || widthOf(v) !== 1) {
                fail("float(x) takes one float; use a swizzle to narrow a wider value", pos)
            }
            return v
        }
        if (args.length === 1) {
            const v = args[0]!
            const got = widthOf(v)
            // HLSL's scalar broadcast, and the identity for a value that is
            // already this wide. `float4(v4)` is `v4`, not four swizzles.
            if (got === width) return v
            if (got === 1) return at(pos, () => compose(width, new Array<LV>(width).fill(v)))
            fail(`${type}(v) broadcasts a float; a ${widthType(got)} needs its components spelled out`, pos)
        }
        return at(pos, () => compose(width, args))
    }

    function compose(width: SLType, parts: LV[]): Val {
        const ps = parts.map((p) => (p instanceof Test ? p.float : typeof p === "bigint" ? Number(p) : p instanceof Uint ? Number(p.v) : typeof p === "boolean" ? (p ? 1 : 0) : p)) as Num[]
        if (width === 2) return sl.vec2(...ps) as unknown as Val
        if (width === 3) return sl.vec3(...ps) as unknown as Val
        return sl.vec4(...ps) as unknown as Val
    }
}

// MARK: tables and small helpers

type ArithOp = "+" | "-" | "*" | "/" | "%"
type BitOp = "&" | "|" | "^" | "<<" | ">>"

const BOOL: VType = { width: 1, kind: "bool" }

const COMPARE = new Set<string>(["<", "<=", ">", ">=", "==", "!="])
const BITS = new Set<string>(["&", "|", "^", "<<", ">>"])
const INT_BUILTINS = new Set(["min", "max", "abs", "clamp"])

const ARITH: Record<ArithOp, (a: number, b: number) => number> = {
    "+": (a, b) => a + b,
    "-": (a, b) => a - b,
    "*": (a, b) => a * b,
    "/": (a, b) => a / b,
    // JavaScript's % is the truncated remainder, which is what HLSL's fmod is.
    // Folding it in JS is the same answer.
    "%": (a, b) => a % b,
}

/** Int arithmetic as the GPU does it, on 32 bits: bigint division and remainder truncate, as HLSL's do. */
const INT_ARITH: Record<ArithOp, (a: bigint, b: bigint) => bigint> = {
    "+": (a, b) => a + b,
    "-": (a, b) => a - b,
    "*": (a, b) => a * b,
    "/": (a, b) => a / b,
    "%": (a, b) => a % b,
}

/** A shift takes its count modulo 32 on every backend, and an int shifts right keeping its sign. */
const INT_BITS: Record<BitOp, (a: bigint, b: bigint) => bigint> = {
    "&": (a, b) => a & b,
    "|": (a, b) => a | b,
    "^": (a, b) => a ^ b,
    "<<": (a, b) => a << (b & 31n),
    ">>": (a, b) => a >> (b & 31n),
}

/** Comparisons of two uints, whose bigints compare as the values do. */
const INT_CMP: Record<string, (a: bigint, b: bigint) => boolean> = {
    "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b,
    ">=": (a, b) => a >= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b,
}

const FOLD_CMP: Record<string, (a: number, b: number) => boolean> = {
    "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b,
    ">=": (a, b) => a >= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b,
}

const CMP_METHOD: Record<string, "lt" | "le" | "gt" | "ge" | "eq" | "ne"> = {
    "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "==": "eq", "!=": "ne",
}

const METHOD: Record<ArithOp, "add" | "sub" | "mul" | "div" | "mod"> = {
    "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
}

function isArith(op: string): op is ArithOp {
    return op in ARITH
}

function typeOf(name: TypeName): VType {
    return { width: TYPE_WIDTH[name], kind: TYPE_KIND[name] }
}

function want(t: VType): "int" | "uint" | undefined {
    return t.kind === "int" || t.kind === "uint" ? t.kind : undefined
}

function isInt(v: LV): v is bigint | Val {
    return typeof v === "bigint" || (v instanceof Val && v.kind === "int")
}

function isUint(v: LV): v is Uint | Val {
    return v instanceof Uint || (v instanceof Val && v.kind === "uint")
}

function isIntLike(v: LV): v is bigint | Uint | Val {
    return isInt(v) || isUint(v)
}

function isBoolish(v: LV): boolean {
    return typeof v === "boolean" || v instanceof Test || (v instanceof Val && v.kind === "bool")
}

function isConstant(v: LV): v is number | bigint | Uint {
    return typeof v === "number" || typeof v === "bigint" || v instanceof Uint
}

function kindWant(v: LV): "int" | "uint" {
    return isUint(v) ? "uint" : "int"
}

function num(v: LV): number {
    return typeof v === "bigint" ? Number(v) : v instanceof Uint ? Number(v.v) : v as number
}

/** An int or uint operand as a node the EDSL's int methods take. */
function intVal(v: bigint | Uint | Val): Val {
    if (typeof v === "bigint") return sl.int(Number(v)) as unknown as Val
    if (v instanceof Uint) return sl.uint(Number(v.v)) as unknown as Val
    return v
}

/**
 * The second operand of an int method: an int constant as a number, which
 * takes the first operand's kind, and a uint one as a node, so an int meeting
 * it is refused rather than made a uint.
 */
function other(v: bigint | Uint | Val): number | Val {
    return typeof v === "bigint" ? Number(v) : intVal(v)
}

function asVal(v: LV): Val {
    if (v instanceof Val) return v
    if (v instanceof Uint) return intVal(v)
    return sl.float(typeof v === "number" ? v : num(v)) as unknown as Val
}

function widthOf(v: LV): SLType {
    if (v instanceof Val || v instanceof Test) return v.width
    return 1
}

function widthType(w: SLType): TypeName {
    return (["float", "float2", "float3", "float4"] as const)[w - 1]!
}

function typeName(t: VType): string {
    return t.kind === undefined ? widthType(t.width) : t.kind
}

function article(t: VType): string {
    return t.kind === "int" ? "an" : "a"
}

function describeLV(v: LV): string {
    if (typeof v === "bigint") return "an int"
    if (v instanceof Uint) return "a uint"
    if (typeof v === "boolean" || v instanceof Test) return "a bool"
    if (typeof v === "number") return "a float"
    return v.kind === undefined ? `a ${widthType(v.width)}` : v.kind === "int" ? "an int" : `a ${v.kind}`
}

/** A constant int node's value, for a case label read through a const. */
function constValue(v: Val): bigint | null {
    const n = v.owner.nodes[v.ref]!
    return n.k === "const" && n.kind !== undefined ? BigInt(n.v[0]!) : null
}

/** Two lowered values that are certainly the same, so a join can leave them out. */
function same(a: LV, b: LV): boolean {
    if (a === b) return true
    if (a instanceof Uint && b instanceof Uint) return a.v === b.v
    return a instanceof Val && b instanceof Val && a.ref === b.ref && a.width === b.width && a.kind === b.kind
}

function notBool(v: boolean | Val): boolean | Val {
    return typeof v === "boolean" ? !v : v.not()
}

function andBool(a: boolean | Val, b: boolean | Val): boolean | Val {
    if (a === false || b === false) return false
    if (a === true) return b
    if (b === true) return a
    return a.and(b)
}

function orBool(a: boolean | Val, b: boolean | Val): boolean | Val {
    if (a === true || b === true) return true
    if (a === false) return b
    if (b === false) return a
    return a.or(b)
}

/** Whether an expression is whole numbers only, `3` or `-(2 * 4)`, so beside an int it is an int. */
function wholeExpr(e: Expr): boolean {
    switch (e.k) {
        case "num": return e.whole
        case "unary": return (e.op === "-" || e.op === "+") && wholeExpr(e.arg)
        case "binary": return isArith(e.op) && wholeExpr(e.a) && wholeExpr(e.b)
        default: return false
    }
}

/** The names a body assigns, anywhere in it: what a real loop has to carry. */
function assignedIn(body: Stmt[]): Set<string> {
    const out = new Set<string>()
    const walk = (s: Stmt): void => {
        switch (s.k) {
            case "assign": {
                const t = s.target.k === "member" ? s.target.obj : s.target
                if (t.k === "ident") out.add(t.name)
                return
            }
            case "if": s.then.forEach(walk); s.else.forEach(walk); return
            case "block": s.body.forEach(walk); return
            case "for": walk(s.update); s.body.forEach(walk); return
            case "while": s.body.forEach(walk); return
            case "switch": s.cases.forEach((c) => c.body.forEach(walk)); return
            default: return
        }
    }
    body.forEach(walk)
    return out
}

/** Whether any of `exprs` reads one of `names`. */
function readsAny(exprs: Expr[], names: Set<string>): boolean {
    const walk = (e: Expr): boolean => {
        switch (e.k) {
            case "ident": return names.has(e.name)
            case "member": return walk(e.obj)
            case "unary": return walk(e.arg)
            case "binary": return walk(e.a) || walk(e.b)
            case "cond": return walk(e.cond) || walk(e.then) || walk(e.else)
            case "call": return (e.callee.k === "member" && walk(e.callee.obj)) || e.args.some(walk)
            default: return false
        }
    }
    return exprs.some(walk)
}

/** Whether a loop body can leave its turn early: a break or a continue of its own, or a return anywhere. */
function leavesEarly(body: Stmt[]): boolean {
    return breaksOut(body) || continuesIn(body) || returnsIn(body)
}

function breaksOut(body: Stmt[]): boolean {
    return ownStatement(body, "break")
}

function continuesIn(body: Stmt[]): boolean {
    return ownStatement(body, "continue")
}

/** A break or a continue that belongs to this loop, not to one nested in it. */
function ownStatement(body: Stmt[], k: "break" | "continue"): boolean {
    return body.some((s) => {
        switch (s.k) {
            case "break":
            case "continue": return s.k === k
            case "if": return ownStatement(s.then, k) || ownStatement(s.else, k)
            case "block": return ownStatement(s.body, k)
            case "switch": return s.cases.some((c) => ownStatement(c.body, k))
            default: return false
        }
    })
}

function returnsIn(body: Stmt[]): boolean {
    return body.some((s) => {
        switch (s.k) {
            case "return": return true
            case "if": return returnsIn(s.then) || returnsIn(s.else)
            case "block": return returnsIn(s.body)
            case "for":
            case "while": return returnsIn(s.body)
            case "switch": return s.cases.some((c) => returnsIn(c.body))
            default: return false
        }
    })
}

/**
 * An EDSL message in the words of a `.sl` file.
 *
 * The EDSL names its types after its constructors, `sl.vec3`, so "cannot
 * combine a vec3 with a vec2" is right for a TypeScript author and wrong for
 * one who wrote float3 (`Specs/SL_NEXT.md` 5). One rewrite here, rather than a
 * second set of messages, keeps both surfaces saying the same thing. A quoted
 * name is the author's own and left as written.
 */
function inFileWords(message: string): string {
    return message.split(/("[^"]*")/).map((part, i) =>
        i % 2 === 1 ? part : part.replace(/\bsl\.vec([234])\(/g, "float$1(").replace(/\bvec([234])\b/g, "float$1"),
    ).join("")
}
