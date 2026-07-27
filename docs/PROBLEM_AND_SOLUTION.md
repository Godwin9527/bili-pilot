# Bilibili High-Bitrate Playback Outside Mainland China

## Summary

The observed problem was not insufficient local broadband. It was that a specific CDN path used for high-bitrate Bilibili DASH video could provide inadequate sustained throughput, leave a large Range request unanswered, or behave differently from another authorized CDN at a different position in the same media file.

Bili Pilot compares only the real signed CDN URLs Bilibili supplied for the active track. While the player has safe buffer headroom, it can compare upcoming real segments at low priority, download each complete segment from that segment's best route, and serve the exact bytes when the player later asks for them.

## What we observed

### A gigabit speed test does not measure the media route

The connection could reach roughly 1000 Mbps in a general speed test, but the player downloads from signed `.m4s` URLs returned by Bilibili playurl, not from the speed-test server.

On the sampled Hong Kong device, route, and test period, several real 4K, HDR, and 1080P60 videos showed:

- media traffic primarily using COSOV (`upos-*-mirrorcosov.bilivideo.com`) and Akamai (`*.akamaized.net`);
- sustained real-media Range throughput around 6.3–17.5 Mbps, far below the general speed-test result;
- a roughly 55-minute 4K file requiring about 9.8 Mbps on average while one Akamai sample delivered about 8.1 Mbps, causing buffer headroom to shrink;
- some 5–7 MB Ranges timing out on one route, then also timing out or taking several seconds before returning HTTP 206 on the other route.

These measurements describe one device, time, and network exit. They are not evidence that every viewer in Hong Kong or outside mainland China sees the same numbers. They do demonstrate that local access speed and the current path to a particular video CDN are different measurements.

### Default order is not current-route quality

Bilibili can return a base URL and backup URLs for one DASH representation. They are authorized candidates, but their list order does not guarantee which one is fastest for a particular viewer, byte position, or moment.

We also observed that:

- base and backup order can change after signed-URL refresh or retry;
- a CDN may be fast near the beginning of a file and time out later;
- adjacent future segments can perform better on different CDNs;
- the player often tries a backup only after the current request is already slow or failed, when visible buffer pressure has begun.

One trace captured the failure mechanism precisely. Bilibili's player requested a large byte Range, received most of it quickly, then stopped making useful progress near the tail. The same signed Range was retried with player timeouts of 5, 10, 13, and 16 seconds. A later retry returned HTTP 206 and completed, proving that the URL, signature, and Range syntax were valid. In that successful attempt, roughly 9.8 MB arrived in under half a second, while the final roughly 1.1 MB took about ten additional seconds.

This is an important distinction: a route can be reachable and eventually complete while still missing the player's playback deadline. "Works eventually" is not the same as "sustains the segment before buffer exhaustion."

The central issue is therefore timing and granularity: route recovery is often reactive and file-wide, while the failure is discovered on an individual Range only when playback needs it.

### A small speed probe is useful but not proof

A quick scan can identify an obviously unavailable route, but a fast 32 KB or 1.5 MB sample does not guarantee that a later 6 MB Range will complete. CDN cache state, connection reuse, file position, and transient routing all affect the result.

The project therefore treats scan rankings as diagnostics. Route rewriting, complete cache delivery, player buffer behavior, and real stall outcomes must be validated separately.

## The solution

### 1. Identify the track that is actually playing

The extension observes the initial `window.__playinfo__`, later playurl Fetch/XHR responses, real media requests, and the `<video>` element's decoded dimensions. This separates video from audio and avoids confusing 4K, HDR, or an inactive representation with the active track.

### 2. Preserve complete signed candidates

Bilibili and Akamai media URLs contain signatures and time-sensitive parameters. The extension stores the complete URLs supplied for one track and uses path, signature, and query parameters together. Replacing only a hostname could produce HTTP 403 or 416, an invalid signature, or the wrong media object.

### 3. Support manual and conservative automatic routing

A viewer can pin a candidate CDN. Automatic selection runs only when there is no manual preference, playback buffer is safe, and another route is both sufficient for the active bitrate and clearly ahead. It never aborts an in-flight request.

If a pinned route's real Range times out, that route enters a 15-second cooldown and the next request can temporarily try another candidate. If every candidate is cooling down, the extension allows Bilibili's original fallback behavior instead of rewriting an already failing request back to the same route.

The route plan also applies a pure risk classifier to signals such as MCDN hosts or query parameters, IP-literal hosts, non-standard ports, and known PCDN domains. This classification does not rewrite or reject a signed URL. Automatic work prefers ordinary official candidates, keeps risky candidates as last-resort fallbacks, and leaves manual selection unchanged. If every supplied candidate is classified as risky, the complete candidate list remains usable.

### 4. Locate real future segments through `sidx`

DASH `SegmentBase.indexRange` points to an `sidx` index. Parsing it yields the absolute byte Range and time location of each real media segment. This is more reliable than estimating an arbitrary byte location several minutes ahead because the resulting Ranges are the data the player will actually request.

