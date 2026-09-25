/**
 * `onejs-sl`: the shader language, with no Unity in it.
 *
 * Source text or the TypeScript form in, a `Program` out: a flat typed graph
 * with a hash. Everything a host does with a program (run it on the VM, emit
 * HLSL, WGSL or GLSL ES) is a separate entry, so a host bundles only what it
 * calls:
 *
 *   onejs-sl             this: parse, classify, the TypeScript form, the IR, its JSON
 *   onejs-sl/core        the same without the parser, for a game at run time
 *   onejs-sl/tables      builtins, opcodes, inputs, shapes: what an editor reads
 *   onejs-sl/limits      whether a program fits the VM, without encoding it
 *   onejs-sl/vm          the VM encoder
 *   onejs-sl/emit/unity  the ShaderLab shader a Unity editor generates
 *   onejs-sl/emit/web    WGSL and GLSL ES with OneJS's web frame
 *
 * Plain TypeScript with no Node or DOM API anywhere, so it runs in a browser,
 * a Cloudflare worker, and QuickJS; `npm run test:quickjs` holds it to that.
 */
export * from "./core"
export {
    analyze, classify, parse, parseUnit, preludeFunctions, tokenize, PRELUDE_SOURCE, SLParseError,
} from "./lang"
export type {
    Checked, Expr, FuncDecl, ParseOptions, Pos, SLClassifiedToken, SLFix, SLTokenClass, Stmt, Token, Unit,
} from "./lang"
