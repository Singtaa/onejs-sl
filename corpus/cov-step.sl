// floor, ceil, round, frac, sign and %. Every jump lands BETWEEN pixel centres
// at 96 px, so two backends a float ulp apart cannot land on opposite sides of
// one.
float4 main() {
    float2 q = (uv - 0.5) * 6.0;
    float b = (q.x % 0.5) + floor(q.y) * 0.1 + ceil(q.x) * 0.05 + round(q.y) * 0.03;
    float c = frac(uv.x * 4.0) + sign(q.x) * 0.2;
    return float4(clamp(b * 0.5 + 0.5, 0.0, 1.0), saturate(c * 0.5), 0.5, 1);
}