### 5. Select a CDN independently for every future segment

When buffer is safe, the extension plans 3–8 segments beyond the player frontier. For each segment it:

1. sends bounded 32 KB low-priority Range probes to ordinary signed candidates first, probing PCDN/MCDN candidates only when all ordinary candidates fail;
2. ranks candidates for that segment by success, time to first byte, and throughput;
3. downloads the complete segment once from the winner;
4. walks every remaining ranked candidate if a complete download fails;
5. invalidates stale probe evidence and re-probes all candidates after bounded backoff if the full ranking is exhausted.

One future segment can therefore come from Akamai and the next from COSOV. Another environment may expose three or more candidates; the same list-based ranking and retry flow applies to every candidate. The evidence is attached to the segment, not assumed to remain valid for the whole video.

### 6. Intercept only a completely cached Range

The cache stores absolute byte Ranges. When a later Fetch/XHR request arrives:

- if one or more ready cached segments cover every requested byte, the extension assembles the exact body and returns HTTP 206;
- if coverage is partial, the extension does not intercept and the request proceeds normally.

This prevents truncated data from reaching Media Source Extensions and allows one player Range to be assembled from adjacent segments cached from different hosts. If the requested Range is still downloading, the player reuses that in-flight completion Promise instead of cancelling it and starting a duplicate transfer.

### 7. Give the player absolute priority

Pre-cache runs whenever Bilibili has already established at least 15 seconds of safe buffered headroom, independently of play, pause, readiness, `waiting`, or `stalled` state:

- 15–30 seconds of buffer: plan up to 3 segments;
- 30–60 seconds: plan up to 5 segments;
- at least 60 seconds: plan up to 8 segments.

Less than 15 seconds of buffer cancels unrelated background work. At or above that threshold, one low-priority pre-cache transfer may run even while Bilibili keeps another Range in flight; otherwise native long-running requests can starve pre-cache forever. Seeking cancels stale work because the future-segment frontier changes; ordinary pause, waiting, and stalled states only re-evaluate headroom. A task covering the requested Range is promoted and preserved.

The runtime also distinguishes request ownership and failure causes. A player XHR timeout, a network error, an HTTP error, and an extension-initiated cancellation are separate outcomes. Extension cancellations do not count as CDN failures. A cache lookup performed for a player request is not reported as a background prefetch attempt.

## Why this can improve playback

### It moves failure discovery earlier

Without pre-cache, the sequence is commonly: the player needs a segment, the current CDN is slow, buffer drains, and a backup is attempted late.

With the extension, safe buffer time is used to compare future segments, choose a route for each one, and download the complete bytes before the playback deadline. CDN uncertainty is handled while the viewer still has headroom.

### Segment-level evidence adapts to route variation

CDN performance changes with node cache, cross-border routing, connection state, and file position. One permanent winner for an entire video can become stale. Per-segment selection can use current evidence for each future request.

### A cache hit turns network variability into memory delivery

After a successful prefetch, the player does not wait for that segment's network round trip, first byte, and complete cross-border transfer. The ready Range can be returned from memory immediately, increasing the margin available for the next network fluctuation.

### Strict pass-through protects the original player

The extension takes over only when signed URL, track, Range, and complete byte coverage are known. Every uncertain case uses Bilibili's original request. Background work also yields whenever playback needs the network. The intended contract is: accelerate with verified complete data; otherwise preserve original behavior.

## Limits and evidence standard

- If Bilibili supplies only two candidates and neither can return data reliably, the extension cannot create a third authorized CDN.
- PCDN/MCDN classification is heuristic. It controls only automatic priority, so a misclassified signed route is still available for manual choice and fallback.
- A track without a readable `sidx` still supports manual route selection but not exact future-segment pre-cache.
- If the player stops using page-visible Fetch/XHR for DASH media, the current cache adapter will need to change.
- Quick and deep scans measure samples, not the final viewer outcome.
- Background pre-cache cannot repair a cold-start, seek, or already-empty-buffer stall if no complete future bytes were prepared beforehand. In that state it deliberately yields the network to the player.
- Bilibili can merge several indexed segments into one large Range. A long-tail pause near the end of that Range can still trigger repeated player timeouts even when the CDN eventually returns HTTP 206.
- Success must be demonstrated with controlled baseline-versus-enabled runs using the same video, quality, interval, and network conditions. Compare startup time, stall count, stall duration, buffer ahead, playhead progress, media-request failures, and complete cache hits across multiple videos.

## Product definition

Bili Pilot is not a general internet accelerator and does not bypass Bilibili authorization to discover arbitrary nodes. It is a playback-route scheduler and segment pre-cache layer over the CDN candidates already authorized for the active track. It provides transparent manual routing, uses safe buffer windows to prepare real future segments, selects a route per segment, delivers only complete bytes, and yields to the original player whenever it cannot prove that intervention is safe.
