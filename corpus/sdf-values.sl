// An anchor: a shape whose parameters are values (IR 3) has to measure what it
// measures with the same parameters written as constants. Each channel is 1
// wherever the two distances part by more than 1e-4, so the fixture is black.
uniform float4 box = float4(0.3, 0.2, 0.05, 0.1);
uniform float2 corners = float2(0.15, 0.02);
uniform float3 star = float3(0.35, 6, 3);

float4 main() {
    float2 p = (uv - 0.5) * 1.2;
    float r = step(1e-4, abs(sdf.roundedBox(p, box, corners) - sdf.roundedBox(p, 0.3, 0.2, 0.05, 0.1, 0.15, 0.02)));
    float g = step(1e-4, abs(sdf.star(p, star) - sdf.star(p, 0.35, 6, 3)));
    float b = step(1e-4, abs(sdf.circle(p, star.x) - sdf.circle(p, 0.35)));
    return float4(r, g, b, 1);
}
