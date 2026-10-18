# HyperFrames renderer contract

Labs. The HTML/timeline adapter and FFmpeg mock are implemented; real HyperFrames
execution is not verified for v2. The package is marked network:true to keep its
real entry disabled by the core until runtime/telemetry behavior is audited.
Use execution: mock only. The mock is synthetic FFmpeg output, not HyperFrames.

The real entry targets 0.8.24, requires explicitly selected existing CLI, GSAP and
browser paths (TSUGITE_HYPERFRAMES, TSUGITE_GSAP, TSUGITE_BROWSER), and performs no
npx, installation, upgrade, auth or cloud command. It requests DO_NOT_TRACK but
does not claim that flag proves every CLI version avoids external transmission.
The generated HTML references local media/scripts only. Real acceptance must
include network denial, audio and decoded-frame checks before default promotion.
