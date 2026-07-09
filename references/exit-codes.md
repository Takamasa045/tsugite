# Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 10 | validation failed |
| 20 | transient external failure |
| 21 | rate limited |
| 30 | missing dependency |
| 40 | invalid request |
| 50 | gated execution blocked |

Adapters normalize external command results to this table before returning control to the pipeline.
