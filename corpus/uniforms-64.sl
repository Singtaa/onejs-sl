// An anchor: every one of the 64 uniform slots reaches the program with its
// default (slot i holds i + 1), so a host that binds fewer draws green where
// this draws red. Slots past 16 also widen the web frame's uniform block.

uniform float u0 = 1;
uniform float u1 = 2;
uniform float u2 = 3;
uniform float u3 = 4;
uniform float u4 = 5;
uniform float u5 = 6;
uniform float u6 = 7;
uniform float u7 = 8;
uniform float u8 = 9;
uniform float u9 = 10;
uniform float u10 = 11;
uniform float u11 = 12;
uniform float u12 = 13;
uniform float u13 = 14;
uniform float u14 = 15;
uniform float u15 = 16;
uniform float u16 = 17;
uniform float u17 = 18;
uniform float u18 = 19;
uniform float u19 = 20;
uniform float u20 = 21;
uniform float u21 = 22;
uniform float u22 = 23;
uniform float u23 = 24;
uniform float u24 = 25;
uniform float u25 = 26;
uniform float u26 = 27;
uniform float u27 = 28;
uniform float u28 = 29;
uniform float u29 = 30;
uniform float u30 = 31;
uniform float u31 = 32;
uniform float u32 = 33;
uniform float u33 = 34;
uniform float u34 = 35;
uniform float u35 = 36;
uniform float u36 = 37;
uniform float u37 = 38;
uniform float u38 = 39;
uniform float u39 = 40;
uniform float u40 = 41;
uniform float u41 = 42;
uniform float u42 = 43;
uniform float u43 = 44;
uniform float u44 = 45;
uniform float u45 = 46;
uniform float u46 = 47;
uniform float u47 = 48;
uniform float u48 = 49;
uniform float u49 = 50;
uniform float u50 = 51;
uniform float u51 = 52;
uniform float u52 = 53;
uniform float u53 = 54;
uniform float u54 = 55;
uniform float u55 = 56;
uniform float u56 = 57;
uniform float u57 = 58;
uniform float u58 = 59;
uniform float u59 = 60;
uniform float u60 = 61;
uniform float u61 = 62;
uniform float u62 = 63;
uniform float u63 = 64;
float4 main() {
    float off = abs(u0 - 1) + abs(u1 - 2) + abs(u2 - 3) + abs(u3 - 4) + abs(u4 - 5) + abs(u5 - 6)
        + abs(u6 - 7) + abs(u7 - 8) + abs(u8 - 9) + abs(u9 - 10) + abs(u10 - 11) + abs(u11 - 12)
        + abs(u12 - 13) + abs(u13 - 14) + abs(u14 - 15) + abs(u15 - 16) + abs(u16 - 17) + abs(u17 - 18)
        + abs(u18 - 19) + abs(u19 - 20) + abs(u20 - 21) + abs(u21 - 22) + abs(u22 - 23) + abs(u23 - 24)
        + abs(u24 - 25) + abs(u25 - 26) + abs(u26 - 27) + abs(u27 - 28) + abs(u28 - 29) + abs(u29 - 30)
        + abs(u30 - 31) + abs(u31 - 32) + abs(u32 - 33) + abs(u33 - 34) + abs(u34 - 35) + abs(u35 - 36)
        + abs(u36 - 37) + abs(u37 - 38) + abs(u38 - 39) + abs(u39 - 40) + abs(u40 - 41) + abs(u41 - 42)
        + abs(u42 - 43) + abs(u43 - 44) + abs(u44 - 45) + abs(u45 - 46) + abs(u46 - 47) + abs(u47 - 48)
        + abs(u48 - 49) + abs(u49 - 50) + abs(u50 - 51) + abs(u51 - 52) + abs(u52 - 53) + abs(u53 - 54)
        + abs(u54 - 55) + abs(u55 - 56) + abs(u56 - 57) + abs(u57 - 58) + abs(u58 - 59) + abs(u59 - 60)
        + abs(u60 - 61) + abs(u61 - 62) + abs(u62 - 63) + abs(u63 - 64);
    return float4(1, off > 0.5 ? 1 : 0, 0, 1);
}
