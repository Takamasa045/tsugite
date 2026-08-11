# Prompt skeleton catalogs (advisory)

**Scope:** prompt-guidance-only  
**execution_capability:** not-evaluated  

These catalogs document a preferred **block order** and acting notation for long-form multi-shot authoring. They are **not**:

- proof that an adapter, connection, or credit entitlement exists
- a reason to auto-approve Gates
- a silent rewrite of author IR

## When compile uses a skeleton

A model prompt profile may **opt in** with:

```yaml
prompt_skeleton:
  id: longform-story-v1
```

Only then does compile reorder/output sections for that profile. Profiles without `prompt_skeleton` keep their existing renderer output (H3 grammar or plain-prompt).

## Files

| path | role |
|---|---|
| `longform-story-v1.yaml` | Block order, positive constraints, acting checklist |

Model-specific FOV bands stay under `knowledge/video-models/<model>/` (advisory notes only).
