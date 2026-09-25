# `.sl`: the shader language as a file

Phase A of `Specs/SL_TEXT.md`. Source text in, the same `Program` the EDSL
records out.

```hlsl
// plasma.sl
uniform float warp = 0.5;
uniform float hue = 0.5;

float4 main() {
    float2 p = (uv - 0.5) * (warp * 14 + 2);
    float v = sin(p.x + time) + sin(p.y - time * 0.8);
    float n = saturate(v * 0.22 + 0.5);
    return float4(hsv2rgb(float3(frac(hue + n * 0.18), 0.75, n)), 1);
}
```

```ts
import { parse } from "onejs-sl"
const plasma = parse(source, { file: "plasma.sl" })
```

## The one idea

**It is not a second language.** Every construct lowers through the EDSL, so
`sin(x)` in a file is the same `sl.sin(x)` call a TypeScript author would have
written, and the two produce the same graph. `parity.test.ts` asserts that as
hash equality for every GPU fixture and for the example on play.onejs.com: same
hash means same generated shader and same pixels, established without rendering
anything. It also means the existing GPU fixtures, the codegen goldens and the
C# VM tests cover the text form for free, because they run on the IR.

If that property ever breaks, the failure is silent in the worst way: a program
whose hash does not match its generated shader falls back to the VM and nobody
is told. So parity is the test to keep green, not the parser's unit tests.

| File | What it does |
|---|---|
| `lexer.ts` | Characters to tokens, each carrying line and column |
| `ast.ts` | The node shapes, all of them, which is not many |
| `parser.ts` | Pratt parser: shape only, HLSL precedence |
| `check.ts` | Declarations, names, statement shape, budgets, recursion |
| `lower.ts` | AST to IR through the EDSL: SSA, unrolling, `select`, inlining |
| `builtins.ts` | What each name does, keyed by the spelling `ops.ts` gives it |
| `prelude.ts` | The standard library, written in the language |
| `onejs-unity`'s `src/esbuild/sl.mjs` | The loader: `import plasma from "./plasma.sl"` |
| `../index.ts` and `../core.ts` | The package with the parser, and without it. See below |

## The loader

`slPlugin()`, in onejs-unity's `onejs-unity/esbuild`, parses and encodes at BUILD TIME, so an import resolves to a small
object of numbers and the bundle carries neither the parser nor the source. A
parse error becomes an esbuild error with the file, line and column, which the
Play editor surfaces and every terminal editor links.

It writes two things beside the code:

- **`<name>.sl.d.ts`**, the way a USS module gets one, carrying the uniform
  names in the type. `uniforms={{ wrap: 1 }}` is then a call site error rather
  than a console warning on a frame nobody is looking at.
- **`app.sl.json`** beside the bundle, the manifest `SLShaderGenerator` already
  watches for. This is the thing the file format makes possible and the EDSL
  cannot: a program in a file is known statically, so **an ejected game is
  compiled from its first frame** rather than from its second. Runtime
  recording stays for EDSL programs and for a build older than the loader; the
  editor reads every `*.sl.json` it can find.

An empty manifest is written only over one that is already there. Deleting the
last `.sl` file has to stop its shaders being generated, and a project that has
never had one should not find a new file beside its bundle.

### Why the parser is compiled rather than imported

The parser is TypeScript and the plugin runs under plain Node: an app's
`esbuild.config.mjs` is executed by `node`, which cannot load a `.ts` file.
Every plugin in that folder has the same constraint, which is why the Tailwind
generator beside them is `.mjs`; a parser with two hundred tests is not going
to be maintained twice.

So the plugin compiles `sl/compiler.ts` once per process, with the esbuild
already running the build, and imports the result: one source of truth, no
generated artifact to go stale, about thirty milliseconds once. A Cloudflare
Worker cannot evaluate code it builds, so PlaySite imports the parser
statically and hands it in as `compiler`, and that path never runs there.

### Why there are two barrels

`onejs-sl/core` is what a **game** imports (through `onejs-unity/sl`), and the
Play eject scaffold vendors every file it reaches into the downloaded project.
`onejs-sl`, which adds this folder, is what a **build** imports (through
`onejs-unity/sl/compiler`). Re-exporting the parser from the first put two thousand
lines a played game never executes into every ejected project's source tree,
where they could only read as clutter. The scaffold vendors what an entry actually
reaches rather than every file beside it, so the split is enforced by the
eject's own test.

## Where the types are checked

In `lower.ts`, once, by the EDSL, which computes a width as it records. A
declaration is then an **assertion** against that width rather than an input to
inference. `check.ts` deliberately does no type inference: two implementations
of a type system are two type systems, and the one that would have been written
here is the one nothing else uses.

## What surprises people

**A scalar on the left of an operator broadcasts through a swizzle.** `uv * 8`
is `uv.mul(8)`, one constant node of two components. `8 * uv` is
`sl.float(8).mul(uv)`, a one component constant and a broadcast. Same picture,
different graph, different hash. Write the vector on the left when it matters.

