// frame and deltaTime as colours. Red counts frames in 256ths; green is
// deltaTime in 30ths of a second, 0 on the first frame and 1 after; blue is 1
// where time is the sum of the steps taken, which a host keeps by construction.
float4 main() {
    float summed = abs(time - float(frame) * deltaTime) < 0.0001 ? 1 : 0;
    return float4(float(frame) / 256.0, deltaTime * 30.0, summed, 1);
}
