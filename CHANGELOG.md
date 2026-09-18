
## 0.12.0
- fix(tools): nine read tools (`notemap_search` `recall` `labels` `fusion` `neighbors` `related` `paths` `common` `filter`) returned ARRAYS while the local `defineTool` shim defaulted an undeclared `output` to `type: object`, so the host rejected every call with `"value" must be an object` — the whole read surface of the graph was unreachable while the data stayed intact behind `notemap_export`. Each of the nine now declares its own output (`arrayOut` for record arrays, `stringArrayOut` for id/label arrays), and `findPaths` returns `[]` instead of `null` so the declared array shape always holds
- fix(labels): one shape for both modes — `searchLabels` returned bare strings while `popularLabels`
  returned `{title, degree}` records, and a schema can describe only one of them, so every non-empty
  `prefix` failed output validation (`"value[0]" must be an object`) while `popular` passed. Fixed at
  the source (both branches now return `{title, degree}`), not by widening `items` to hide it
- fix(labels): the no-argument call answers the degree ranking. It used to fall through to
  `searchLabels('')`, which returns [] by design — a confident "this graph knows nothing" on a
  4,919-node graph, with nothing in the result to say otherwise. The empty guard stays; the default
  moved, and it is a pure tested decision (`labelsPlan`), with `=== undefined` keeping "didn't ask"
  distinct from "asked for an empty string" (`{prefix: ''}` still returns [])
- fix(labels): the match is a SUBSTRING (`LIKE '%q%'`) and never was a prefix — the tool description
  and the parameter description now say so (the parameter NAME stays `prefix`, to avoid breaking callers)
- test: 23/23 (relations + verify suites); bundle captured through a fake ctx shows 27 tools —
  9 array schemas, 18 object, 0 undeclared

## 0.11.1
- fix: notemap_filter schema missing additionalProperties -> dsh-tools UNSUPPORTED_SCHEMA crash on plugin load
## 0.11.2
- feat: autoLinkSemantic — bigram-Jaccard auto-linking so BFS retrieval surfaces topically-related nodes (notemap_autolink tool)
- feat: importSessions now imports assistant/message events (type=assistant-event, own watermark)
- fix: filterNodes meta array values now match (json_each path-based); force bypasses event watermark; zstd CLI fallback to node:zlib
- test: 12/12 verify suite (P1 bitemporal, P2 dual-watermark import, P3 fusion/filter, P4 autolink)
