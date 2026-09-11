/**
 * Source to AST. A Pratt parser, because expressions are the interesting half.
 *
 * Phase A of `Specs/SL_TEXT.md` section 4. This file decides SHAPE only: what
 * is a declaration, what is a statement, how tightly `*` binds against `+`. It
 * knows nothing about types, about which names exist, or about what any of it
 * lowers to, and it never touches the IR. Everything it refuses, it refuses
 * because the characters cannot be read any other way.
 *
 * HLSL precedence, so that an expression copied out of a `.shader` file means
 * here what it meant there. That is the whole promise of choosing HLSL.
 */

import {
    TYPE_WIDTH,
    type AssignOp, type BinaryOp, type Expr, type FuncDecl, type Param, type Stmt,
    type TextureDecl, type TypeName, type UniformDecl, type Unit,
} from "./ast"
import { SLParseError, tokenize, type Pos, type Token } from "./lexer"

const TYPE_NAMES = new Set(Object.keys(TYPE_WIDTH))

/**
 * Type spellings that exist in HLSL or GLSL and not here, each with the reason.
 *
 * `Specs/SL_TEXT.md` section 2: the IR bounds what the language can say, on
 * purpose. A name in this table gets the reason; a name outside it gets
 * "unknown", and the difference is most of what makes the language learnable.
 */
const NOT_A_TYPE: Record<string, string> = {
    vec2: "use float2",
    vec3: "use float3",
    vec4: "use float4",
    int: "there are no integers; a whole number is a float, so write float",
    uint: "there are no integers; a whole number is a float, so write float",
    bool: "there is no bool; a comparison is a float that is 0 or 1",
    half: "use float; the IR has one precision",
    double: "use float; the IR has one precision",
    fixed: "use float; the IR has one precision",
    float2x2: "there are no matrices",
    float3x3: "there are no matrices",
    float4x4: "there are no matrices",
    sampler2D: "use texture2D to declare a texture slot",
    void: "every function returns a value",
    struct: "there are no structs",
}

/** Binding power per binary operator, HLSL's. Higher binds tighter. */
const BINDING: Record<string, number> = {
    "||": 1,
    "&&": 2,
    "==": 3, "!=": 3,
    "<": 4, "<=": 4, ">": 4, ">=": 4,
    "+": 5, "-": 5,
    "*": 6, "/": 6, "%": 6,
}

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%="])

class Parser {
    private i = 0

    constructor(
        private readonly tokens: Token[],
        private readonly file: string,
        private readonly requireMain: boolean,
    ) {}

    // MARK: token plumbing