**Literal arithmetic folds; a builtin call never does.** `2 * 3 + 1` is the
constant 7 before the IR sees it. `sin(0.5)` is two instructions, because
folding it would mean a second implementation of `sin` in JavaScript, and a
second implementation is somewhere for the two backends to disagree.

**A hex default makes a uniform a colour.** `uniform float4 tint = #ff8040;`
stores the sRGB components as its default, which is what the host sets and what
the generated shader's Properties block shows, and every read of `tint` goes
through `toLinear`. Without that rule, `#ff8040` written as a literal and
`#ff8040` written as a default would be two different colours in one file.
A default built out of numbers (`float4(1, 0.5, 0.25, 1)`) is not a colour and
is read unconverted.

**A uniform's default has to be written out.** Numbers, constructors of numbers
and colours, and nothing else. It is baked into the program before anything
runs, so it cannot name a const, which could itself name a uniform.

**Shadowing is refused between values.** A local may not take the name of an
input, a uniform, a texture or a const. Allowing it would make "is this a
texture?" depend on where the question is asked, for no gain in a language whose
functions are six lines long. A value *may* take a builtin's or a prelude
function's name (`float circle`, `uniform float turbulence`), which hides that
function wherever the value is visible, and a call there says so. A file
function may shadow a *prelude* function, which is the sanctioned way to replace
one.

**Declarations and assignments convert two ways, and only two.** A single
number fills every component (`float3 c = 0.5;`, and a uniform default such as
`uniform float2 offset = 0;`), and a float4 goes into a float3 by dropping its
fourth component, which is how a colour becomes an rgb. Every other width change
is refused with the swizzle that fixes it.

**A swizzle can be assigned to.** `p.x *= aspect;` rebuilds `p` from the
components it names and keeps the rest, so it is the same program as
`p = float2(p.x * aspect, p.y);`. A swizzle that names a component twice, or
one the local does not have, is refused.

## Not yet spellable

Three things the EDSL or the opcode table has and a file cannot say. Each is a
recorded gap, not an oversight, and each has its own error message rather than
"unknown identifier".

| | Why |
|---|---|
| `rgb2hsv`, `tex2Dlod` | The opcodes are numbered and **neither backend implements them**. Writing one would render as whatever the VM's dispatch falls through to and fail outright in the HLSL emitter. |
| `fbm`'s simplex base | `sl.fbm(p, octaves, "simplex")` picks the base with a string, and the language has no strings. `fbm(p, octaves)` is the value base, and `turbulence` and `ridged` are the simplex family. |

Related, and worth knowing: **the EDSL lets a program declare 15 textures and
the VM has 4.** `ir.ts` picked its ceiling from the WebGL2 sampler count rather
than from `FxProgram.shader`, which declares `_Tex0` to `_Tex3` and samples
`_Tex3` for every slot past it, so slots 4 and up are silently wrong in the
browser and correct after an eject. A `.sl` file is held to the real number, 4,
reported at the declaration. The EDSL's ceiling is untouched here because
lowering it changes recorded behaviour rather than parser behaviour.

## Errors

Every one carries file, line, column, offset and length, and `text`, the
message without its tag and its `file:line:col: `, for an editor that puts the
words in a marker of its own. An error that starts inside the EDSL keeps the
EDSL's wording, with its type names put in the file's: `"z" is component 3 of
a float2, which has 2` was already the right sentence; what it lacked was a
place. `errors.test.ts` checks the positions as strictly as the words, because
a marker under the wrong character sends the reader to look at something that
is fine. Something missing at the end of a line or the file marks the last
token before it, where there is a character to underline.

Where the fix is certain, the error carries it as `fix`: a title and the text
for the marked range, one click in an editor. A GLSL spelling that means the
same in HLSL (`mix`, `fract`, `vec3`, `gl_FragCoord`, `iTime`, two argument
`atan`) and a "did you mean" both have one. `mod` does not, since GLSL's floors
and `%` truncates, and neither does `int`, since float would change what
dividing it does. That is Decision 1 kept as `Specs/SL_NEXT.md` 5 A has it:
one spelling, and every hint a fix.

## For an editor

`classify(source)` is every token with its class (keyword, type, builtin,
input, prelude, number, hex, comment, punct, member, ident, or invalid), built
on the parser's own scanner and word lists, so the highlighting is the parser's.
It never throws, since it runs on every keystroke. It classifies by spelling,
not scope: a local named `circle` still reads as a builtin where it is used.

`SL_KEYWORDS` and `SL_TYPES` (`words.ts`) are the lists the parser reads, and a
name may be neither. `onejs-sl/tables` carries them with a one line description
of every builtin, input and prelude function; a prelude function's is the
comment above it in `prelude-source.ts`.

## See also

- `Specs/SL_TEXT.md`, the whole design, including the four decisions taken
- `../README.md`, the IR, the EDSL and the hash this lowers to
- `Specs/SHADER_LANG.md`, the backends
