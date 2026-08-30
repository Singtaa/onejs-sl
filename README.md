# sl: write a per pixel program in TypeScript

Phase 1 of `Specs/SHADER_LANG.md`. The IR, the types, the EDSL and the hash.
Pure TypeScript, no GPU anywhere in it, which is why it lands before either
backend and why every promise below is covered by a unit test.

```ts
import { sl } from "onejs-unity/sl"

const plasma = sl.program(({ uv, time }) => {
    const p = uv.mul(8).add(time.mul(0.4))
    const v = sl.sin(p.x).add(sl.sin(p.y))
    return sl.vec4(v.mul(0.5).add(0.5), 0, 0, 1)
})
```

## The one idea

**One authoring surface, one IR, two backends.** Unity cannot compile a shader
at runtime in a player build, on any graphics API, so in the browser a program
has to become data that a fixed shader evaluates. Ejecting to a Unity project
does not change what the author wrote, it changes what is possible, because an
editor compiles shaders at build time.

So the same source is interpreted by a VM on play.onejs.com and compiled from
generated HLSL after an eject, with no edit in between. Neither backend exists
yet. This module is the contract they will share.

## Why an EDSL rather than a text language

A TypeScript EDSL inherits completion, type errors at the call site, jump to
definition, rename and the author's editor for free. Monaco in the Play editor
already has these types loaded.

It also gives common subexpression elimination for nothing, which is the most
valuable optimisation here, because **a `const` in the host language IS the
shared node**. `const p = uv.mul(8)` used three times is one node with three
references, and writing it out long hand three times costs exactly the same,
because nodes are interned as they are built.

A text syntax stays possible later and costs only a parser, since the parser
would emit this same IR.

## What is checked, and when

Everything an author can get wrong is refused **when the program is written**,
at module load, not at draw time:

| Mistake | What happens |
|---|---|
| `vec2` combined with a `vec3` | TypeScript error at the call site, and a runtime error behind it |
| `uv.z` on a two component value | "z is component 3 of a vec2, which has 2" |
| A program returning something other than a `vec4` | "a program must return a vec4. Wrap it: sl.vec4(value, 1)" |
| `vec4` given the wrong number of parts | "vec4 needs 4 components, got 3" |
| One uniform name at two widths | "declared as both a float and a vec4" |
| More than 15 textures | Names the limit and why it cannot be widened |
| A value borrowed from another program | "a value from another program cannot be used in this one" |

The texture ceiling is the fragment shader's sampler slots on the WebGL2
baseline, which is the one resource neither backend can widen.

## The hash is the fragile part

`Program.hash` is what will link a program to its compiled shader. If it differs
between the machine that generated the shader and the machine that runs it, the
runtime falls back to the VM and **nobody is told**: correct output, quietly
slow, no error. That is the worst failure this design can have.

So it is a Merkle hash over the graph reachable from the result, not a walk of
the node array. An earlier version hashed storage order, which meant hoisting a
shared subexpression into a `const` changed the hash without changing what the
program computed. Constants go through a fixed precision, so `0.1 + 0.2` and
`0.3` do not produce different shaders. It is eight lowercase hex characters
from FNV-1a, chosen so a C# implementation can produce the same string rather
than for any cryptographic reason.

## Control flow

There is none, deliberately. `sl.select`, `sl.step`, `sl.smoothstep` and
`sl.mix` cover branching without branching, and `sl.repeat(n, body, seed)`
unrolls at record time because `n` is a JavaScript number.

`repeat` is honest about being a macro rather than a loop. It covers fbm,
layered noise and small iterated distance fields, which is most of what 2D
shaders loop for. A data dependent loop is out of scope: the VM would need a
nested bounded loop with a dynamic trip count while codegen would handle it
fine, and the two backends agreeing is the property the whole design protects.

## See also

- `Specs/SHADER_LANG.md`, sections 3 and 4, and section 5.4 for the Phase 0
  measurements that decided the VM's shape
- `Tools/shader-vm-spike/`, the harness behind those numbers
- `../fx/`, the image pipeline this becomes a source and an operand for
