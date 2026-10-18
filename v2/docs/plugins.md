# Plugin SDK

`tsugite plugin new ./my-plugin --id my-plugin` makes a standalone ESM package.
`npm test --prefix ./my-plugin` tests its zero-cost mock without Tsugite or a key.
`tsugite plugin add ./my-plugin` copies a reviewed local package into this project
and pins its entire content hash. It does not run npm, contact a registry or
execute package lifecycle scripts. A plugin may still execute arbitrary code
when planning/executing; inspect it before installation. Changes after installation
fail closed. Use a new ID/version to replace it in this alpha.

Each package needs name, version, license and `tsugite` metadata:

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "capabilities": ["source"],
  "network": false,
  "tier": "community",
  "entry": "index.mjs",
  "mock": "mock.mjs",
  "constraints": "constraints.md"
}
```

The default export implements `quote(task)` returning `{service, credits}` and
`make({task, output, sample, idempotencyKey})` returning `{credits}`. Output is a
regular project-local MP4 and is probed/hash-checked by the core. The sample
argument is the first local input, if present. Offline `renderer` implementations
provide `render({timeline, inputs, output, scratch})`. The timeline is versioned,
sequential, with format, total seconds and clips `{id,path,seconds,taskKey?}`.
Only the output paths assigned by the core should be written.

The `analysis` capability is reserved; automatic analysis hooks are not wired.
No runtime dependency installation is attempted; the standalone scaffold uses
only Node builtins. Bundled dependencies must remain within the plugin package
and obey its license. Manifest declarations are not proof of execution support.

All newly installed packages are labeled community or labs. This project does
not require an "official" namespace or vendor endorsement. Real-render evidence
and passing mock tests are required before expanding the default installed set.
Only the offline local renderer currently has v2 real-render test evidence.

## Other renderers and Remotion licensing

Remotion and HyperFrames have v1 integrations, but are not bundled or represented
as v2 verified plugins. Remotion is source-available under its own license.
Eligibility depends on entity/team headcount and use case, not only how many
people personally use the tool. A report of fewer than four Remotion users is
not enough to establish eligibility. Collaborating entities and contractors can
affect the count. Review the current license for your organization; automation
has additional Company License terms when the free-license exemption does not
apply. Free-license eligibility can also cover automation. Forking remains
subject to the original license; it does not remove these conditions.

Reviewed on 2026-10-18: [License FAQ](https://www.remotion.dev/docs/license/faq),
[license text](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md),
[terms](https://www.remotion.dev/docs/license/terms).
The default offline sample uses your local FFmpeg build instead. See its build
configuration and [FFmpeg licensing](https://ffmpeg.org/legal.html) before redistribution.
