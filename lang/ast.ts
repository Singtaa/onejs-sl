/**
 * The AST the parser builds and the checker and lowering walk.
 *
 * Phase A of `Specs/SL_TEXT.md`. Deliberately small: a `.sl` file is one
 * fragment function and its declarations, so there is no module system, no
 * struct, no array and no statement that is not one of six shapes.
 *
 * Every node carries the position of the token it started at. That is what lets
 * an error from the middle of lowering say which character to underline, and it
 * is why the position lives on the node rather than being recovered by a second
 * pass over the source.
 */

import type { Pos } from "./lexer"

/** The four value types, under their HLSL names. `texture2D` is not one: it declares a slot. */
export type TypeName = "float" | "float2" | "float3" | "float4"

export const TYPE_WIDTH: Record<TypeName, 1 | 2 | 3 | 4> = {
    float: 1, float2: 2, float3: 3, float4: 4,
}

export type BinaryOp =
    | "+" | "-" | "*" | "/" | "%"
    | "<" | "<=" | ">" | ">=" | "==" | "!="
    | "&&" | "||"

export type Expr =
    | { k: "num"; value: number; pos: Pos }
    | { k: "hex"; hex: string; pos: Pos }
    | { k: "ident"; name: string; pos: Pos }
    /** A swizzle, or the shape half of `sdf.circle`. Which one is decided later. */
    | { k: "member"; obj: Expr; name: string; pos: Pos }
    | { k: "call"; callee: Expr; args: Expr[]; pos: Pos }
    | { k: "unary"; op: "-" | "+" | "!"; arg: Expr; pos: Pos }
    | { k: "binary"; op: BinaryOp; a: Expr; b: Expr; pos: Pos }
    | { k: "cond"; cond: Expr; then: Expr; else: Expr; pos: Pos }

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%="

export type Stmt =
    | { k: "var"; type: TypeName; name: string; init: Expr; pos: Pos }
    /** A compile time constant: usable as a value and as a `for` bound. */
    | { k: "const"; type: TypeName; name: string; init: Expr; pos: Pos }
    | { k: "assign"; target: Expr; op: AssignOp; value: Expr; pos: Pos }
    | { k: "if"; cond: Expr; then: Stmt[]; else: Stmt[]; pos: Pos }
    | { k: "for"; counter: string; from: Expr; to: Expr; inclusive: boolean; step: Expr; body: Stmt[]; pos: Pos }
    | { k: "return"; value: Expr; pos: Pos }

export interface Param {
    type: TypeName
    name: string
    pos: Pos
}

export interface FuncDecl {
    name: string
    ret: TypeName
    params: Param[]
    body: Stmt[]
    pos: Pos
    /** Prelude functions are shadowed by a function of the same name in the file. */
    prelude: boolean
}

export interface UniformDecl {
    name: string
    type: TypeName
    /** Null when the declaration gave no default; the slot then starts at zero. */
    init: Expr | null
    pos: Pos
}

export interface TextureDecl {
    name: string
    pos: Pos
}

export interface Unit {
    file: string
    uniforms: UniformDecl[]
    textures: TextureDecl[]
    consts: Extract<Stmt, { k: "const" }>[]
    funcs: FuncDecl[]
    /** `float4 main()`. Exactly one per file, and the parser refuses a file without it. */
    main: FuncDecl | null
}
