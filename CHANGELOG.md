
## 0.12.0
- fix(tools): nine read tools (`notemap_search` `recall` `labels` `fusion` `neighbors` `related` `paths` `common` `filter`) returned ARRAYS while the local `defineTool` shim defaulted an undeclared `output` to `type: object`, so the host rejected every call with `"value" must be an object` — the whole read surface of the graph was unreachable while the data stayed intact behind `notemap_export`. Each of the nine now declares its own output (`arrayOut` for record arrays, `stringArrayOut` for id/label arrays), and `findPaths` returns `[]` instead of `null` so the declared array shape always holds
- test: 20/20 (relations + verify suites); bundle captured through a fake ctx shows 27 tools — 9 array schemas, 18 object, 0 undeclared

## 0.11.1
- fix: notemap_filter schema missing additionalProperties -> dsh-tools UNSUPPORTED_SCHEMA crash on plugin load
## 0.11.2
- feat: autoLinkSemantic — bigram-Jaccard auto-linking so BFS retrieval surfaces topically-related nodes (notemap_autolink tool)
- feat: importSessions now imports assistant/message events (type=assistant-event, own watermark)
- fix: filterNodes meta array values now match (json_each path-based); force bypasses event watermark; zstd CLI fallback to node:zlib
- test: 12/12 verify suite (P1 bitemporal, P2 dual-watermark import, P3 fusion/filter, P4 autolink)
