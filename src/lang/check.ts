/**
 * Declarations, names and statement shape. Everything that can be known without
 * knowing a type.
 *
 * Phase A of `Specs/SL_TEXT.md` section 4.
 *
 * WHY THE TYPES ARE NOT CHECKED HERE. Every value in this language carries its
 * width, and the EDSL computes that width as it records. A second inference
 * pass in this file would be a second implementation of the same rules, and two
 * implementations of a type system are two type systems. So `lower.ts` infers
 * once, through the EDSL, and asserts the width it got against the type the
 * author declared; a declaration is an assertion rather than an input to
 * inference. What is left for this file is the part lowering cannot see:
 * whether a name exists, whether a body is shaped like a body, and whether the
 * program fits the budgets before anything is built.
 *
 * SHADOWING IS REFUSED, between values. HLSL would let a local called `time`
 * hide the input, or a parameter called `tint` hide a uniform. Allowing it would
 * mean every later question about a name ("is this a texture?") depends on where
 * it is asked from, for no expressive gain in a language whose functions are
 * half a dozen lines long.
 *
 * A value MAY take the name of a builtin or a prelude function: `float circle`,
 * `uniform float turbulence`. Those are the names an author reaches for first,
 * and refusing them was the most common error left once the others were fixed
 * (`Specs/SL_NEXT.md` 2d). Calls and values never meet in one position, so the
 * only question left is a call to the name where the value is visible, and that
 * is refused with the reason.
 */

import { DERIVED_INPUTS, INPUTS, PREVIOUS, STEP_INPUTS, tooManyTextures, tooManyUniforms } from "../ir"
import { TEXTURE_SLOTS, UNIFORM_SLOTS } from "../ops"
import { SL_GLSL_HINT } from "../ops"
import { BUILTINS, NOT_YET } from "./builtins"
import { SL_SDF_SHAPES } from "../shapes"
import { TYPE_WIDTH, type Expr, type FuncDecl, type Stmt, type Unit } from "./ast"
import { readAttributes } from "./attributes"
import { SLParseError, type Pos, type SLFix } from "./lexer"

const INPUT_NAMES = new Set(Object.keys(INPUTS))
/**
 * Inputs built from the others (`texel`, `centered`). A declaration may take
 * one's name, as it may a builtin's, because programs wrote their own `texel`
 * long before the language had one, and that must keep compiling.
 */
const DERIVED_NAMES = new Set(Object.keys(DERIVED_INPUTS))
/**
 * `frame` and `deltaTime`, and `previous`, the texture that is the frame drawn
 * before (IR 5). The language had none of them before 0.7.0, so a program may
 * already use the name for its own value, texture or function, and keeps it.
 * A function by the name is called by it; the bare name is still the input.
 */
const STEP_NAMES = new Set(Object.keys(STEP_INPUTS))
/** What a declaration may take the name of, with the words for it. */
const SHADOWABLE = new Set(["a builtin", "a derived input", "a built in input", "the previous frame"])
/** What a function may take the name of: only the names that came after files could have used them. */
const FUNCTION_MAY_TAKE = new Set(["a built in input", "the previous frame"])

/**
 * The GLSL spellings whose HLSL name means the same wherever it is written, so
 * the hint can be a one click fix (`Specs/SL_NEXT.md` 5, Decision 1 A). The
 * rest of `SL_GLSL_HINT` gets the hint alone: `mod` floors where `%` truncates,
 * `ivec2` truncates where `float2` does not, and `atan` is `atan2` only with two
 * arguments (handled at the call).
 */
const GLSL_RENAMES = new Set([
    "mix", "fract", "texture", "textureLod", "vec2", "vec3", "vec4", "gl_FragCoord", "iTime", "iResolution",
])

/** The builtins whose first argument is a texture, which is not a value anywhere else. */
const SAMPLES = new Set(["tex2D", "tex2Dlod"])

const rename = (from: string, to: string): SLFix => ({ title: `Replace ${from} with ${to}`, replacement: to })

