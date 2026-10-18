# Experimental compatibility components

These components are separated from the v2 core/default npm distribution. The
export tool creates independent local compatibility-source packages from the
recorded v1 commit, preserving the v1 checkout and its active productions:

```sh
node v2/scripts/export-labs.mjs /new/empty/tsugite-labs
```

The output is ready to review and initialize as a separate labs repository. This
command does not create a remote repository, install runtimes, authenticate,
execute providers/editors, change either generation's checks, or move/delete v1
files. Packages include constraints, a zero-cost inspection mock and content
inventory. The compatibility source keeps its original paths under `legacy/`.
Some modules require other v1 infrastructure; unresolved imports are reported,
not concealed. Source separation is not proof of v2 runtime compatibility.

| Component | Experimental scope |
|---|---|
| Tesseract, Editframe | Existing v1 renderer source and constraints; optional runtimes remain separately selected |
| Hypit | Existing authoring/production entry; not a v2 renderer |
| TopView, MiniMax | Existing provider/preflight experiments; no new live acceptance claim |
| Premiere, After Effects | External editing Skills/helpers; never a generation-check replacement |
| Canvas, Studio | Optional external authoring connections; no implicit backend or publication |
| 3D viewer | Existing optional viewer source; not a new desktop dependency |
| Character, Shitate | Existing character/snapshot integration; no external symlink references permitted |

Promotion requires a maintainer, actual runtime evidence and passing mock tests.
The names in this table are not executable capabilities. The package's v2
manifest advertises inspection only until a separately reviewed runtime adapter
implements the corresponding v2 contract. Existing v1 execution retains its v1
checks. Public relocation to a new `tsugite-labs` repository needs the author's
choice of destination/access; the authorized existing source release can carry
the reviewed source bundles without creating that repository.
