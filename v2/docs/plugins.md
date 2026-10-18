# Plugin SDK

`tsugite plugin new ./my-plugin --id my-plugin` makes a standalone ESM package.
`npm test --prefix ./my-plugin` tests its zero-cost mock without Tsugite or a key.
`tsugite plugin add ./my-plugin` copies a reviewed local package into this project
and pins its package content hash (excluding installed node_modules). It does not run npm, contact a registry or
execute package lifecycle scripts. A plugin may still execute arbitrary code
when planning/executing; inspect it before installation. Changes after installation
fail closed. Use a new ID/version to replace it in this alpha.

`plugin add ./reviewed.tgz` accepts a bounded npm archive. `plugin add
npm:community-package@1.2.3` explicitly acquires that exact name/version using
your configured npm registry. Tags, Git sources and URLs are rejected. Acquisition
runs `npm pack --ignore-scripts` into a project-owned cache, checks the returned
package identity, and rejects traversal, symlinks, duplicate paths and unsupported
tar extensions before registration. No lifecycle scripts or dependency install
run. This does not make untrusted plugin code safe: planning may execute its
quote and validation functions. Network acquisition has only a mocked registry
test here; a real local npm-packed archive was installed successfully.
Portable project paths reject Windows devices, alternate streams, reserved
characters and trailing dots/spaces on every OS, as well as traversal/symlinks.

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
`make({task, output, sample, idempotencyKey, onSubmitted})` returning `{credits}`.
Output is a regular project-local MP4 or WAV and is probed/hash-checked by the core.
Call and await `onSubmitted({providerJobId})` before polling an asynchronous job;
the core persists its nonsecret job identity while retaining the reservation. The sample
argument is the first local input, if present. Offline `renderer` implementations
provide `render({timeline, inputs, audio, output, scratch})`. Optional `runtime()`
metadata is bound to the plan; the Remotion plugin records tested package versions
and existing-browser identity. Source/render calls receive cloned plan inputs. The timeline is versioned,
sequential, with format, total seconds and clips `{id,path,seconds,taskKey?}`.
Only the output paths assigned by the core should be written.

The `analysis` capability implements zero-credit `analyze({input,model,scratch})`.
Use `plugin analyze` for local Whisper or a Fast Edit proposal. Whisper requires
an existing model and CLI; its real transcript output is not yet verified here.
No runtime dependency installation is attempted; the standalone scaffold uses
only Node builtins. Its real and mock implementations copy the first input into
the assigned output; use a matching duration. Its generated test checks output
bytes and the missing-sample error, and the core suite checks actual media export.
Bundled dependencies must remain within the plugin package
and obey its license. Manifest declarations are not proof of execution support.

All newly installed packages are labeled community or labs. This project does
not require an "official" namespace or vendor endorsement. Real-render evidence
and passing mock tests are required before expanding the default installed set.
The local renderer and optional Remotion renderer have v2 real-render evidence
on this Mac. HyperFrames and the service sources have contract/mock evidence
only. They are not defaults. Use `execution: mock` explicitly for synthetic
service footage/audio and the unverified HyperFrames mock; the page labels it.

## Other renderers and Remotion licensing

The optional Remotion package has a local real-render fixture; HyperFrames has
an HTML adapter and mock with the real runtime still disabled in core. This
does not establish licensing eligibility. Remotion is source-available under its
own license.
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
