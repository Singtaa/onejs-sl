/**
 * `onejs-sl/tables`: what completion and highlighting read.
 *
 * The same tables the checker and the emitters use, so an editor offers
 * exactly the builtins that compile, with the arities they take and the names
 * of their parameters (`params.ts`), and the helper library's signatures.
 */
export { BUILTINS, NOT_YET } from "./lang/builtins"
export type { Builtin } from "./lang/builtins"
export {
    SLOP, SL_ARITY, SL_NAME, SL_HLSL, SL_CALL_NAMES, SL_GLSL_HINT, SL_UNIMPLEMENTED,
} from "./ops"
export type { SLSurface } from "./ops"
export { INPUTS } from "./ir"
export { SL_SDF_SHAPES, SL_SDF_PARAMS } from "./shapes"
export { BUILTIN_PARAMS, LIB_SIGNATURES, SL_SDF_PARAM_NAMES } from "./params"
export type { LibSignature } from "./params"
export type { SlSdfKind } from "./shapes"
