/**
 * `onejs-sl/tables`: what completion and highlighting read.
 *
 * The same tables the checker and the emitters use, so an editor offers
 * exactly the builtins that compile, with the arities they take, the names of
 * their parameters and a line on each (`params.ts`), the words the parser
 * reads as syntax, and the helper library's signatures. `classify`, in the
 * main entry, is the highlighter built on the same lists.
 */
export { BUILTINS, NOT_YET } from "./lang/builtins"
export type { Builtin } from "./lang/builtins"
export {
    SLOP, SL_ARITY, SL_NAME, SL_HLSL, SL_CALL_NAMES, SL_GLSL_HINT, SL_UNIMPLEMENTED,
} from "./ops"
export type { SLSurface } from "./ops"
export { INPUTS } from "./ir"
export { SL_SDF_SHAPES, SL_SDF_PARAMS } from "./shapes"
export { BUILTIN_DOCS, BUILTIN_PARAMS, INPUT_DOCS, LIB_SIGNATURES, SL_SDF_PARAM_NAMES } from "./params"
export { PRELUDE_DOCS, PRELUDE_NAMES } from "./lang/prelude-source"
export { SL_KEYWORDS, SL_TYPES } from "./lang/words"
export { TYPE_WIDTH } from "./lang/ast"
export type { TypeName } from "./lang/ast"
export type { LibSignature } from "./params"
export type { SlSdfKind } from "./shapes"
