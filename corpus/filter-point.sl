// An anchor for [Filter(Point)] with [Wrap(Repeat)]: the texture's eight by
// eight texels as hard squares over two tiles, which the host binds linear and
// clamped. The bottom half reads through tex2Dlod at level 0, so the program's
// sampler reaches a sample at a level as well as a plain one.
[Filter(Point)] [Wrap(Repeat)] texture2D t;
float4 main() {
    float2 q = uv * 2 - 0.5;
    return uv.y > 0.5 ? tex2D(t, q) : tex2Dlod(t, q, 0);
}