export interface Checked {
    unit: Unit
    /** Every callable function by name, the file's shadowing the prelude's. */
    funcs: Map<string, FuncDecl>
    uniforms: Map<string, Unit["uniforms"][number]>
    textures: Map<string, Unit["textures"][number]>
    consts: Map<string, Extract<Stmt, { k: "const" }>>
}

/**
 * Validates a unit against the prelude it will be lowered with.
 *
 * Returns the resolved tables rather than mutating the unit, so a caller that
 * wants only the declarations (the Play editor's completion, Phase C) can stop
 * here without building a graph.
 */
export interface CheckOptions {
    /** Off for the prelude, which is functions only. See `parseUnit`. */
    requireMain?: boolean
    /** Where to collect errors instead of throwing the first. See `diagnose`. */
    errors?: SLParseError[]
}

export function check(unit: Unit, prelude: FuncDecl[], options: CheckOptions = {}): Checked {
    const file = unit.file
    // Annotated rather than inferred: TypeScript only treats a call as
    // terminating control flow when the callee's `never` comes from an explicit
    // type, so without this every `if (x.k !== "ident") fail(...)` below would
    // fail to narrow.
    const fail: (message: string, pos: Pos, length?: number, fix?: SLFix) => never =
        (message, pos, length = 1, fix) => {
            throw new SLParseError(message, file, pos, length, fix)
        }

    /**
     * One declaration's or one statement's checks. Collecting, an error is
     * recorded and the next one is checked; the name it declares is still
     * declared, so a later use of it is not a second, false error.
     */
    const attempt = (check: () => void): boolean => {
        if (options.errors === undefined) { check(); return true }
        try {
            check()
            return true
        } catch (e) {
            if (!(e instanceof SLParseError)) throw e
            options.errors.push(e)
            return false
        }
    }

    const funcs = new Map<string, FuncDecl>()
    for (const fn of prelude) funcs.set(fn.name, fn)

    const uniforms = new Map<string, Unit["uniforms"][number]>()
    const textures = new Map<string, Unit["textures"][number]>()
    const consts = new Map<string, Extract<Stmt, { k: "const" }>>()
    /**
     * Loop counters currently in scope.
     *
     * A counter is not a value, it is substituted as a number once per
     * unrolled iteration, so assigning to it would look like it changed the
     * loop and change nothing. Shadowing is refused everywhere else, so one
     * flat set is enough to know whether a name is one.
     */
    const counters = new Set<string>()

    /**
     * Anything already spoken for at the top level, for the duplicate check.
     *
     * Functions are NOT in here, because a file function shadowing a prelude
     * function of the same name is the sanctioned way to replace one
     * (`Specs/SL_TEXT.md` 3.8). Every other kind of declaration checks
     * `valueClash`, which adds the file's own functions.
     */
    const taken = (n: string): string | null => {
        if (INPUT_NAMES.has(n)) return "an input"
        if (BUILTINS[n] !== undefined) return "a builtin"
        if (n === "sdf") return "the sdf shape family"
        if (n === "main") return "the fragment function"
        if (uniforms.has(n)) return "a uniform"
        if (textures.has(n)) return "a texture"
        if (consts.has(n)) return "a const"
        if (DERIVED_NAMES.has(n)) return "a derived input"
        if (STEP_NAMES.has(n)) return "a built in input"
        if (n === PREVIOUS) return "the previous frame"
        return null
    }

    /** What a value may not be called: anything spoken for, except a builtin's or a prelude function's name. */
    const valueClash = (n: string): string | null => {
        const why = taken(n)
        if (why !== null && !SHADOWABLE.has(why)) return why
        const fn = funcs.get(n)
        return fn !== undefined && !fn.prelude ? "a function" : null
    }

    for (const u of unit.uniforms) {
        attempt(() => {
            const clash = valueClash(u.name)
            if (clash !== null) fail(`"${u.name}" already names ${clash}`, u.pos, u.name.length)
        })
        for (const p of readAttributes(u).problems) attempt(() => fail(p.message, p.pos, p.length, p.fix))
        if (!uniforms.has(u.name)) uniforms.set(u.name, u)
    }
    attempt(() => {
        if (uniforms.size <= UNIFORM_SLOTS) return
        const over = unit.uniforms[UNIFORM_SLOTS]!
        fail(tooManyUniforms(uniforms.size, "file"), over.pos, over.name.length)
    })

    for (const t of unit.textures) {
        attempt(() => {
            const clash = valueClash(t.name)
            if (clash !== null) fail(`"${t.name}" already names ${clash}`, t.pos, t.name.length)
        })
        if (!textures.has(t.name)) textures.set(t.name, t)
    }
    attempt(() => {
        if (textures.size <= TEXTURE_SLOTS) return
        const over = unit.textures[TEXTURE_SLOTS]!
        fail(tooManyTextures(textures.size, "file"), over.pos, over.name.length)
    })

    for (const c of unit.consts) {
        attempt(() => {
            const clash = valueClash(c.name)
            if (clash !== null) fail(`"${c.name}" already names ${clash}`, c.pos, c.name.length)
        })
        if (!consts.has(c.name)) consts.set(c.name, c)
    }

    for (const fn of unit.funcs) {
        attempt(() => {
            const clash = taken(fn.name)
            if (clash !== null && !FUNCTION_MAY_TAKE.has(clash)) fail(`"${fn.name}" already names ${clash}`, fn.pos, fn.name.length)
            if (unit.funcs.filter((f) => f.name === fn.name).length > 1) {
                fail(
                    `this file declares ${fn.name} more than once. There is no overloading: a function ` +
                    `inlines, so two bodies under one name have nothing to pick between them`,
                    fn.pos, fn.name.length,
                )
            }
        })
        funcs.set(fn.name, fn)
    }

    const main = unit.main
    if (main === null) {
        if (options.requireMain ?? true) throw new Error("check() reached a unit with no main")
        for (const fn of unit.funcs) checkFunction(fn)
        attempt(refuseRecursion)
        return { unit, funcs, uniforms, textures, consts }
    }
    attempt(() => {
        if (main.ret !== "float4") {
            fail(`main returns a colour, so it is declared \`float4 main()\`, not ${main.ret}`, main.pos)
        }
    })
    attempt(() => {
        if (main.params.length > 0) {
            fail(
                "main takes no parameters: what a program is given are the free identifiers uv, " +
                "fragCoord, resolution, time, aspect, texel, centered, frame and deltaTime, and the " +
                "texture previous",
                main.params[0]!.pos,
            )
        }
    })

    // MARK: bodies

    // The prelude's own bodies are checked once, where it is built, against a
    // unit that has no uniforms of its own. Re-checking them here would let a
    // file declaring `uniform float p;` fail on a prelude parameter called `p`,
    // which is not the author's mistake and not a name they can see.
    for (const fn of [...unit.funcs, main]) checkFunction(fn)

    attempt(refuseRecursion)

    /**
     * A function inlines, so a cycle is not slow, it is infinite.
     *
     * Caught here rather than by a depth counter in lowering, because a depth
     * limit reports "too deep" about whichever call happened to be at the
     * bottom, while this names the cycle the author actually wrote.
     */
    function refuseRecursion(): void {
        const stack: string[] = []
        const done = new Set<string>()

        const walk = (n: string, at: Pos): void => {
            const cycle = stack.indexOf(n)
            if (cycle >= 0) {
                const path = [...stack.slice(cycle), n].join(" calls ")
                fail(
                    `${path}, and a function inlines rather than being called, so that cycle has no ` +
                    `bottom. Unroll it into a for loop with a constant count`,
                    at, n.length,
                )
            }
            if (done.has(n)) return
            const fn = funcs.get(n)
            if (fn === undefined) return
            stack.push(n)
            for (const c of callsIn(fn.body)) walk(c.name, c.pos)
            stack.pop()
            done.add(n)
        }

        for (const c of callsIn(main === null ? [] : main.body)) walk(c.name, c.pos)
        for (const fn of unit.funcs) walk(fn.name, fn.pos)
    }

    function callsIn(body: Stmt[]): Array<{ name: string; pos: Pos }> {
        const out: Array<{ name: string; pos: Pos }> = []
        const expr = (e: Expr): void => {
            switch (e.k) {
                case "call":
                    if (e.callee.k === "ident" && funcs.has(e.callee.name)) {
                        out.push({ name: e.callee.name, pos: e.callee.pos })
                    }
                    if (e.callee.k === "member") expr(e.callee.obj)
                    for (const a of e.args) expr(a)
                    return
                case "member": expr(e.obj); return
                case "unary": expr(e.arg); return
                case "binary": expr(e.a); expr(e.b); return
                case "cond": expr(e.cond); expr(e.then); expr(e.else); return
                default: return
            }
        }
        const stmt = (s: Stmt): void => {
            switch (s.k) {
                case "var":
                case "const": expr(s.init); return
                case "assign": expr(s.value); return
                case "if": expr(s.cond); s.then.forEach(stmt); s.else.forEach(stmt); return
                case "for": expr(s.from); expr(s.cond); stmt(s.update); s.body.forEach(stmt); return
                case "while": expr(s.cond); s.body.forEach(stmt); return
                case "switch":
                    expr(s.value)
                    for (const c of s.cases) { c.labels.forEach((l) => { if (l !== null) expr(l) }); c.body.forEach(stmt) }
                    return
                case "return": expr(s.value); return
                case "block": s.body.forEach(stmt); return
                case "break":
                case "continue": return
            }
        }
        body.forEach(stmt)
        return out
    }

    function checkFunction(fn: FuncDecl): void {
        const params = new Set<string>()
        for (const p of fn.params) {
            attempt(() => {
                const clash = valueClash(p.name)
                if (clash !== null) fail(`"${p.name}" already names ${clash}`, p.pos, p.name.length)
                if (params.has(p.name)) fail(`${fn.name} already has a parameter called "${p.name}"`, p.pos)
            })
            params.add(p.name)
        }
        checkBody(fn, fn.body, new Set(params), { loop: false, switchCase: false })
        if (!terminates(fn.body)) {
            attempt(() => fail(
                returnsSomewhere(fn.body)
                    ? `not every way through ${fn.name} returns a ${fn.ret}; add a return at the end`
                    : `${fn.name} never returns a ${fn.ret}`,
                fn.pos, fn.name.length,
            ))
        }
    }

    /**
     * `where` says what a break or a continue would leave. A break inside a
     * case, other than the one that ends it, is refused: it would leave the
     * switch early, which an if says more plainly.
     */
    function checkBody(fn: FuncDecl, body: Stmt[], scope: Set<string>, where: { loop: boolean; switchCase: boolean }): void {
        let ended: Stmt | null = null
        for (const s of body) {
            if (ended !== null) {
                // Once: everything after it is the same mistake.
                attempt(() => fail(unreachable(ended!), s.pos))
                break
            }
            attempt(() => checkStmt(s))
            if (s.k === "var" || s.k === "const") scope.add(s.name)
            if (terminates([s])) ended = s
        }

        function checkStmt(s: Stmt): void {
            switch (s.k) {
                case "var":
                case "const": {
                    const clash = valueClash(s.name)
                    if (clash !== null) fail(`"${s.name}" already names ${clash}`, s.pos, s.name.length)
                    if (scope.has(s.name)) fail(`"${s.name}" is already declared in this body`, s.pos)
                    checkExpr(fn, s.init, scope)
                    break
                }
                case "assign":
                    checkAssign(s, scope)
                    break
                case "if":
                    checkExpr(fn, s.cond, scope)
                    checkBody(fn, s.then, new Set(scope), where)
                    checkBody(fn, s.else, new Set(scope), where)
                    break
                case "for": {
                    const clash = valueClash(s.counter)
                    if (clash !== null) fail(`"${s.counter}" already names ${clash}`, s.pos, s.counter.length)
                    if (scope.has(s.counter)) fail(`"${s.counter}" is already declared in this body`, s.pos)
                    checkExpr(fn, s.from, scope)
                    const inner = new Set(scope)
                    inner.add(s.counter)
                    checkExpr(fn, s.cond, inner)
                    checkExpr(fn, s.update.value, inner)
                    counters.add(s.counter)
                    try {
                        checkBody(fn, s.body, new Set(inner), { loop: true, switchCase: false })
                    } finally {
                        counters.delete(s.counter)
                    }
                    break
                }
                case "while":
                    checkExpr(fn, s.cond, scope)
                    checkBody(fn, s.body, new Set(scope), { loop: true, switchCase: false })
                    break
                case "break":
                    if (where.switchCase) {
                        fail(
                            "this break would leave the switch before the end of its case. Put the rest " +
                            "of the case under an if instead",
                            s.pos, 5,
                        )
                    }
                    if (!where.loop) fail("break leaves a loop, or ends a switch's case, and this is in neither", s.pos, 5)
                    break
                case "continue":
                    if (!where.loop) fail("continue starts a loop's next turn, and this is not in a loop", s.pos, 8)
                    break
                case "switch": {
                    checkExpr(fn, s.value, scope)
                    let defaults = 0
                    for (const c of s.cases) {
                        for (const l of c.labels) {
                            if (l === null) {
                                defaults++
                                if (defaults > 1) fail("this switch already has a default", c.pos, 7)
                            } else {
                                checkExpr(fn, l, scope)
                            }
                        }
                        if (c.body.length === 0 && !c.closed) {
                            fail("this case has no body; a case that shares the next one's body stacks its label on it", c.pos, 4)
                        }
                        checkBody(fn, c.body, new Set(scope), { loop: where.loop, switchCase: true })
                        if (!c.closed && !terminates(c.body)) {
                            fail(
                                "this case does not end in break or return. Cases never fall through into the " +
                                "next one here, so end it with `break;`",
                                c.pos, 4,
                            )
                        }
                    }
                    break
                }
                case "return":
                    checkExpr(fn, s.value, scope)
                    break
                case "block":
                    checkBody(fn, s.body, new Set(scope), where)
                    break
            }
        }

        function checkAssign(s: Extract<Stmt, { k: "assign" }>, scope: Set<string>): void {
            // `p.x = 1` and `c.rgb *= 0.5` write the components they name
            // and keep the rest; lowering rebuilds the local from both.
            let target = s.target
            if (target.k === "member") {
                const sw = target.name
                if (!/^([xyzw]{1,4}|[rgba]{1,4})$/.test(sw)) {
                    fail(`${sw} is not a swizzle that can be assigned to; name components with xyzw or rgba`, target.pos, sw.length)
                }
                if (new Set(sw).size !== sw.length) {
                    fail(`${sw} names a component twice, so assigning to it would write one component two ways`, target.pos, sw.length)
                }
                target = target.obj
            }
            if (target.k !== "ident") fail("only a local can be assigned to", target.pos)
            const n = target.name
            // A local shadows what it is named after, a builtin or a
            // derived input, so it is assignable like any other local.
            const why = scope.has(n) ? null : taken(n)
            if (why !== null) fail(`"${n}" is ${why} and cannot be assigned to`, target.pos, n.length)
            if (counters.has(n)) {
                fail(
                    `"${n}" is a loop counter, which only the loop's update changes, so the loop's ` +
                    `turns can be counted. Use another local`,
                    target.pos, n.length,
                )
            }
            if (!scope.has(n)) unknown(n, scope, target.pos)
            checkExpr(fn, s.value, scope)
        }
    }

    /** Why the statement after `s` never runs. */
    function unreachable(s: Stmt): string {
        if (s.k === "return" || s.k === "break" || s.k === "continue") return `this is after the ${s.k}, so it can never run`
        const above = s.k === "block" ? "braces" : s.k
        return `this can never run: every way through the ${above} above ends in a return, break or continue`
    }

    // MARK: expressions

    function checkExpr(fn: FuncDecl, e: Expr, scope: Set<string>): void {
        switch (e.k) {
            case "num":
            case "hex":
            case "bool":
                return
            case "ident": {
                if (scope.has(e.name) || INPUT_NAMES.has(e.name) || DERIVED_NAMES.has(e.name) || STEP_NAMES.has(e.name) ||
                    uniforms.has(e.name) || consts.has(e.name)) return
                if (e.name === PREVIOUS && !textures.has(e.name)) {
                    fail(
                        "previous is the frame this program drew before, a texture, and a texture is only " +
                        "ever the first argument of tex2D. Write `tex2D(previous, uv)`",
                        e.pos, e.name.length,
                    )
                }
                if (textures.has(e.name)) {
                    fail(
                        `"${e.name}" is a texture, and a texture is only ever the first argument of ` +
                        `tex2D or tex2Dlod. Write \`tex2D(${e.name}, uv)\``,
                        e.pos, e.name.length,
                    )
                }
                if (e.name === "sdf") {
                    fail("sdf names a family of shapes; call one, as in `sdf.circle(p, r)`", e.pos, 3)
                }
                if (funcs.has(e.name) || BUILTINS[e.name] !== undefined) {
                    fail(`${e.name} is a function; call it, as in \`${e.name}(...)\``, e.pos, e.name.length)
                }
                glsl(e.name, e.pos)
                unknown(e.name, scope, e.pos)
                break
            }
            case "member":
                // `sdf.circle` is the one member that is not a swizzle, and it
                // is only legal as the callee of a call, which `checkCall`
                // handles before it ever gets here.
                if (e.obj.k === "ident" && e.obj.name === "sdf") {
                    fail(
                        `sdf.${e.name} is a shape, so it has to be called: \`sdf.${e.name}(p, ...)\``,
                        e.pos, e.name.length,
                    )
                }
                checkExpr(fn, e.obj, scope)
                return
            case "call": {
                if (attempt(() => checkCall(fn, e, scope))) return
                // Only reached while collecting: the call was refused, and its
                // arguments are separate questions, so a mistake inside one is
                // not hidden by the call's own. `fract(uv * wrap)` is two
                // mistakes. A sample's first argument is the texture, which is
                // not a value.
                const tex = e.callee.k === "ident" && SAMPLES.has(e.callee.name)
                for (const a of tex ? e.args.slice(1) : e.args) attempt(() => checkExpr(fn, a, scope))
                return
            }
            // Each operand on its own, so that while collecting a mistake on one
            // side does not hide one on the other. Without a collector, `attempt`
            // is the plain call, and the first error throws as it always did.
            case "unary":
                checkExpr(fn, e.arg, scope)
                return
            case "binary":
                attempt(() => checkExpr(fn, e.a, scope))
                attempt(() => checkExpr(fn, e.b, scope))
                return
            case "cond":
                attempt(() => checkExpr(fn, e.cond, scope))
                attempt(() => checkExpr(fn, e.then, scope))
                attempt(() => checkExpr(fn, e.else, scope))
                return
        }
    }

    function checkCall(fn: FuncDecl, e: Extract<Expr, { k: "call" }>, scope: Set<string>): void {
        const callee = e.callee

        if (callee.k === "member" && callee.obj.k === "ident" && callee.obj.name === "sdf") {
            if (!(callee.name in SL_SDF_SHAPES)) {
                fail(
                    `"${callee.name}" is not a shape. The 42 names are in SL_SDF_SHAPES; the common ` +
                    `ones are circle, box, roundedBox, segment, hexagon, star5, pie, arc and heart`,
                    callee.pos, callee.name.length,
                )
            }
            for (const a of e.args) checkExpr(fn, a, scope)
            arity(e, "sdf." + callee.name, BUILTINS.sdf!.min, BUILTINS.sdf!.max)
            return
        }

        if (callee.k !== "ident") {
            fail("only a name can be called", callee.pos)
        }
        const n = callee.name

        // A constructor, or a conversion: `float3(...)`, `int(x)`, `bool(x)`.
        if (n in TYPE_WIDTH) {
            for (const a of e.args) checkExpr(fn, a, scope)
            if (e.args.length === 0) fail(`${n}() needs at least one component`, e.pos)
            return
        }

        if (n === "sdf") {
            fail(
                "sdf names a family of shapes, so the shape is part of the call: `sdf.circle(p, r)`, " +
                "`sdf.box(p, float2(0.2, 0.1))`",
                callee.pos, n.length,
            )
        }

        // A value that took a builtin's or a prelude function's name hides it
        // wherever the value is visible.
        const value = scope.has(n) ? "a local" : uniforms.has(n) ? "a uniform" : consts.has(n) ? "a const" : null
        if (value !== null) {
            fail(`"${n}" is ${value} here, so it cannot be called. Rename it to call ${n}(...)`, callee.pos, n.length)
        }
        if (textures.has(n)) {
            fail(`"${n}" is a texture; sample it with \`tex2D(${n}, uv)\``, callee.pos, n.length)
        }

        const builtin = BUILTINS[n]
        if (builtin !== undefined) {
            if (SAMPLES.has(n)) {
                const [tex, ...rest] = e.args
                // HLSL's own tex2Dlod packs the level into a float4 with the uv.
                if (n === "tex2Dlod" && e.args.length === 2) {
                    fail(
                        "tex2Dlod takes the uv and the mip level separately, `tex2Dlod(t, uv, lod)`, " +
                        "rather than HLSL's float4(uv, 0, lod)",
                        e.pos,
                    )
                }
                arity(e, n, builtin.min, builtin.max)
                // The previous frame, unless something in this file took its name.
                const previous = tex?.k === "ident" && tex.name === PREVIOUS && !textures.has(PREVIOUS) &&
                    !scope.has(PREVIOUS) && !uniforms.has(PREVIOUS) && !consts.has(PREVIOUS)
                if (previous && n === "tex2Dlod") {
                    fail(
                        "previous has one level, the frame as drawn, so there is no mip level to pick. " +
                        "Read it with `tex2D(previous, uv)`",
                        e.pos,
                    )
                }
                if (!previous && (tex === undefined || tex.k !== "ident" || !textures.has(tex.name))) {
                    const lod = n === "tex2Dlod" ? ", 0" : ""
                    fail(
                        `${n} samples a texture declared in this file, as in \`texture2D grain;\` ` +
                        `then \`${n}(grain, uv${lod})\``,
                        (tex ?? e).pos,
                    )
                }
                for (const a of rest) checkExpr(fn, a, scope)
                return
            }
            for (const a of e.args) checkExpr(fn, a, scope)
            arity(e, n, builtin.min, builtin.max)
            return
        }

        const user = funcs.get(n)
        if (user !== undefined) {
            for (const a of e.args) checkExpr(fn, a, scope)
            arity(e, n, user.params.length, user.params.length)
            return
        }

        if (NOT_YET[n] !== undefined) {
            fail(
                `${n} has an opcode but no implementation, so it cannot be written yet: ${NOT_YET[n]}`,
                callee.pos, n.length,
            )
        }
        glsl(n, callee.pos, e.args.length)
        unknown(n, scope, callee.pos)
    }

    /** Refuses a GLSL spelling by its HLSL name, with the fix where the rename is certain. */
    function glsl(n: string, pos: Pos, args?: number): void {
        const hint = SL_GLSL_HINT[n]
        if (hint === undefined) return
        const certain = GLSL_RENAMES.has(n) || (n === "atan" && args === 2)
        fail(`${n} is GLSL; this is HLSL, so write ${hint}`, pos, n.length, certain ? rename(n, hint) : undefined)
    }

    function arity(e: Extract<Expr, { k: "call" }>, n: string, min: number, max: number): void {
        if (e.args.length >= min && e.args.length <= max) return
        const want = min === max ? `${min}` : `${min} to ${max}`
        fail(`${n} takes ${want} argument${max === 1 ? "" : "s"}, got ${e.args.length}`, e.pos)
    }

    /** Refuses a name nothing declares, offering the nearest one spelled almost like it. */
    function unknown(n: string, scope: Set<string>, pos: Pos): never {
        const near = nearest(n, [
            ...scope, ...INPUT_NAMES, ...DERIVED_NAMES, ...STEP_NAMES, ...uniforms.keys(), ...textures.keys(), ...consts.keys(),
            ...funcs.keys(), ...Object.keys(BUILTINS),
        ])
        if (near === null) fail(`"${n}" is not declared`, pos, n.length)
        fail(`"${n}" is not declared; did you mean ${near}?`, pos, n.length, rename(n, near))
    }

    return { unit, funcs, uniforms, textures, consts }
}

