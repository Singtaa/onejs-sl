// A Mandelbrot set whose iteration count is a uniform (Specs/SL_NEXT.md 3b):
// a real loop, capped at the Range's max, that leaves by break as each point escapes.
[Range(16, 256)] uniform float iterations = 96;
float4 main() {
    float2 c = (uv - float2(0.7, 0.5)) * float2(3, 2.4);
    float2 z = 0;
    int n = 0;
    for (int i = 0; i < int(iterations); i++) {
        if (dot(z, z) > 4) break;
        z = float2(z.x * z.x - z.y * z.y, 2 * z.x * z.y) + c;
        n++;
    }
    float t = float(n) / iterations;
    return float4(t, sqrt(t), t * t, 1);
}
