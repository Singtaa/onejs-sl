# Changelog

## 0.1.0

The shader language compiler as its own package, moved out of `onejs-unity` with its history and its tests. It behaves exactly as `onejs-unity` 0.5.15's `sl` did, at IR version 2 and VM wire version 2.

- Entry points `onejs-sl`, `/core`, `/tables`, `/limits`, `/vm`, `/emit/unity` and `/emit/web`
- `vmFit` says whether the VM runs a program, and why not, without encoding it
- `parseColor` is exported from `onejs-sl/core`
- The test suite also runs in QuickJS-ng and must match Node byte for byte
