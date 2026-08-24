
## 0.11.1
- fix: notemap_filter schema missing additionalProperties -> dsh-tools UNSUPPORTED_SCHEMA crash on plugin load
## 0.11.2
- feat: autoLinkSemantic — bigram-Jaccard auto-linking so BFS retrieval surfaces topically-related nodes (notemap_autolink tool)
- feat: importSessions now imports assistant/message events (type=assistant-event, own watermark)
- fix: filterNodes meta array values now match (json_each path-based); force bypasses event watermark; zstd CLI fallback to node:zlib
- test: 12/12 verify suite (P1 bitemporal, P2 dual-watermark import, P3 fusion/filter, P4 autolink)
