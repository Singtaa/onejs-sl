// + - * / pow, unary -, rcp, min, max and clamp over continuous inputs. The
// stepwise ops are in step.sl: together they need more than the VM's eight
// registers.
float4 main() {
    float2 q = (uv - 0.5) * 6.0;
    float a = pow(abs(q.x) * 0.3, 1.7) + rcp(abs(q.y) + 1.0) - (-q.x) * 0.1;
    float c = q.y / (abs(q.x) + 2.0) + abs(q.y) * 0.1;
    return float4(saturate(a * 0.3), clamp(c * 0.5 + 0.5, 0.0, 1.0), min(max(a * 0.2, 0.1), 0.9), 1);
}
