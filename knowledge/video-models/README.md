# Video prompt knowledge catalogs

These catalogs are read-only planning data. Their presence does not mean that a matching execution adapter, account, model entitlement, or credit balance exists.

Each `prompt-guide.yaml` records model aliases, T2V/I2V recipes, structured model limits, model-specific notes, official sources, verification dates, and a review deadline. Agents should use `bin/pipeline guides --json` for discovery and `bin/pipeline plan --config <project.yaml> --json` for request-specific guidance.

To use a catalog through a different execution route, declare it explicitly on the request:

```yaml
input_mode: image-to-video
prompt_guide:
  catalog: <catalog-id>
```

Guidance is advisory. It never rewrites a prompt and never authorizes `run` or `render`.