/**
 * The closest candidate within an edit or two, or nothing.
 *
 * Deliberately tight. A suggestion that is merely the least bad of a list is
 * worse than none: it sends an author to rename something that was never the
 * problem.
 */
export function nearest(word: string, candidates: Iterable<string>): string | null {
    let best: string | null = null
    let bestScore = Infinity
    const limit = word.length <= 4 ? 1 : 2
    for (const c of candidates) {
        if (c === word) continue
        const d = distance(word, c)
        if (d <= limit && d < bestScore) { best = c; bestScore = d }
    }
    return best
}

/**
 * Optimal string alignment: Levenshtein plus transposition at cost one.
 *
 * Plain Levenshtein charges two for a swapped pair, which is the single most
 * common typo there is, so `wrap` for `warp` fell outside a distance of one and
 * the suggestion that would have answered the question was never offered.
 */
function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) return Infinity
    const rows: number[][] = []
    for (let i = 0; i <= a.length; i++) rows.push(new Array<number>(b.length + 1).fill(0))
    for (let i = 0; i <= a.length; i++) rows[i]![0] = i
    for (let j = 0; j <= b.length; j++) rows[0]![j] = j
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            let d = Math.min(rows[i]![j - 1]! + 1, rows[i - 1]![j]! + 1, rows[i - 1]![j - 1]! + cost)
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d = Math.min(d, rows[i - 2]![j - 2]! + 1)
            }
            rows[i]![j] = d
        }
    }
    return rows[a.length]![b.length]!
}

/**
 * Whether a body ends on every way through it in a return, a break or a
 * continue, so nothing after it runs. A loop never counts: its condition, or
 * its turn limit, can always end it. The lowering reads this too, to put what
 * follows an if into the side that does not end.
 */
export function terminates(body: Stmt[]): boolean {
    return body.some((s) => {
        switch (s.k) {
            case "return":
            case "break":
            case "continue": return true
            case "if": return terminates(s.then) && terminates(s.else)
            case "block": return terminates(s.body)
            // A case's break only ends the switch, so it counts only when every
            // case leaves by some other way and a default leaves nothing out.
            case "switch": return s.cases.some((c) => c.labels.includes(null)) && s.cases.every((c) => !c.closed && terminates(c.body))
            default: return false
        }
    })
}

function returnsSomewhere(body: Stmt[]): boolean {
    return body.some((s) => {
        switch (s.k) {
            case "return": return true
            case "if": return returnsSomewhere(s.then) || returnsSomewhere(s.else)
            case "block": return returnsSomewhere(s.body)
            case "for":
            case "while": return returnsSomewhere(s.body)
            case "switch": return s.cases.some((c) => returnsSomewhere(c.body))
            default: return false
        }
    })
}
