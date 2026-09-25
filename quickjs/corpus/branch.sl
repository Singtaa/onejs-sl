// A branch, a colour literal and a function that returns a vector.
uniform float4 tint = #ff8040;

float2 swirl(float2 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return float2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float4 main() {
    float2 q = swirl(uv - 0.5, time * 0.3);
    float v = 0.25;
    if (q.x > 0.1) { v = 0.75; } else { v = fbm(q * 3, 4); }
    return float4(tint.rgb * v, 1);
}
