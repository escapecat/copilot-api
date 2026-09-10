# gc2cc historical-image request budget

The maintained `gc2cc/stable` line starts at upstream `v2.3.3`, matching the
installed proxy. It does not take an unrelated upstream upgrade. Builds have
their own `-gc2cc.N` version and immutable GitHub release tarballs with SHA-256
digests; they never publish into the upstream npm namespace.

## Incident and contract

On 2026-09-10 the Mori-UX native session retained 50 user images. One new
screenshot raised that to 51. Copilot returned HTTP 400 for exceeding 50 images;
later text-only requests failed with the same retained images. The session had
14 compactions; the last replacement history still contained 44 user images.
Compaction and per-image byte-size placeholders therefore do not enforce the
image-count boundary. The model catalog's `max_prompt_images=1` also disagrees
with the observed accepted requests and is not used as this route's count limit.

The Copilot Responses service applies one deterministic, copy-on-write budget
before HTTP or WebSocket forwarding. It counts message images (including URL
and file-ID inputs) and custom/function tool-result images. Above 50, only the
oldest image blocks preceding the most recent user message become explicit
text omission markers. All current-turn inputs and tool results, original text,
item/call identities, encrypted context, and caller-owned history remain intact.
No image bytes or session files are deleted. Logging records only the omitted
count. This is not a general limit imposed on other providers or model routes.

If the current turn itself exceeds the limit, or no user boundary can be
established, the request fails locally with a specific 400 before opening an
upstream transport; it does not silently remove fresh evidence or retry execution.
Opaque server-side history and unsupported tool-output shapes cannot be rewritten
safely and remain outside this projection. Older images needed again must be
explicitly reattached; the model is told not to infer omitted image contents.

Tests protect 0/49/50/51 boundaries, text-only follow-up, current-turn overflow,
tool pairing, file IDs, non-mutation, deterministic replay, and the actual HTTP
request body. A new immutable package is required for each deployed change.
