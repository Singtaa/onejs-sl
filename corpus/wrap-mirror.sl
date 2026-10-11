// An anchor for [Wrap(Mirror)]: the goldens' texture over three tiles each way,
// every other tile flipped, so the middle tile is the image as it is and the
// tiles either side are its reflections.
[Wrap(Mirror)] texture2D t;
float4 main() { return tex2D(t, uv * 3 - 1); }
