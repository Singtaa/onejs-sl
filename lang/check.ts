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
 * SHADOWING IS REFUSED. HLSL would let a local called `time` hide the input, or
 * a parameter called `tint` hide a uniform. Allowing it would mean every later
 * question about a name ("is this a texture?") depends on where it is asked
 * from, for no expressive gain in a language whose functions are half a dozen
 * lines long.
 */

import { INPUTS } from "../ir"
import { VM_TEXTURES, VM_UNIFORMS } from "../ops"
import { SL_GLSL_HINT } from "../ops"
import { BUILTINS, NOT_YET } from "./builtins"
import { SL_SDF_SHAPES } from "../shapes"
import type { Expr, FuncDecl, Stmt, Unit } from "./ast"
import { SLParseError, type Pos } from "./lexer"

const INPUT_NAMES = new Set(Object.keys(INPUTS))

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
}

export function check(unit: Unit, prelude: FuncDecl[], options: CheckOptions = {}): Checked {
    const file = unit.file
    // Annotated rather than inferred: TypeScript only treats a call as
    // terminating control flow when the callee's `never` comes from an explicit
    // type, so without this every `if (x.k !== "ident") fail(...)` below would
    // fail to narrow.
    const fail: (message: string, pos: Pos, length?: number) => never =
        (message, pos, length = 1) => {
            throw new SLParseError(message, file, pos, length)
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
     * (`Specs/SL_TEXT.md` 3.8). Every other kind of declaration checks `asFunc`
     * as well, so only a function may take a function's name.
     */
    const taken = (n: string): string | null => {
        if (INPUT_NAMES.has(n)) return "an input"
        if (BUILTINS[n] !== undefined) return "a builtin"
        if (n === "sdf") return "the sdf shape family"
        if (n === "main") return "the fragment function"
        if (uniforms.has(n)) return "a uniform"
        if (textures.has(n)) return "a texture"
        if (consts.has(n)) return "a const"
        return null
    }

    const asFunc = (n: string): string | null => {
        const fn = funcs.get(n)
        if (fn === undefined) return null
        return fn.prelude ? "a prelude function" : "a function"
    }

    for (const u of unit.uniforms) {
        const clash = taken(u.name) ?? asFunc(u.name)
        if (clash !== null) fail(`"${u.name}" already names ${clash}`, u.pos, u.name.length)
        uniforms.set(u.name, u)
    }
    if (uniforms.size > VM_UNIFORMS) {
        const over = unit.uniforms[VM_UNIFORMS]!
        fail(
            `this file declares ${uniforms.size} uniforms and a program may hold ${VM_UNIFORMS}. ` +
            `That is the size of the VM's uniform array; past it a slot reads the last one instead ` +
            `of its own, so it is refused here rather than rendered wrong. Pack related values into ` +
            `a float4.`,
            over.pos, over.name.length,
        )
    }

    for (const t of unit.textures) {
        const clash = taken(t.name) ?? asFunc(t.name)
        if (clash !== null) fail(`"${t.name}" already names ${clash}`, t.pos, t.name.length)
        textures.set(t.name, t)
    }
    if (textures.size > VM_TEXTURES) {
        const over = unit.textures[VM_TEXTURES]!
        fail(
            `this file declares ${textures.size} textures and a program may sample ${VM_TEXTURES}. ` +
            `The VM shader declares four samplers; a fifth would sample the fourth in the browser ` +
            `and its own after an eject, which is two different pictures from one file.`,
            over.pos, over.name.length,
        )
    }

    for (const c of unit.consts) {
        const clash = taken(c.name) ?? asFunc(c.name)
        if (clash !== null) fail(`"${c.name}" already names ${clash}`, c.pos, c.name.length)
        consts.set(c.name, c)
    }

    for (const fn of unit.funcs) {
        const clash = taken(fn.name)
        if (clash !== null) fail(`"${fn.name}" already names ${clash}`, fn.pos, fn.name.length)
        if (unit.funcs.filter((f) => f.name === fn.name).length > 1) {
            fail(
                `this file declares ${fn.name} more than once. There is no overloading: a function ` +
                `inlines, so two bodies under one name have nothing to pick between them`,
                fn.pos, fn.name.length,
            )
        }
        funcs.set(fn.name, fn)
    }

    const main = unit.main
    if (main === null) {
        if (options.requireMain ?? true) throw new Error("check() reached a unit with no main")
        for (const fn of unit.funcs) checkFunction(fn)
        refuseRecursion()
        return { unit, funcs, uniforms, textures, consts }
    }
    if (main.ret !== "float4") {
        fail(`main returns a colour, so it is declared \`float4 main()\`, not ${main.ret}`, main.pos)
    }
    if (main.params.length > 0) {
        fail(
            "main takes no parameters: what a program is given are the free identifiers uv, " +
            "fragCoord, resolution, time and aspect",
            main.params[0]!.pos,
        )
    }

    // MARK: bodies

    // The prelude's own bodies are checked once, where it is built, against a
    // unit that has no uniforms of its own. Re-checking them here would let a
    // file declaring `uniform float p;` fail on a prelude parameter called `p`,
    // which is not the author's mistake and not a name they can see.
    for (const fn of [...unit.funcs, main]) checkFunction(fn)

    refuseRecursion()

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
                case "for": expr(s.from); expr(s.to); expr(s.step); s.body.forEach(stmt); return
                case "return": expr(s.value); return
            }
        }
        body.forEach(stmt)
        return out
    }

    function checkFunction(fn: FuncDecl): void {
        const params = new Set<string>()
        for (const p of fn.params) {
            const clash = taken(p.name) ?? asFunc(p.name)
            if (clash !== null) fail(`"${p.name}" already names ${clash}`, p.pos, p.name.length)
            if (params.has(p.name)) fail(`${fn.name} already has a parameter called "${p.name}"`, p.pos)
            params.add(p.name)
        }
        checkBody(fn, fn.body, new Set(params), true)
    }

    /**
     * `outermost` is the only place a `return` may stand.
     *
     * `Specs/SL_TEXT.md` 9.2: an `if` lowers to a `select`, which evaluates both
     * sides, so there is nothing for an early return to skip. Refusing it is
     * what keeps that cost honest rather than pretending a branch happened.
     */
    function checkBody(fn: FuncDecl, body: Stmt[], scope: Set<string>, outermost: boolean): void {
        let returned: Stmt | null = null
        for (const s of body) {
            if (returned !== null) {
                fail("this is after the return, so it can never run", s.pos)
            }
            switch (s.k) {
                case "var":
                case "const": {
                    const clash = taken(s.name) ?? asFunc(s.name)
                    if (clash !== null) fail(`"${s.name}" already names ${clash}`, s.pos, s.name.length)
                    if (scope.has(s.name)) fail(`"${s.name}" is already declared in this body`, s.pos)
                    checkExpr(fn, s.init, scope)
                    scope.add(s.name)
                    break
                }
                case "assign": {
                    if (s.target.k === "member") {
                        fail(
                            "a swizzle is read only; build the value you want instead, as in " +
                            "`p = float2(1, p.y);`",
                            s.target.pos,
                        )
                    }
                    if (s.target.k !== "ident") fail("only a local can be assigned to", s.target.pos)
                    const n = s.target.name
                    const why = taken(n)
                    if (why !== null) fail(`"${n}" is ${why} and cannot be assigned to`, s.target.pos, n.length)
                    if (counters.has(n)) {
                        fail(
                            `"${n}" is a loop counter. The loop unrolls and substitutes it as a ` +
                            `number, so assigning to it would change nothing. Use another local`,
                            s.target.pos, n.length,
                        )
                    }
                    if (!scope.has(n)) {
                        fail(unknown(n, scope), s.target.pos, n.length)
                    }
                    checkExpr(fn, s.value, scope)
                    break
                }
                case "if":
                    checkExpr(fn, s.cond, scope)
                    checkBody(fn, s.then, new Set(scope), false)
                    checkBody(fn, s.else, new Set(scope), false)
                    break
                case "for": {
                    const clash = taken(s.counter) ?? asFunc(s.counter)
                    if (clash !== null) fail(`"${s.counter}" already names ${clash}`, s.pos, s.counter.length)
                    if (scope.has(s.counter)) fail(`"${s.counter}" is already declared in this body`, s.pos)
                    checkExpr(fn, s.from, scope)
                    checkExpr(fn, s.to, scope)
                    checkExpr(fn, s.step, scope)
                    const inner = new Set(scope)
                    inner.add(s.counter)
                    counters.add(s.counter)
                    checkBody(fn, s.body, inner, false)
                    counters.delete(s.counter)
                    break
                }
                case "return":
                    if (!outermost) {
                        fail(
                            "a return inside an if or a for has nothing to skip: an if evaluates " +
                            "both sides and a for unrolls, so there is no branch to leave early. " +
                            "Assign to a local and return it once at the end, or use ?:",
                            s.pos,
                        )
                    }
                    checkExpr(fn, s.value, scope)
                    returned = s
                    break
            }
        }
        if (outermost && returned === null) {
            fail(`${fn.name} never returns a ${fn.ret}`, fn.pos, fn.name.length)
        }
    }

    // MARK: expressions

    function checkExpr(fn: FuncDecl, e: Expr, scope: Set<string>): void {
        switch (e.k) {
            case "num":
            case "hex":
                return
            case "ident": {
                if (scope.has(e.name) || INPUT_NAMES.has(e.name) || uniforms.has(e.name) || consts.has(e.name)) return
                if (textures.has(e.name)) {
                    fail(
                        `"${e.name}" is a texture, and a texture is only ever the first argument of ` +
                        `tex2D. Write \`tex2D(${e.name}, uv)\``,
                        e.pos, e.name.length,
                    )
                }
                if (e.name === "sdf") {
                    fail("sdf names a family of shapes; call one, as in `sdf.circle(p, r)`", e.pos, 3)
                }
                if (funcs.has(e.name) || BUILTINS[e.name] !== undefined) {
                    fail(`${e.name} is a function; call it, as in \`${e.name}(...)\``, e.pos, e.name.length)
                }
                fail(unknown(e.name, scope), e.pos, e.name.length)
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
            case "call":
                checkCall(fn, e, scope)
                return
            case "unary":
                checkExpr(fn, e.arg, scope)
                return
            case "binary":
                checkExpr(fn, e.a, scope)
                checkExpr(fn, e.b, scope)
                return
            case "cond":
                checkExpr(fn, e.cond, scope)
                checkExpr(fn, e.then, scope)
                checkExpr(fn, e.else, scope)
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

        if (n === "float2" || n === "float3" || n === "float4" || n === "float") {
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

        const builtin = BUILTINS[n]
        if (builtin !== undefined) {
            if (n === "tex2D") {
                const [tex, ...rest] = e.args
                arity(e, n, builtin.min, builtin.max)
                if (tex === undefined || tex.k !== "ident" || !textures.has(tex.name)) {
                    fail(
                        `tex2D samples a texture declared in this file, as in \`texture2D grain;\` ` +
                        `then \`tex2D(grain, uv)\``,
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
        if (SL_GLSL_HINT[n] !== undefined) {
            fail(`${n} is GLSL; this is HLSL, so write ${SL_GLSL_HINT[n]}`, callee.pos, n.length)
        }
        if (textures.has(n)) {
            fail(`"${n}" is a texture; sample it with \`tex2D(${n}, uv)\``, callee.pos, n.length)
        }
        fail(unknown(n, scope), callee.pos, n.length)
    }

    function arity(e: Extract<Expr, { k: "call" }>, n: string, min: number, max: number): void {
        if (e.args.length >= min && e.args.length <= max) return
        const want = min === max ? `${min}` : `${min} to ${max}`
        fail(`${n} takes ${want} argument${max === 1 ? "" : "s"}, got ${e.args.length}`, e.pos)
    }

    /** "unknown x" plus the nearest thing that is spelled almost like it. */
    function unknown(n: string, scope: Set<string>): string {
        const near = nearest(n, [
            ...scope, ...INPUT_NAMES, ...uniforms.keys(), ...textures.keys(), ...consts.keys(),
            ...funcs.keys(), ...Object.keys(BUILTINS),
        ])
        return near === null ? `"${n}" is not declared` : `"${n}" is not declared; did you mean ${near}?`
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
