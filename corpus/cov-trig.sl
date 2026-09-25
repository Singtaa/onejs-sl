// Trigonometry over continuous inputs. exp, log, sqrt and atan2 are in
// exp.sl: together they need more than the VM's eight registers.
float4 main() {
    float2 q = (uv - 0.5) * 2.0;
    float a = sin(q.x * 5.0) * cos(q.y * 4.0) * 0.5 + 0.5;
    float b = tan(q.x * 0.6) * 0.3 + asin(q.y * 0.9) * 0.2 + acos(q.x * 0.9) * 0.1;
    return float4(a, saturate(b + 0.5), 0.5, 1);
}