    private peek(n = 0): Token { return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]! }
    private next(): Token { return this.tokens[this.i++]! }
    private at(text: string): boolean { const t = this.peek(); return t.kind !== "eof" && t.text === text }
    private eat(text: string): boolean { if (this.at(text)) { this.i++; return true } return false }

    private fail(message: string, at: Token = this.peek()): never {
        throw new SLParseError(message, this.file, at as Pos, Math.max(1, at.text.length))
    }

    private expect(text: string, what: string): Token {
        if (!this.at(text)) {
            const got = this.peek()
            this.fail(`expected "${text}" ${what}, got ${describe(got)}`, got)
        }
        return this.next()
    }

    private expectIdent(what: string): Token {
        const t = this.peek()
        if (t.kind !== "ident") this.fail(`expected ${what}, got ${describe(t)}`, t)
        return this.next()
    }

    private expectType(what: string): TypeName {
        const t = this.expectIdent(what)
        if (TYPE_NAMES.has(t.text)) return t.text as TypeName
        const why = NOT_A_TYPE[t.text]
        if (why !== undefined) this.fail(`"${t.text}" is not a type here: ${why}`, t)
        this.fail(`"${t.text}" is not a type; the types are float, float2, float3 and float4`, t)
    }

    // MARK: the file

    parseUnit(): Unit {
        const unit: Unit = {
            file: this.file, uniforms: [], textures: [], consts: [], funcs: [], main: null,
        }

        while (this.peek().kind !== "eof") {
            const t = this.peek()

            if (t.text === "uniform") { unit.uniforms.push(this.parseUniform()); continue }
            if (t.text === "texture2D") { unit.textures.push(this.parseTexture()); continue }
            if (t.text === "const") {
                const c = this.parseConst()
                unit.consts.push(c)
                continue
            }
            if (t.kind === "ident") {
                const fn = this.parseFunction()
                if (fn.name === "main") {
                    if (unit.main !== null) {
                        this.fail("this file already declares main; a .sl file is exactly one fragment function", t)
                    }
                    unit.main = fn
                } else {
                    unit.funcs.push(fn)
                }
                continue
            }
            this.fail(
                `expected a declaration (uniform, texture2D, const, or a function), got ${describe(t)}`, t,
            )
        }

        if (unit.main === null && this.requireMain) {
            this.fail(
                "this file declares no main. A .sl file is one fragment function: add " +
                "`float4 main() { ... }`",
                this.peek(),
            )
        }
        return unit
    }

    private parseUniform(): UniformDecl {
        const kw = this.next()
        const type = this.expectType("a type after uniform")
        const name = this.expectIdent("a uniform name")
        let init: Expr | null = null
        if (this.eat("=")) init = this.parseExpr()
        this.expect(";", "after a uniform declaration")
        return { name: name.text, type, init, pos: kw }
    }

    private parseTexture(): TextureDecl {
        const kw = this.next()
        const name = this.expectIdent("a texture name")
        if (this.at("=")) {
            this.fail(
                "a texture has no default; the host binds it by name through the textures prop",
                this.peek(),
            )
        }
        this.expect(";", "after a texture declaration")
        return { name: name.text, pos: kw }
    }

    private parseConst(): Extract<Stmt, { k: "const" }> {
        const kw = this.next()
        const type = this.expectType("a type after const")
        const name = this.expectIdent("a name")
        this.expect("=", "after a const's name; a const has to have a value")
        const init = this.parseExpr()
        this.expect(";", "after a const")
        return { k: "const", type, name: name.text, init, pos: kw }
    }

    private parseFunction(): FuncDecl {
        const start = this.peek()
        const ret = this.expectType("a return type")
        const name = this.expectIdent("a function name")
        if (!this.at("(")) {
            this.fail(
                `expected "(" after ${name.text}. Only uniforms, textures, consts and functions live ` +
                `at the top level of a file; a value belongs inside main or a function`,
                this.peek(),
            )
        }
        this.next()
        const params: Param[] = []
        if (!this.at(")")) {
            for (;;) {
                const p = this.peek()
                const ptype = this.expectType("a parameter type")
                const pname = this.expectIdent("a parameter name")
                params.push({ type: ptype, name: pname.text, pos: p })
                if (!this.eat(",")) break
            }
        }
        this.expect(")", "after the parameters")
        const body = this.parseBlock()
        return { name: name.text, ret, params, body, pos: start, prelude: false }
    }

    // MARK: statements

    private parseBlock(): Stmt[] {
        this.expect("{", "to open a body")
        const out: Stmt[] = []
        while (!this.at("}")) {
            if (this.peek().kind === "eof") this.fail("this body is never closed", this.peek())
            out.push(this.parseStmt())
        }
        this.next()
        return out
    }

    /** A braced block, or the single statement HLSL lets an `if` or `for` carry. */
    private parseBody(): Stmt[] {
        if (this.at("{")) return this.parseBlock()
        return [this.parseStmt()]
    }

    private parseStmt(): Stmt {
        const t = this.peek()

        if (t.text === "const") return this.parseConst()
        if (t.text === "if") return this.parseIf()
        if (t.text === "for") return this.parseFor()
        if (t.text === "while" || t.text === "do") {
            this.fail(
                `there is no ${t.text} loop: the VM has no branches, so a loop has to unroll, and ` +
                `only a for loop with constant bounds can. See a for loop`,
                t,
            )
        }
        if (t.text === "discard") {
            this.fail("there is no discard; return a colour with alpha 0 instead", t)
        }
        if (t.text === "return") {
            this.next()
            const value = this.parseExpr()
            this.expect(";", "after a return")
            return { k: "return", value, pos: t }
        }
        if (t.text === "uniform" || t.text === "texture2D") {
            this.fail(`a ${t.text} is declared at the top level of the file, not inside a body`, t)
        }

        // A declaration is a type followed by a name. Anything else starting
        // with an identifier is an expression, and the only expression a
        // statement may be is the left of an assignment.
        if (t.kind === "ident" && this.peek(1).kind === "ident") {
            const type = this.expectType("a type")
            const name = this.expectIdent("a name")
            if (this.at("(")) {
                this.fail(
                    "a function is declared at the top level of the file, not inside another function",
                    this.peek(),
                )
            }
            this.expect("=", `after ${name.text}; every local is declared with a value`)
            const init = this.parseExpr()
            this.expect(";", "after a declaration")
            return { k: "var", type, name: name.text, init, pos: t }
        }

        const target = this.parseExpr()
        const op = this.peek()
        if (op.kind === "punct" && ASSIGN_OPS.has(op.text)) {
            this.next()
            const value = this.parseExpr()
            this.expect(";", "after an assignment")
            return { k: "assign", target, op: op.text as AssignOp, value, pos: t }
        }
        if (op.text === "++" || op.text === "--") {
            this.fail(`${op.text} is only a for loop's update; write \`x = x + 1;\``, op)
        }
        this.fail(
            "this statement has no effect. A statement is a declaration, an assignment, an if, a " +
            "for or a return",
            t,
        )
    }

    private parseIf(): Stmt {
        const kw = this.next()
        this.expect("(", "after if")
        const cond = this.parseExpr()
        this.expect(")", "after an if condition")
        const then = this.parseBody()
        let otherwise: Stmt[] = []
        if (this.at("else")) {
            this.next()
            otherwise = this.at("if") ? [this.parseIf()] : this.parseBody()
        }
        return { k: "if", cond, then, else: otherwise, pos: kw }
    }

    /**
     * `for (int i = A; i < B; i++)`, and nothing more exotic than `i += K`.
     *
     * The shape is narrow because the loop UNROLLS: the counter is a compile
     * time number, not a value, and every form this refuses is one where it
     * could not be. Section 3.6 of the spec, and the error says so rather than
     * leaving an author to guess which part offended.
     */
    private parseFor(): Stmt {
        const kw = this.next()
        this.expect("(", "after for")

        const decl = this.peek()
        if (decl.text !== "int" && decl.text !== "float") {
            this.fail(
                `a for loop starts by declaring its counter, as in \`for (int i = 0; i < 4; i++)\`, ` +
                `got ${describe(decl)}`, decl,
            )
        }
        this.next()
        const counter = this.expectIdent("a counter name")
        this.expect("=", "after the counter")
        const from = this.parseExpr()
        this.expect(";", "after the counter's start")

        const lhs = this.expectIdent("the counter in the loop's condition")
        if (lhs.text !== counter.text) {
            this.fail(`this loop counts ${counter.text}, so its condition has to test ${counter.text}`, lhs)
        }
        const cmp = this.peek()
        if (cmp.text !== "<" && cmp.text !== "<=") {
            this.fail(
                `a for loop counts up, so its condition is \`${counter.text} <\` or \`${counter.text} <=\`, ` +
                `got ${describe(cmp)}`, cmp,
            )
        }
        this.next()
        const to = this.parseExpr()
        this.expect(";", "after the loop's bound")

        const up = this.expectIdent("the counter in the loop's update")
        if (up.text !== counter.text) {
            this.fail(`this loop counts ${counter.text}, so its update has to change ${counter.text}`, up)
        }
        let step: Expr = { k: "num", value: 1, pos: up }
        if (this.eat("++")) {
            // nothing: the step is 1
        } else if (this.eat("+=")) {
            step = this.parseExpr()
        } else {
            this.fail(
                `a for loop's update is \`${counter.text}++\` or \`${counter.text} += n\`, got ` +
                `${describe(this.peek())}`, this.peek(),
            )
        }
        this.expect(")", "after the loop's update")
        const body = this.parseBody()
        return { k: "for", counter: counter.text, from, to, inclusive: cmp.text === "<=", step, body, pos: kw }
    }

    // MARK: expressions

    parseExpr(): Expr { return this.parseBinary(0) }

    private parseBinary(min: number): Expr {
        let left = this.parseUnary()
        for (;;) {
            const t = this.peek()
            if (t.kind !== "punct") break
            const bp = BINDING[t.text]
            if (bp === undefined || bp < min) break
            this.next()
            const right = this.parseBinary(bp + 1)
            left = { k: "binary", op: t.text as BinaryOp, a: left, b: right, pos: t }
        }
        // The conditional binds looser than every binary operator and is right
        // associative, so `a ? b : c ? d : e` groups to the right, as in HLSL.
        if (min === 0 && this.at("?")) {
            const q = this.next()
            const then = this.parseExpr()
            this.expect(":", "in a ?: conditional")
            const otherwise = this.parseExpr()
            return { k: "cond", cond: left, then, else: otherwise, pos: q }
        }
        return left
    }

    private parseUnary(): Expr {
        const t = this.peek()
        if (t.kind === "punct" && (t.text === "-" || t.text === "+" || t.text === "!")) {
            this.next()
            return { k: "unary", op: t.text, arg: this.parseUnary(), pos: t }
        }
        if (t.text === "++" || t.text === "--") {
            this.fail(`${t.text} is only a for loop's update`, t)
        }
        return this.parsePostfix(this.parsePrimary())
    }

    private parsePostfix(expr: Expr): Expr {
        for (;;) {
            if (this.at(".")) {
                this.next()
                const name = this.expectIdent("a component or a shape name after \".\"")
                expr = { k: "member", obj: expr, name: name.text, pos: name }
                continue
            }
            if (this.at("(")) {
                const open = this.next()
                const args: Expr[] = []
                if (!this.at(")")) {
                    for (;;) {
                        args.push(this.parseExpr())
                        if (!this.eat(",")) break
                    }
                }
                this.expect(")", "after the arguments")
                expr = { k: "call", callee: expr, args, pos: open }
                continue
            }
            if (this.at("[")) {
                this.fail("there are no arrays; index a component with .x, .y, .z or .w", this.peek())
            }
            return expr
        }
    }

    private parsePrimary(): Expr {
        const t = this.next()
        if (t.kind === "number") return { k: "num", value: t.value!, pos: t }
        if (t.kind === "hex") return { k: "hex", hex: t.text, pos: t }
        if (t.kind === "ident") return { k: "ident", name: t.text, pos: t }
        if (t.text === "(") {
            const inner = this.parseExpr()
            this.expect(")", "to close a group")
            return inner
        }
        this.fail(`expected a value, got ${describe(t)}`, t)
    }
}

function describe(t: Token): string {
    if (t.kind === "eof") return "the end of the file"
    return `"${t.text}"`
}

export interface ParseOptions {
    file?: string
    /**
     * Off for the prelude, which is a library of functions and has no main.
     * Nothing else should turn it off: a `.sl` file without a main renders
     * nothing, and finding that out at parse time is the point.
     */
    requireMain?: boolean
}

export function parseUnit(source: string, options: ParseOptions = {}): Unit {
    const file = options.file ?? "program.sl"
    return new Parser(tokenize(source, file), file, options.requireMain ?? true).parseUnit()
}
